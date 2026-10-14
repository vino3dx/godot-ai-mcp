import fs from "node:fs";
import path from "node:path";
import { GodotMcpError } from "../errors.js";

export const RES_PREFIX = "res://";
export const USER_PREFIX = "user://";

const IS_WINDOWS = process.platform === "win32";

/**
 * 把路径限制在项目目录内。
 * 接受 `res://foo/bar`、项目相对路径 `foo/bar`、以及项目内的绝对路径;
 * 拒绝 `..` 穿越、符号链接/junction 逃逸、项目外绝对路径、`user://`、NUL。
 * Windows 下大小写与反斜杠均按同一路径处理。
 */
export class FileGuard {
  /** 规范化后的项目根(绝对路径)。 */
  readonly root: string;
  /** 项目根的 realpath(符号链接已解析;路径不存在时按最近存在的祖先解析)。 */
  readonly realRoot: string;

  constructor(projectRoot: string) {
    if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
      throw new GodotMcpError("INVALID_ARGUMENT", "FileGuard requires a non-empty project root path");
    }
    this.root = path.resolve(projectRoot);
    this.realRoot = realpathBestEffort(this.root);
  }

  /** `res://` / 相对 / 项目内绝对 → 规范化绝对路径。越界一律 INVALID_ARGUMENT。 */
  toAbsolute(input: string): string {
    if (typeof input !== "string" || input.trim() === "") {
      throw new GodotMcpError("INVALID_ARGUMENT", "path must be a non-empty string");
    }
    if (input.includes("\0")) {
      throw new GodotMcpError("INVALID_ARGUMENT", "path must not contain NUL", { path: input });
    }
    if (input.startsWith(USER_PREFIX)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `user:// is not inside a project and cannot be resolved: ${input}`, {
        path: input, root: this.root, reason: "user://",
      });
    }
    const raw = input.startsWith(RES_PREFIX) ? input.slice(RES_PREFIX.length) : input;
    const normalized = raw.replace(/\\/g, "/");
    const segments = normalized.split("/").filter((s) => s !== "" && s !== ".");
    if (segments.includes("..")) {
      throw new GodotMcpError("INVALID_ARGUMENT", `path must not contain "..": ${input}`, {
        path: input, root: this.root, reason: "traversal",
      });
    }
    const candidate = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(this.root, segments.join("/"));
    return this.assertInside(candidate, input);
  }

  /** 绝对路径 → `res://…`。项目外抛 INVALID_ARGUMENT。 */
  toRes(absPath: string): string {
    const resolved = this.assertInside(absPath);
    const rel = path.relative(this.root, resolved).split(path.sep).join("/");
    return rel === "" ? RES_PREFIX : RES_PREFIX + rel;
  }

  /** 路径(可不存在)是否在项目内;符号链接按真实路径判定。 */
  contains(absPath: string): boolean {
    return within(this.root, path.resolve(absPath));
  }

  /** 路径的真实路径(解析符号链接;junction/软链均按最终目标判定)。 */
  realPath(absPath: string): string {
    return realpathBestEffort(path.resolve(absPath));
  }

  /** 校验在项目内(含符号链接逃逸),返回规范化绝对路径。 */
  assertInside(absPath: string, original: string = absPath): string {
    const resolved = path.resolve(absPath);
    if (!within(this.root, resolved)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `path escapes the project root: ${original}`, {
        path: original, resolvedPath: resolved, root: this.root, reason: "outside-project",
      });
    }
    const real = realpathBestEffort(resolved);
    if (!within(this.realRoot, real)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `path escapes the project root through a link: ${original}`, {
        path: original, resolvedPath: resolved, realPath: real, root: this.root, reason: "symlink-escape",
      });
    }
    return resolved;
  }
}

/** rel === ""(自身)或落在 root 之下。Windows 下大小写不敏感。 */
export function within(root: string, target: string): boolean {
  const r = IS_WINDOWS ? root.toLowerCase() : root;
  const t = IS_WINDOWS ? target.toLowerCase() : target;
  const rel = path.relative(r, t);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** 解析真实路径;路径不存在时向上找到最近存在的祖先,再拼回剩余部分。 */
function realpathBestEffort(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}
