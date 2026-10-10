// FileService:tools 层访问项目文件的最小入口(架构测试强制 tools 只能经 Service 访问底层)。
// 读:FileGuard 把 res:// 限在项目内 + 同步读 UTF-8 文本 + sha256。
// 写:复用 core/filesystem/safeWrite(原子写、LF、dryRun、expectedHash 乐观并发)。
import fs from "node:fs";
import { GodotMcpError } from "../core/errors.js";
import { FileGuard } from "../core/filesystem/fileGuard.js";
import { safeWriteFile, sha256Hex, type WriteOutcome } from "../core/filesystem/safeWrite.js";
import { ProjectResolver } from "../core/project/projectResolver.js";

export interface ReadResult {
  /** 项目内规范化绝对路径 */
  absPath: string;
  /** res:// 形式 */
  resPath: string;
  /** 文件原文(UTF-8) */
  text: string;
  /** 磁盘原字节的 sha256(hex),可直接作为 expectedHash 回传 */
  hash: string;
}

export interface EditOptions {
  dryRun?: boolean;
  /** 调用方认为的当前内容 sha256;缺省时退化为"本服务刚读到的 hash"(仍防并发改写) */
  expectedHash?: string;
}

export interface EditResult extends WriteOutcome {
  resPath: string;
}

export class FileService {
  constructor(private readonly resolver: ProjectResolver) {}

  private guard(projectPath?: string): FileGuard {
    return new FileGuard(this.resolver.resolve(projectPath));
  }

  /** 读项目内文件(按 res:// 定位)。不存在抛 FILE_NOT_FOUND。 */
  read(projectPath: string | undefined, resPath: string): ReadResult {
    const guard = this.guard(projectPath);
    const absPath = guard.toAbsolute(resPath);
    let text: string;
    try {
      text = fs.readFileSync(absPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GodotMcpError("FILE_NOT_FOUND", `文件不存在: ${resPath}`, { path: absPath, resPath });
      }
      throw e;
    }
    return { absPath, resPath: guard.toRes(absPath), text, hash: sha256Hex(text) };
  }

  /** 读 → 就地变换 → 原子写回。edit 返回相同文本时自动跳过写盘(changed=false)。 */
  async editText(
    projectPath: string | undefined,
    resPath: string,
    edit: (text: string) => string,
    opts: EditOptions = {},
  ): Promise<EditResult> {
    const read = this.read(projectPath, resPath);
    const next = edit(read.text);
    const outcome = await safeWriteFile(read.absPath, next, {
      dryRun: opts.dryRun,
      expectedHash: opts.expectedHash ?? read.hash,
    });
    return { ...outcome, resPath: read.resPath };
  }
}
