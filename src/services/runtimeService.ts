// RuntimeService:通过 Godot CLI 启动项目/运行场景/导出构建的封装。
//
// 职责边界(单向依赖):定位可执行文件(GodotCliService.locate)→ 解析项目根(ProjectResolver)
// → 纯函数拼参数(godot/runtime/run.ts)→ 在项目级互斥队列内 spawn(不污染本进程 stdout)。
// 错误一律 throw GodotMcpError,由 ToolHost 统一成错误信封。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import {
  buildScreenshotArgs,
  DEFAULT_WAIT_FRAMES,
  isPng,
  parseRenderSize,
  readPngSize,
  SCREENSHOT_SCRIPT,
} from "../godot/runtime/screenshot.js";
import type { GodotCliService } from "./godotCli.js";

/** 冷启动 + 首帧 + 退出,实测未测;取宽,由工具参数 timeoutMs 覆盖。 */
export const DEFAULT_RUN_TIMEOUT_MS = 30_000;

/** 截图内联为 image 内容块的上限(1MB);超过只返回路径。 */
export const MAX_IMAGE_BYTES = 1024 * 1024;

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

export interface CaptureScreenshotOptions {
  projectPath?: string;
  /** 要截图的场景;缺省用项目 main scene(脚本读 application/run/main_scene)。 */
  scene?: string;
  /** 输出缩放宽;缺省不缩放(保持渲染分辨率)。与 outputHeight 需成对。 */
  outputWidth?: number;
  outputHeight?: number;
  /** 截图前等待渲染的帧数;缺省 DEFAULT_WAIT_FRAMES。 */
  waitFrames?: number;
  timeoutMs?: number;
  waitTimeoutMs?: number;
  /** 是否把 PNG 内联为 base64(文件 ≤1MB 时)。 */
  includeImage?: boolean;
  tool: string;
}

export interface CaptureScreenshotResult {
  /** 截图文件绝对路径(系统临时目录下 godot-ai-mcp/screenshots/)。 */
  filePath: string;
  /** 实际渲染尺寸(工程 viewport 设置,脚本经 stdout 回传)。 */
  renderSize: { width: number; height: number };
  /** 输出 PNG 尺寸(可能已被 outputWidth/outputHeight 缩放)。 */
  outputSize: { width: number; height: number };
  /** 文件字节数。 */
  fileSize: number;
  durationMs: number;
  command: string;
  resolvedPath: string;
  source: GodotSource;
  projectDir: string;
  /** includeImage=true 且文件 ≤1MB 时返回;否则 undefined。 */
  imageBase64?: string;
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

  /**
   * 截图指定场景(非 headless):写临时 GDScript → --script 运行 → 校验 PNG → 返回元数据。
   * 截图渲染分辨率由工程 viewport 设置决定;outputWidth/outputHeight 仅缩放输出图。
   */
  async captureScreenshot(o: CaptureScreenshotOptions): Promise<CaptureScreenshotResult> {
    const { path: file, source } = this.locate();
    const projectDir = this.projectDir(o.projectPath);
    const waitFrames = o.waitFrames ?? DEFAULT_WAIT_FRAMES;
    const scriptPath = path.join(os.tmpdir(), "godot-ai-mcp", `capture-${randomUUID()}.gd`);
    const screenshotDir = path.join(os.tmpdir(), "godot-ai-mcp", "screenshots");
    const outPath = path.join(screenshotDir, `shot-${randomUUID()}.png`);
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.mkdirSync(screenshotDir, { recursive: true });
    fs.writeFileSync(scriptPath, SCREENSHOT_SCRIPT, "utf8");
    const args = buildScreenshotArgs(projectDir, {
      scriptPath,
      outPath,
      scene: o.scene,
      waitFrames,
      outputWidth: o.outputWidth,
      outputHeight: o.outputHeight,
    });
    let res: RuntimeRunResult;
    try {
      res = await this.execute(file, source, projectDir, args, {
        timeoutMs: o.timeoutMs,
        waitTimeoutMs: o.waitTimeoutMs,
        tool: o.tool,
        target: o.scene ?? "screenshot",
      });
    } catch (e) {
      // 脚本对场景 load 失败显式 quit(2),映射为 FILE_NOT_FOUND(场景不存在)。
      if (e instanceof GodotMcpError && e.code === "GODOT_PROCESS_FAILED" && e.details?.["exitCode"] === 2) {
        throw new GodotMcpError("FILE_NOT_FOUND", `Scene not found: ${o.scene ?? "(main scene)"}`, {
          scene: o.scene ?? null,
          resolvedPath: e.details?.["resolvedPath"],
          stderr: e.details?.["stderr"],
        });
      }
      throw e;
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(outPath);
    } catch {
      throw new GodotMcpError(
        "RUNTIME_FAILED",
        "Godot exited successfully but no screenshot file was created",
        { filePath: outPath, stdout: res.stdout, stderr: res.stderr },
      );
    }
    if (!isPng(buf)) {
      throw new GodotMcpError("RUNTIME_FAILED", "Screenshot file is not a valid PNG", {
        filePath: outPath, fileSize: buf.length, stdout: res.stdout, stderr: res.stderr,
      });
    }
    const outputSize = readPngSize(buf);
    // 渲染尺寸以脚本回传为准;未回传时回退为输出尺寸(未缩放时两者本就相等)。
    const renderSize = parseRenderSize(res.stdout) ?? outputSize;
    const result: CaptureScreenshotResult = {
      filePath: outPath,
      renderSize,
      outputSize,
      fileSize: buf.length,
      durationMs: res.durationMs,
      command: res.command,
      resolvedPath: res.resolvedPath,
      source: res.source,
      projectDir: res.projectDir,
    };
    if (o.includeImage && buf.length <= MAX_IMAGE_BYTES) {
      result.imageBase64 = buf.toString("base64");
    }
    return result;
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
