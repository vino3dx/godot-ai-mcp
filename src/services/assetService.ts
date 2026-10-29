import fs from "node:fs";
import path from "node:path";
import { ProjectResolver } from "../core/project/projectResolver.js";
import { GodotMcpError } from "../core/errors.js";

export interface AssetInfo { path: string; extension: string; kind: string; sizeBytes: number; width?: number; height?: number; imported: boolean }

export class AssetService {
  constructor(private readonly resolver: ProjectResolver) {}

  list(projectPath?: string, kind?: string): AssetInfo[] {
    const root = this.resolver.resolve(projectPath);
    const out: AssetInfo[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".godot" || entry.name === ".git") continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(abs); continue; }
        const info = this.info(root, abs);
        if (info && (!kind || info.kind === kind)) out.push(info);
      }
    };
    walk(root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  getInfo(projectPath: string | undefined, resPath: string): AssetInfo {
    const root = this.resolver.resolve(projectPath);
    const abs = path.resolve(root, resPath.replace(/^res:\/\//, ""));
    if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) throw new GodotMcpError("INVALID_ARGUMENT", `资源路径越界: ${resPath}`, { resPath });
    const info = this.info(root, abs);
    if (!info) throw new GodotMcpError("FILE_NOT_FOUND", `资源不存在或类型不支持: ${resPath}`, { resPath });
    return info;
  }

  private info(root: string, abs: string): AssetInfo | undefined {
    const ext = path.extname(abs).toLowerCase();
    const kind = ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".svg" ? "texture"
      : ext === ".ttf" || ext === ".otf" ? "font" : ext === ".tscn" ? "scene" : ext === ".tres" ? "resource" : undefined;
    if (!kind) return undefined;
    const stat = fs.statSync(abs);
    const result: AssetInfo = { path: `res://${path.relative(root, abs).replace(/\\/g, "/")}`, extension: ext, kind, sizeBytes: stat.size, imported: fs.existsSync(`${abs}.import`) };
    if (kind === "texture" && ext === ".png") {
      const b = fs.readFileSync(abs);
      if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) { result.width = b.readUInt32BE(16); result.height = b.readUInt32BE(20); }
    }
    return result;
  }
}
