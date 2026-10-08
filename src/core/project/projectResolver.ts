import fs from "node:fs";
import path from "node:path";
import { GodotMcpError } from "../errors.js";

/** Godot 用它识别项目根。 */
export const PROJECT_MARKER = "project.godot";

export interface ProjectResolverOptions {
  /** 解析相对 projectPath 的基准目录(默认 process.cwd())。 */
  cwd?: string;
  /** 环境变量来源(默认 process.env)。测试可注入。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 确定 Godot 项目根,优先级:
 *   工具参数 projectPath > 环境变量 GODOT_PROJECT_PATH > 从 cwd 向上查找 project.godot
 * 找不到抛 PROJECT_NOT_FOUND。返回规范化绝对路径。
 */
export class ProjectResolver {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: ProjectResolverOptions = {}) {
    this.cwd = path.resolve(opts.cwd ?? process.cwd());
    this.env = opts.env ?? process.env;
  }

  /** 找不到时抛 PROJECT_NOT_FOUND。 */
  resolve(projectPath?: string): string {
    const dir = this.tryResolve(projectPath);
    if (dir) return dir;
    const explicit = projectPath ?? this.env["GODOT_PROJECT_PATH"];
    throw new GodotMcpError(
      "PROJECT_NOT_FOUND",
      explicit
        ? `Not a Godot project (no ${PROJECT_MARKER}): ${path.resolve(this.cwd, explicit)}`
        : `No Godot project found: ${PROJECT_MARKER} is missing from ${this.cwd} and all its parents, and GODOT_PROJECT_PATH is not set`,
      {
        projectPath: projectPath ?? null,
        godotProjectPath: this.env["GODOT_PROJECT_PATH"] ?? null,
        cwd: this.cwd,
        marker: PROJECT_MARKER,
        searched: ancestors(this.cwd),
      },
    );
  }

  /** 不抛错版本:找到返回规范化绝对路径,否则 undefined。 */
  tryResolve(projectPath?: string): string | undefined {
    const explicit = projectPath ?? this.env["GODOT_PROJECT_PATH"];
    if (explicit !== undefined && explicit !== "") {
      const abs = path.resolve(this.cwd, explicit);
      return isProjectRoot(abs) ? abs : undefined;
    }
    for (const dir of ancestors(this.cwd)) if (isProjectRoot(dir)) return dir;
    return undefined;
  }
}

function isProjectRoot(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, PROJECT_MARKER)).isFile();
  } catch {
    return false;
  }
}

/** [from, from 的父目录, …, 文件系统根]。 */
function ancestors(from: string): string[] {
  const out: string[] = [];
  let cur = from;
  for (;;) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) return out;
    cur = parent;
  }
}
