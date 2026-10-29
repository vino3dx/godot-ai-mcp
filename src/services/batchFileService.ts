import fs from "node:fs";
import path from "node:path";
import { GodotMcpError } from "../core/errors.js";
import { LockManager } from "../core/concurrency/lockManager.js";
import { safeWriteFile, sha256Hex, type SafeWriteOptions, type WriteOutcome } from "../core/filesystem/safeWrite.js";
import { FileService } from "./fileService.js";

export interface BatchChange { path: string; content: string; expectedHash?: string }
export interface BatchFileStatus { path: string; status: "ready" | "unchanged" | "written" | "restored" | "restore_failed" | "skipped"; changed?: boolean; diff?: string; newHash?: string; error?: string }
export interface BatchPreview { mode: "preview"; committed: false; files: BatchFileStatus[]; valid: boolean }
export interface BatchCommit { mode: "commit"; committed: boolean; recovered: boolean; recoveryComplete: boolean; files: BatchFileStatus[]; warning: string }

interface Prepared { input: BatchChange; absPath: string; resPath: string; original: Buffer; outcome: WriteOutcome }
export type BatchWriter = (absPath: string, content: string, opts?: SafeWriteOptions) => Promise<WriteOutcome>;

export class BatchFileService {
  constructor(private readonly file: FileService, private readonly locks: LockManager, private readonly writer: BatchWriter = safeWriteFile) {}

  async apply(projectPath: string | undefined, changes: BatchChange[], mode: "preview" | "commit", tool: string): Promise<BatchPreview | BatchCommit> {
    const duplicate = new Set<string>();
    const files: BatchFileStatus[] = [];
    const prepared: Prepared[] = [];
    for (const c of changes) {
      const read = this.file.read(projectPath, c.path);
      if (duplicate.has(read.absPath.toLowerCase())) throw new GodotMcpError("INVALID_ARGUMENT", `重复的批量目标路径: ${c.path}`, { path: c.path });
      duplicate.add(read.absPath.toLowerCase());
      const outcome = await this.writer(read.absPath, c.content, { dryRun: true, expectedHash: c.expectedHash ?? read.hash });
      prepared.push({ input: c, absPath: read.absPath, resPath: read.resPath, original: Buffer.from(read.text, "utf8"), outcome });
      files.push({ path: read.resPath, status: outcome.changed ? "ready" : "unchanged", changed: outcome.changed, diff: outcome.diff, newHash: outcome.newHash });
    }
    if (mode === "preview") return { mode, committed: false, files, valid: true };

    const keys = prepared.map((p) => p.absPath);
    return this.locks.withLocks(keys, { tool, target: projectPath ?? "project" }, async () => {
      // Re-check while holding every lock: the preview may have become stale.
      for (const p of prepared) await this.writer(p.absPath, p.input.content, { dryRun: true, expectedHash: p.input.expectedHash ?? sha256Hex(p.original) });
      const written: Prepared[] = [];
      try {
        for (const p of prepared) {
          const outcome = await this.writer(p.absPath, p.input.content, { expectedHash: p.input.expectedHash ?? sha256Hex(p.original) });
          const row = files.find((f) => f.path === p.resPath)!;
          row.status = outcome.changed ? "written" : "unchanged"; row.changed = outcome.changed; row.newHash = outcome.newHash; written.push(p);
        }
        return { mode, committed: true, recovered: false, recoveryComplete: true, files, warning: "多文件提交使用逐文件原子写入，不具备文件系统级原子性。" };
      } catch (e) {
        let recovered = true;
        for (const p of written.reverse()) {
          try {
            const current = fs.readFileSync(p.absPath);
            await this.writer(p.absPath, p.original.toString("utf8"), { expectedHash: sha256Hex(current) });
            const row = files.find((f) => f.path === p.resPath)!; row.status = "restored";
          } catch (restoreError) {
            recovered = false;
            const row = files.find((f) => f.path === p.input.path || f.path.endsWith(p.input.path.replace(/^res:\/\//, "")));
            if (row) { row.status = "restore_failed"; row.error = restoreError instanceof Error ? restoreError.message : String(restoreError); }
          }
        }
        for (const row of files.filter((f) => f.status === "ready")) row.status = "skipped";
        return { mode, committed: false, recovered, recoveryComplete: recovered, files, warning: `多文件提交失败，已尝试恢复；此操作不具备文件系统级原子性。原始错误: ${e instanceof Error ? e.message : String(e)}` };
      }
    });
  }
}
