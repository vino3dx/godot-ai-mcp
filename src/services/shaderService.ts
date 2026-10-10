// ShaderService:.gdshader 的基础读取与安全更新。
//
// 纯逻辑:入参/出参都是文本,不接触文件系统、不加锁、不碰 Runtime —— 落盘与并发由更上层负责。
// 依赖 core/parser/internal.js 的底层扫描(findTopLevel / scanBalance / splitLines),不碰 Godot 文本资源解析器。
//
// 作用域声明(「基础」版):
//   - 解析 `shader_type`、`render_mode`(逗号分隔)与单行 `uniform <type> <name> [: hint] [= default]` 声明。
//   - 安全更新仅支持改写某个 uniform 的默认值(= default),只动目标行,其余字节逐字节保留。
//   - 注释只处理 `//`(行尾);`/* */` 块注释不在本版范围内。
import { GodotMcpError } from "../core/errors.js";
import { findTopLevel, scanBalance, splitLines } from "../core/parser/internal.js";
import type { LinePiece } from "../core/parser/internal.js";

/** 一个 uniform 声明(结构化解码)。 */
export interface ShaderUniform {
  name: string;
  type: string;
  /** `: hint`(如 `source_color`、`hint_range(0.0, 1.0)`);无 hint 时缺省。 */
  hint?: string;
  /** `= default` 的原始表达式;无默认值时缺省。 */
  default?: string;
}

/** .gdshader 的结构化视图。 */
export interface ShaderInfo {
  /** `shader_type spatial` → `spatial`;缺失时为 undefined。 */
  shaderType?: string;
  /** `render_mode` 逗号分隔的模式名列表(已 trim)。 */
  renderModes: string[];
  uniforms: ShaderUniform[];
}

export class ShaderService {
  /** 读取 shader_type、render_mode 与全部 uniform 声明。 */
  getShaderInfo(text: string): ShaderInfo {
    const info: ShaderInfo = { renderModes: [], uniforms: [] };
    for (const piece of splitLines(text)) {
      const line = splitShaderComment(piece.text).code.trim();
      const mt = /^shader_type\s+([A-Za-z_]\w*)\s*;/.exec(line);
      if (mt) { info.shaderType = mt[1]; continue; }
      const rm = /^render_mode\s+([^;]*);/.exec(line);
      if (rm) { info.renderModes = splitModes(rm[1] ?? ""); continue; }
      const uniform = parseUniform(line);
      if (uniform) info.uniforms.push(uniform);
    }
    return info;
  }

  /**
   * 改写某个 uniform 的默认值(=`default`);没有默认值时补上。
   * 只动目标行,其余字节(含缩进、尾随 `//` 注释、行尾)逐字节保留。找不到该 uniform 抛 INVALID_ARGUMENT。
   */
  updateUniformDefault(text: string, name: string, value: string): string {
    assertUniformName(name);
    assertValidValue(name, value);
    const pieces = splitLines(text);
    for (let i = 0; i < pieces.length; i++) {
      const uniform = parseUniform(splitShaderComment(pieces[i]!.text).code.trim());
      if (uniform && uniform.name === name) {
        pieces[i]!.text = rewriteUniformDefault(pieces[i]!.text, value);
        return joinLines(pieces);
      }
    }
    throw new GodotMcpError("INVALID_ARGUMENT", `shader 中找不到 uniform: ${name}`, { name });
  }
}

// ────────────────────────────── 内部工具 ──────────────────────────────

/** 解析单行 uniform 声明;不是 uniform 或结构不完整时返回 null。入参已去掉 `//` 注释。 */
function parseUniform(line: string): ShaderUniform | null {
  if (!/^uniform\b/.test(line)) return null;
  const bodyStart = line.indexOf("uniform") + "uniform".length;
  const semi = findTopLevel(line, ";", bodyStart);
  const decl = (semi < 0 ? line.slice(bodyStart) : line.slice(bodyStart, semi)).trim();
  if (decl === "") return null;

  const eq = findTopLevel(decl, "=", 0);
  let typeNameHint = decl;
  let def: string | undefined;
  if (eq >= 0) { def = decl.slice(eq + 1).trim(); typeNameHint = decl.slice(0, eq).trim(); }

  const colon = findTopLevel(typeNameHint, ":", 0);
  let typeName = typeNameHint;
  let hint: string | undefined;
  if (colon >= 0) { hint = typeNameHint.slice(colon + 1).trim(); typeName = typeNameHint.slice(0, colon).trim(); }

  const ws = /\s+/.exec(typeName);
  if (!ws) return null;
  const type = typeName.slice(0, ws.index);
  const name = typeName.slice(ws.index + ws[0].length);
  if (type === "" || name === "" || /\s/.test(name)) return null;

  const uniform: ShaderUniform = { name, type };
  if (hint !== undefined && hint !== "") uniform.hint = hint;
  if (def !== undefined && def !== "") uniform.default = def;
  return uniform;
}

/** 重写目标行的默认值;保留前导空白、尾随 `//` 注释(含其前分隔空白)与 `;` 之后的原文。 */
function rewriteUniformDefault(rawLine: string, value: string): string {
  const { code, comment } = splitShaderComment(rawLine);
  const lead = /^\s*/.exec(code)?.[0] ?? "";
  const body = code.slice(lead.length);
  const semi = findTopLevel(body, ";", 0);
  const head = semi < 0 ? body.trimEnd() : body.slice(0, semi);
  const tail = semi < 0 ? "" : body.slice(semi);
  const eq = findTopLevel(head, "=", 0);
  const before = eq >= 0 ? head.slice(0, eq).trimEnd() : head.trimEnd();
  return `${lead}${before} = ${value}${tail}${comment}`;
}

/** 拆分 `//` 行注释:code 去掉尾随空白,comment 保留分隔空白与注释正文。 */
function splitShaderComment(rawLine: string): { code: string; comment: string } {
  const idx = findLineComment(rawLine);
  if (idx < 0) return { code: rawLine, comment: "" };
  const codeEnd = rawLine.slice(0, idx).replace(/\s+$/, "").length;
  return { code: rawLine.slice(0, codeEnd), comment: rawLine.slice(codeEnd) };
}

/** 首个 `//`(字符串外)的位置;没有返回 -1。 */
function findLineComment(line: string): number {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "/" && line.charAt(i + 1) === "/") return i;
  }
  return -1;
}

function splitModes(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

function joinLines(pieces: LinePiece[]): string {
  let out = "";
  for (const p of pieces) out += p.text + p.eol;
  return out;
}

function assertUniformName(name: string): void {
  if (typeof name !== "string" || name.trim() === "" || name !== name.trim()) {
    throw new GodotMcpError("INVALID_ARGUMENT", `uniform 名非法(非空且不得有首尾空白): ${JSON.stringify(name)}`, { name });
  }
  if (/[\s=:;]/.test(name)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `uniform 名非法(不得含空白或 '=' ':' ';'): ${JSON.stringify(name)}`, { name });
  }
}

/** 写入前校验:值必须是括号/引号平衡的完整表达式。 */
function assertValidValue(name: string, value: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", `默认值不能为空: ${name}`, { name, value });
  }
  const balance = scanBalance(value, 0);
  if (balance.depth !== 0 || balance.inString) {
    throw new GodotMcpError("INVALID_ARGUMENT", `默认值不是合法的表达式(括号或引号不平衡): ${name}`, { name, value });
  }
}
