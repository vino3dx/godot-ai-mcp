import { randomUUID } from "node:crypto";
import { GodotMcpError } from "../core/errors.js";
import { normalizeLockKey } from "../core/concurrency/lockManager.js";
import { BoundedLogBuffer, type LogReadResult, type LogStream } from "../godot/runtime/boundedLogBuffer.js";
import { ProcessAdapter, type ProcessAdapterHandle, type ProcessAdapterOptions, type ProcessExit } from "../godot/runtime/processAdapter.js";

export type RuntimeSessionState = "starting" | "running" | "stopping" | "exited" | "failed" | "timed_out";
export type RuntimeLogStream = LogStream | "both";

export interface RuntimeSessionOptions {
  projectRoot: string;
  executable: string;
  args: readonly string[];
  scene?: string;
  maxLifetimeMs?: number;
  stopTimeoutMs?: number;
  logMaxBytesPerStream?: number;
  now?: () => number;
}
export interface RuntimeSessionManagerOptions {
  adapter?: ProcessAdapterLike;
  maxActiveSessions?: number;
  retainedSessionTtlMs?: number;
  now?: () => number;
}
export interface ProcessAdapterLike { start(file: string, args: readonly string[], options?: ProcessAdapterOptions): ProcessAdapterHandle }
export interface RuntimeSessionSnapshot {
  sessionId: string; projectRoot: string; scene?: string; state: RuntimeSessionState;
  createdAt: number; startedAt?: number; endedAt?: number; updatedAt: number;
  pid?: number; exitCode?: number | null; signal?: NodeJS.Signals | null;
  errorCode?: string; errorMessage?: string; timedOut: boolean; timeoutReason?: string;
}
export interface RuntimeLogReadResult { stdout?: LogReadResult; stderr?: LogReadResult; state: RuntimeSessionState }
export interface RuntimeStopResult { stopped: boolean; timedOut: boolean; state: RuntimeSessionState; sessionId: string }

interface SessionRecord extends RuntimeSessionSnapshot {
  handle: ProcessAdapterHandle; logs: BoundedLogBuffer; lifetimeTimer?: ReturnType<typeof setTimeout>; retentionTimer?: ReturnType<typeof setTimeout>;
  exitPromise: Promise<ProcessExit>; exited: boolean;
}

const ACTIVE_STATES = new Set<RuntimeSessionState>(["starting", "running", "stopping"]);

