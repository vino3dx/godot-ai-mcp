// ScriptService:.gd(GDScript)的基础读取与安全更新。
//
// 纯逻辑:入参/出参都是文本,不接触文件系统、不加锁、不碰 Runtime —— 落盘与并发由更上层负责。
// 依赖 core/parser/internal.js 的底层扫描(findTopLevel / scanBalance / splitLines),不碰 Godot 文本资源解析器。
//
// 作用域声明(「基础」版):
//   - 解析顶层 `extends`、`class_name`,以及单行 `@export ... var <name> [: type] [= default]` 声明。
//   - 安全更新仅支持改写某个 `@export var` 的默认值(= default),只动目标行,其余字节逐字节保留。
//   - 注释只处理 `#`(行尾);`@export` 与 `var` 分行的写法不在本版范围内。
import { GodotMcpError } from "../core/errors.js";
import { findTopLevel, scanBalance, splitLines } from "../core/parser/internal.js";
import type { LinePiece } from "../core/parser/internal.js";
import { literalChange, type LiteralChange } from "../core/parser/literal.js";

/** 一个 `@export var` 声明(结构化解码)。 */
export interface ScriptExport {
  name: string;
  /** `: Type`(可含泛型如 `Array[Color]`);无类型注解时缺省。 */
  type?: string;
  /** `= default` 的原始表达式;无默认值时缺省。 */
  default?: string;
}

/** .gd 脚本的结构化视图。 */
export interface ScriptInfo {
  /** `extends X` 的基类名或路径;缺失时为 undefined。 */
  extends?: string;
  /** `class_name X` 的类名;缺失时为 undefined。 */
  className?: string;
  exports: ScriptExport[];
}

export class ScriptService {
  /** 读取 extends / class_name 与全部 `@export var` 声明。 */
  getScriptInfo(text: string): ScriptInfo {
    const info: ScriptInfo = { exports: [] };
    for (const piece of splitLines(text)) {
      const line = splitGdComment(piece.text).code.trim();
      if (line === "") continue;
      const ext = /^extends\s+(\S+)/.exec(line);
      if (ext) { info.extends = ext[1]; continue; }
      const cn = /^class_name\s+([A-Za-z_]\w*)/.exec(line);
      if (cn) { info.className = cn[1]; continue; }
      const exp = parseExport(line);
      if (exp) info.exports.push(exp);
    }
    return info;
  }

  /**
   * 改写某个 `@export var` 的默认值(=`default`);没有默认值时补上。
   * 只动目标行,其余字节(含缩进、尾随 `#` 注释、行尾)逐字节保留。找不到该变量抛 INVALID_ARGUMENT。
   */
  updateExportDefault(text: string, name: string, value: string): string {
    return this.updateExportDefaultResult(text, name, value).text;
  }

  /**
   * 与 updateExportDefault 完全相同的写入,额外回报结构化前后值。
   * before/after 都是**文件里的静态字面量**(不是运行中的脚本变量值);
   * 该 @export 原本没有默认值时 before 为 null 且 inFile=false。
   */
  updateExportDefaultResult(text: string, name: string, value: string): { text: string; change: LiteralChange } {
    assertExportName(name);
    assertValidValue(name, value);
    const pieces = splitLines(text);
    for (let i = 0; i < pieces.length; i++) {
      const exp = parseExport(splitGdComment(pieces[i]!.text).code.trim());
      if (exp && exp.name === name) {
        pieces[i]!.text = rewriteExportDefault(pieces[i]!.text, value);
        return { text: joinLines(pieces), change: literalChange(name, exp.default ?? null, value) };
      }
    }
    throw new GodotMcpError("INVALID_ARGUMENT", `脚本中找不到 @export 变量: ${name}`, { name });
  }
}

// ────────────────────────────── 内部工具 ──────────────────────────────

/** 解析单行 `@export ... var name [: type] [= default]`;不是 export 时返回 null。入参已去掉 `#` 注释。 */
function parseExport(line: string): ScriptExport | null {
  if (!/^@export/.test(line)) return null;
  const m = /\bvar\s+([A-Za-z_]\w*)\b(.*)$/.exec(line);
  if (!m) return null;
  const name = m[1]!;
  const rest = m[2] ?? "";
  const exp: ScriptExport = { name };

  const eq = findTopLevel(rest, "=", 0);
  let typePart = rest;
  if (eq >= 0) {
    const def = rest.slice(eq + 1).trim();
    if (def !== "") exp.default = def;
    typePart = rest.slice(0, eq);
  }
  const colon = findTopLevel(typePart, ":", 0);
  if (colon >= 0) {
    const t = typePart.slice(colon + 1).trim();
    if (t !== "") exp.type = t;
  }
  return exp;
}

/** 重写目标行的默认值;保留前导空白与尾随 `#` 注释(含其前分隔空白)。 */
function rewriteExportDefault(rawLine: string, value: string): string {
  const { code, comment } = splitGdComment(rawLine);
  const lead = /^\s*/.exec(code)?.[0] ?? "";
  const body = code.slice(lead.length);
  const m = /\bvar\s+([A-Za-z_]\w*)\b/.exec(body);
  if (!m) return rawLine; // 不应发生:调用前已确认是 export 行
  const afterPos = m.index + m[0].length;
  const before = body.slice(0, afterPos); // 含 "@export ... var name"
  const after = body.slice(afterPos);     // 含 ": type = default"
  const eq = findTopLevel(after, "=", 0);
  const kept = eq >= 0 ? after.slice(0, eq).trimEnd() : after.trimEnd();
  return `${lead}${before}${kept} = ${value}${comment}`;
}

/** 拆分 `#` 行注释:code 去掉尾随空白,comment 保留分隔空白与注释正文。 */
function splitGdComment(rawLine: string): { code: string; comment: string } {
  const idx = findGdComment(rawLine);
  if (idx < 0) return { code: rawLine, comment: "" };
  const codeEnd = rawLine.slice(0, idx).replace(/\s+$/, "").length;
  return { code: rawLine.slice(0, codeEnd), comment: rawLine.slice(codeEnd) };
}

/** 首个 `#`(字符串外)的位置;没有返回 -1。 */
function findGdComment(line: string): number {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "#") return i;
  }
  return -1;
}

function joinLines(pieces: LinePiece[]): string {
  let out = "";
  for (const p of pieces) out += p.text + p.eol;
  return out;
}

function assertExportName(name: string): void {
  if (typeof name !== "string" || name.trim() === "" || name !== name.trim()) {
    throw new GodotMcpError("INVALID_ARGUMENT", `变量名非法(非空且不得有首尾空白): ${JSON.stringify(name)}`, { name });
  }
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `变量名非法(必须是合法标识符): ${JSON.stringify(name)}`, { name });
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
