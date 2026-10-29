import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export interface ProcessAdapterOptions { cwd?: string; env?: NodeJS.ProcessEnv }
export interface ProcessExit { exitCode: number | null; signal: NodeJS.Signals | null }
export interface ProcessAdapterHandle {
  readonly pid: number | undefined;
  /** Resolves only after the OS emits spawn; rejects for pre-spawn errors. */
  readonly spawned: Promise<void>;
  readonly exited: Promise<ProcessExit>;
  onStdout(listener: (chunk: Buffer) => void): () => void;
  onStderr(listener: (chunk: Buffer) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  stop(signal?: NodeJS.Signals): Promise<boolean>;
}
export type SpawnProcess = (file: string, args: readonly string[], options: ProcessAdapterOptions) => ChildProcess;

/** Owns one spawned child and exposes only stream, exit, PID and stop capabilities. */
export class ProcessAdapter {
  constructor(private readonly spawnProcess: SpawnProcess = defaultSpawn) {}

  start(file: string, args: readonly string[], options: ProcessAdapterOptions = {}): ProcessAdapterHandle {
    let child: ChildProcess;
    try { child = this.spawnProcess(file, args, options); }
    catch (error) { throw error; }

    const stdoutListeners = new Set<(chunk: Buffer) => void>();
    const stderrListeners = new Set<(chunk: Buffer) => void>();
    const errorListeners = new Set<(error: Error) => void>();
    let startupError: Error | undefined;
    const onData = (stream: Readable | null, listeners: Set<(chunk: Buffer) => void>): void => {
      if (!stream) return;
      stream.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (const listener of [...listeners]) listener(data);
      });
    };
    onData(child.stdout, stdoutListeners);
    onData(child.stderr, stderrListeners);

    let exited = false;
    let spawnSettled = false;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => { spawnSettled = true; resolve(); });
      child.once("error", (error) => { if (!spawnSettled) { spawnSettled = true; reject(error); } });
    });
    const exit = new Promise<ProcessExit>((resolve) => {
      child.once("close", (exitCode, signal) => {
        exited = true;
        stdoutListeners.clear(); stderrListeners.clear(); errorListeners.clear();
        resolve({ exitCode, signal });
      });
    });
    child.on("error", (error) => { startupError = error; for (const listener of [...errorListeners]) listener(error); });

    return {
      get pid() { return child.pid; },
      spawned,
      exited: exit,
      onStdout: (listener) => subscribe(stdoutListeners, listener, exited),
      onStderr: (listener) => subscribe(stderrListeners, listener, exited),
      onError: (listener) => { if (startupError) { listener(startupError); return () => {}; } return subscribe(errorListeners, listener, exited); },
      stop: (signal = "SIGTERM") => Promise.resolve(exited ? false : child.kill(signal)),
    };
  }
}

function defaultSpawn(file: string, args: readonly string[], options: ProcessAdapterOptions): ChildProcess {
  return spawn(file, [...args], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

function subscribe<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void, exited: boolean): () => void {
  if (exited) return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}
