// RuntimeService:通过 Godot CLI 启动项目/运行场景/导出构建的封装。
//
// 职责边界(单向依赖):定位可执行文件(GodotCliService.locate)→ 解析项目根(ProjectResolver)
// → 纯函数拼参数(godot/runtime/run.ts)→ 在项目级互斥队列内 spawn(不污染本进程 stdout)。
// 错误一律 throw GodotMcpError,由 ToolHost 统一成错误信封。
import { GodotMcpError } from "../core/errors.js";
import { TaskQueue } from "../core/concurrency/taskQueue.js";
import { ProjectResolver } from "../core/project/projectResolver.js";
import type { GodotSource } from "../godot/cli.js";
import {
  buildExportArgs,
  buildRunArgs,
  defaultRunRunner,
  type GodotRunRunner,
  type RunProcessResult,
} from "../godot/runtime/run.js";
import type { GodotCliService } from "./godotCli.js";

/** 冷启动 + 首帧 + 退出,实测未测;取宽,由工具参数 timeoutMs 覆盖。 */
export const DEFAULT_RUN_TIMEOUT_MS = 30_000;

export interface RuntimeServiceOptions {
  godot: GodotCliService;
  project: ProjectResolver;
  runQueue: TaskQueue;
  /** 进程执行器(默认真实 spawn)。测试可注入替身。 */
  runner?: GodotRunRunner;
}

export interface RunProjectOptions {
  projectPath?: string;
  /** 要运行的场景;缺省用项目 main scene。 */
  scene?: string;
  headless?: boolean;
  quit?: boolean;
  timeoutMs?: number;
  waitTimeoutMs?: number;
  extraArgs?: readonly string[];
  /** 锁持有者标识(工具名),写进 utility_task_status 的持有者。 */
  tool: string;
}

export interface ExportProjectOptions {
  projectPath?: string;
  preset: string;
  mode?: "release" | "debug";
  /** 输出文件路径(必填,含二进制文件名)。 */
  outputPath: string;
  headless?: boolean;
  timeoutMs?: number;
  waitTimeoutMs?: number;
  extraArgs?: readonly string[];
  tool: string;
}

/** 返回给工具层的归一化运行结果。 */
export interface RuntimeRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  /** 展示用命令串(不用于执行)。 */
  command: string;
  resolvedPath: string;
  source: GodotSource;
  projectDir: string;
}

export class RuntimeService {
  constructor(private readonly opts: RuntimeServiceOptions) {}

  /** 运行项目(或指定场景),headless + --quit 默认开启,作为冒烟测试返回日志。 */
  async runProject(o: RunProjectOptions): Promise<RuntimeRunResult> {
    const { path: file, source } = this.locate();
    const projectDir = this.projectDir(o.projectPath);
    const args = buildRunArgs(projectDir, {
      headless: o.headless ?? true,
      quit: o.quit ?? true,
      scene: o.scene,
      extraArgs: o.extraArgs,
    });
    return this.execute(file, source, projectDir, args, {
      timeoutMs: o.timeoutMs,
      waitTimeoutMs: o.waitTimeoutMs,
      tool: o.tool,
      target: o.scene ?? projectDir,
    });
  }

  /** 用预设导出/构建(export_presets.cfg 里的 preset 名)。 */
  async exportProject(o: ExportProjectOptions): Promise<RuntimeRunResult> {
    const { path: file, source } = this.locate();
    const projectDir = this.projectDir(o.projectPath);
    const args = buildExportArgs(projectDir, {
      preset: o.preset,
      mode: o.mode ?? "release",
      outputPath: o.outputPath,
      headless: o.headless ?? true,
      extraArgs: o.extraArgs,
    });
    return this.execute(file, source, projectDir, args, {
      timeoutMs: o.timeoutMs,
      waitTimeoutMs: o.waitTimeoutMs,
      tool: o.tool,
      target: o.preset,
    });
  }

  private locate(): { path: string; source: GodotSource } {
    return this.opts.godot.locate();
  }

  private projectDir(projectPath?: string): string {
    return this.opts.project.resolve(projectPath);
  }

  private async execute(
    file: string,
    source: GodotSource,
    projectDir: string,
    args: string[],
    o: { timeoutMs?: number; waitTimeoutMs?: number; tool: string; target: string },
  ): Promise<RuntimeRunResult> {
    const timeoutMs = o.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const runner = this.opts.runner ?? defaultRunRunner;
    let res: RunProcessResult;
    try {
      res = await this.opts.runQueue.runExclusive(
        projectDir,
        { tool: o.tool, target: o.target },
        (signal) => runner(file, args, { timeoutMs, signal }),
        { ...(o.waitTimeoutMs !== undefined ? { waitTimeoutMs: o.waitTimeoutMs } : {}) },
      );
    } catch (e) {
      throw mapRunError(e, file);
    }
    const command = [file, ...args].join(" ");
    const logs = {
      stdout: res.stdout,
      stderr: res.stderr,
      stdoutTruncated: res.stdoutTruncated,
      stderrTruncated: res.stderrTruncated,
      durationMs: res.durationMs,
    };
    if (res.timedOut) {
      throw new GodotMcpError("TASK_TIMEOUT", `Godot did not exit within ${timeoutMs}ms and was killed`, {
        timeoutMs, resolvedPath: file, source, command, ...logs,
      });
    }
    if (res.exitCode !== null && res.exitCode !== 0) {
      throw new GodotMcpError("GODOT_PROCESS_FAILED", `Godot exited with code ${res.exitCode}`, {
        exitCode: res.exitCode, resolvedPath: file, source, command, ...logs,
      });
    }
    if (res.exitCode === null && res.signal !== null) {
      throw new GodotMcpError("GODOT_PROCESS_FAILED", `Godot was terminated by signal ${res.signal}`, {
        signal: res.signal, resolvedPath: file, source, command, ...logs,
      });
    }
    return { ...res, command, resolvedPath: file, source, projectDir };
  }
}

/** spawn 阶段的错误 → 统一错误码:ENOENT 归 GODOT_NOT_FOUND,其余归 GODOT_PROCESS_FAILED。 */
function mapRunError(e: unknown, file: string): never {
  if (e instanceof GodotMcpError) throw e; // 例如队列等待超时 LOCK_TIMEOUT,原样透传
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") {
    throw new GodotMcpError("GODOT_NOT_FOUND", `Godot executable disappeared before spawn: ${file}`, {
      resolvedPath: file, reason: "ENOENT",
    });
  }
  throw new GodotMcpError("GODOT_PROCESS_FAILED", `Failed to spawn Godot: ${file}`, {
    resolvedPath: file, reason: typeof err?.code === "string" ? err.code : String(e),
  });
}
