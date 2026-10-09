// Godot CLI 探测服务:tools 层唯一能触达 godot 层的入口(架构测试强制 tools 不直接 import godot)。
import { getGodotVersion, type GodotRunner, type GodotVersionInfo } from "../godot/cli.js";

export interface GodotCliServiceOptions {
  /** 环境变量来源(默认 process.env)。测试可注入。 */
  env?: NodeJS.ProcessEnv;
  /** 进程执行器(默认 promisified execFile)。测试可注入。 */
  runner?: GodotRunner;
}

export class GodotCliService {
  constructor(private readonly opts: GodotCliServiceOptions = {}) {}

  /** 定位 Godot 并执行一次 `--version`。失败抛 GodotMcpError(GODOT_NOT_FOUND / GODOT_PROCESS_FAILED)。 */
  getVersion(): Promise<GodotVersionInfo> {
    return getGodotVersion({ env: this.opts.env, runner: this.opts.runner });
  }
}