/** Owns persistent processes without taking the project's short-run TaskQueue lock. */
export class RuntimeSessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly activeByProject = new Map<string, string>();
  private readonly adapter: ProcessAdapterLike;
  private readonly maxActiveSessions: number;
  private readonly retainedSessionTtlMs: number;
  private readonly defaultNow: () => number;
  private disposed = false;

  constructor(options: RuntimeSessionManagerOptions = {}) {
    this.adapter = options.adapter ?? new ProcessAdapter();
    this.maxActiveSessions = positiveInt(options.maxActiveSessions ?? 8, "maxActiveSessions");
    this.retainedSessionTtlMs = nonNegativeInt(options.retainedSessionTtlMs ?? 5 * 60_000, "retainedSessionTtlMs");
    this.defaultNow = options.now ?? Date.now;
  }

  async start(options: RuntimeSessionOptions): Promise<RuntimeSessionSnapshot> {
    if (this.disposed) throw new GodotMcpError("INVALID_ARGUMENT", "运行会话管理器已销毁");
    const now = options.now ?? this.defaultNow;
    const projectRoot = normalizeLockKey(options.projectRoot);
    this.cleanupExpired(now());
    if (this.activeByProject.has(projectRoot)) throw new GodotMcpError("INVALID_ARGUMENT", "该项目已有活动运行会话", { projectRoot, sessionId: this.activeByProject.get(projectRoot) });
    if (this.activeCount() >= this.maxActiveSessions) throw new GodotMcpError("INVALID_ARGUMENT", "已达到活动运行会话上限", { maxActiveSessions: this.maxActiveSessions });
    const sessionId = randomUUID();
    const record = {} as SessionRecord;
    const handle = this.adapter.start(options.executable, options.args, { cwd: projectRoot });
    record.sessionId = sessionId; record.projectRoot = projectRoot; record.scene = options.scene;
    record.state = "starting"; record.createdAt = now(); record.updatedAt = record.createdAt; record.timedOut = false;
    record.handle = handle; record.logs = new BoundedLogBuffer(options.logMaxBytesPerStream); record.exited = false;
    record.exitPromise = handle.exited;
    this.sessions.set(sessionId, record); this.activeByProject.set(projectRoot, sessionId);
    handle.onStdout((chunk) => record.logs.append("stdout", chunk));
    handle.onStderr((chunk) => record.logs.append("stderr", chunk));
    handle.onError((error) => { if (!record.exited) this.fail(record, "GODOT_PROCESS_FAILED", error.message); });
    void record.exitPromise.then((exit) => this.onExit(record, exit));
    try {
      await handle.spawned;
      if (record.state === "starting" && !record.exited) { record.state = "running"; record.startedAt = now(); this.touch(record, now); }
    } catch (error) {
      this.fail(record, "GODOT_NOT_FOUND", error instanceof Error ? error.message : String(error));
      await record.exitPromise;
    }
    if (record.state === "running" && options.maxLifetimeMs !== undefined) {
      const lifetime = positiveInt(options.maxLifetimeMs, "maxLifetimeMs");
      record.lifetimeTimer = setTimeout(() => this.timeout(record, now), lifetime);
    }
    return this.snapshot(record);
  }

  get(sessionId: string): RuntimeSessionSnapshot { return this.snapshot(this.require(sessionId)); }

  readLogs(sessionId: string, stream: RuntimeLogStream, offsets: { stdout?: number; stderr?: number } = {}, maxBytes?: number): RuntimeLogReadResult {
    const record = this.require(sessionId);
    if (stream !== "stdout" && stream !== "stderr" && stream !== "both") throw new GodotMcpError("INVALID_ARGUMENT", `未知日志流: ${stream}`, { stream });
    return { state: record.state, ...(stream === "stdout" || stream === "both" ? { stdout: record.logs.read("stdout", offsets.stdout ?? 0, maxBytes) } : {}), ...(stream === "stderr" || stream === "both" ? { stderr: record.logs.read("stderr", offsets.stderr ?? 0, maxBytes) } : {}) };
  }

  async stop(sessionId: string, timeoutMs = 1_000): Promise<RuntimeStopResult> {
    const record = this.require(sessionId);
    if (record.state === "exited" || record.state === "failed" || record.state === "timed_out") return { stopped: false, timedOut: false, state: record.state, sessionId };
    if (record.state === "running" || record.state === "starting") { record.state = "stopping"; record.errorCode = undefined; record.errorMessage = undefined; record.updatedAt = this.defaultNow(); }
    await record.handle.stop("SIGTERM");
    const completed = await Promise.race([record.exitPromise.then(() => true), delay(nonNegativeInt(timeoutMs, "timeoutMs")).then(() => false)]);
    return { stopped: completed, timedOut: !completed, state: record.state, sessionId };
  }

  cleanup(now = this.defaultNow()): void { this.cleanupExpired(now); }

  dispose(): void {
    this.disposed = true;
    for (const record of this.sessions.values()) { if (record.lifetimeTimer) clearTimeout(record.lifetimeTimer); if (record.retentionTimer) clearTimeout(record.retentionTimer); }
    this.sessions.clear(); this.activeByProject.clear();
  }

  private onExit(record: SessionRecord, exit: ProcessExit): void {
    if (this.disposed) return;
    if (record.exited) return;
    record.exited = true; record.exitCode = exit.exitCode; record.signal = exit.signal; record.endedAt = this.defaultNow(); record.updatedAt = record.endedAt;
    if (record.lifetimeTimer) { clearTimeout(record.lifetimeTimer); record.lifetimeTimer = undefined; }
    if (record.state === "timed_out") record.timeoutReason ??= "maximum session lifetime exceeded";
    else if (record.state !== "failed") record.state = "exited";
    this.activeByProject.delete(record.projectRoot);
    record.retentionTimer = setTimeout(() => this.deleteIfEnded(record), this.retainedSessionTtlMs);
  }
  private timeout(record: SessionRecord, now: () => number): void {
    if (!ACTIVE_STATES.has(record.state)) return;
    record.state = "timed_out"; record.timedOut = true; record.timeoutReason = "maximum session lifetime exceeded"; record.errorCode = "TASK_TIMEOUT"; record.errorMessage = record.timeoutReason; record.updatedAt = now();
    this.activeByProject.delete(record.projectRoot); void record.handle.stop("SIGKILL");
  }
  private fail(record: SessionRecord, code: string, message: string): void {
    if (record.exited || record.state === "timed_out") return;
    record.state = "failed"; record.errorCode = code; record.errorMessage = message; record.updatedAt = this.defaultNow(); this.activeByProject.delete(record.projectRoot);
  }
  private deleteIfEnded(record: SessionRecord): void { if (!ACTIVE_STATES.has(record.state)) this.sessions.delete(record.sessionId); }
  private cleanupExpired(now: number): void { for (const record of this.sessions.values()) if (record.endedAt !== undefined && now - record.endedAt >= this.retainedSessionTtlMs) this.deleteIfEnded(record); }
  private activeCount(): number { let count = 0; for (const record of this.sessions.values()) if (ACTIVE_STATES.has(record.state)) count++; return count; }
  private require(id: string): SessionRecord { const record = this.sessions.get(id); if (!record) throw new GodotMcpError("INVALID_ARGUMENT", `未知运行会话: ${id}`, { sessionId: id }); return record; }
  private snapshot(record: SessionRecord): RuntimeSessionSnapshot { const { handle: _handle, logs: _logs, exitPromise: _exitPromise, lifetimeTimer: _lt, retentionTimer: _rt, exited: _exited, ...publicRecord } = record; return { ...publicRecord }; }
  private touch(record: SessionRecord, now: () => number): void { record.updatedAt = now(); }
}

function positiveInt(value: number, name: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new GodotMcpError("INVALID_ARGUMENT", `${name} 必须是正整数`, { name, value }); return value; }
function nonNegativeInt(value: number, name: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new GodotMcpError("INVALID_ARGUMENT", `${name} 必须是非负整数`, { name, value }); return value; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
