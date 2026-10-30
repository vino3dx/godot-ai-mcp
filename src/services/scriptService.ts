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
  annotations: string[];
  signals: Array<{ name: string; parameters: Array<{ name: string; type?: string; default?: string }> }>;
  enums: Array<{ name: string; values: Array<{ name: string; value?: string }> }>;
  constants: Array<{ name: string; type?: string; value?: string }>;
}

export interface ScriptMethodParameter { name: string; type?: string; default?: string }
export interface ScriptMethod { name: string; line: number; static: boolean; parameters: ScriptMethodParameter[]; returnType?: string; signature: string }
export interface ScriptSymbol { name: string; kind: "function" | "variable" | "signal"; line: number; signature?: string; type?: string; exported?: boolean; annotation?: string }
export interface ScriptAnalysis extends ScriptInfo { symbols: ScriptSymbol[]; methods: ScriptMethod[] }
export interface ScriptReference { path: string; line: number; text: string; kind: "definition" | "reference" }

export class ScriptService {
  /** 读取 extends / class_name 与全部 `@export var` 声明。 */
  getScriptInfo(text: string): ScriptInfo {
    const info: ScriptInfo = { exports: [], annotations: [], signals: [], enums: [], constants: [] };
    for (const piece of splitLines(text)) {
      const line = splitGdComment(piece.text).code.trim();
      if (line === "") continue;
      if (/^@(tool|icon|static_unload)\b/.test(line)) { info.annotations.push(line); continue; }
      const ext = /^extends\s+(\S+)/.exec(line);
      if (ext) { info.extends = ext[1]; continue; }
      const cn = /^class_name\s+([A-Za-z_]\w*)/.exec(line);
      if (cn) { info.className = cn[1]; continue; }
      const exp = parseExport(line);
      if (exp) info.exports.push(exp);
      const signal = parseSignal(line);
      if (signal) info.signals.push(signal);
      const enumeration = parseEnum(line);
      if (enumeration) info.enums.push(enumeration);
      const constant = parseConst(line);
      if (constant) info.constants.push(constant);
    }
    return info;
  }

  analyze(text: string): ScriptAnalysis {
    const info = this.getScriptInfo(text);
    const symbols: ScriptSymbol[] = [];
    const methods: ScriptMethod[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const code = splitGdComment(lines[i]!).code;
      const trimmed = code.trim();
      const fn = /^(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(trimmed);
      if (fn) { const method = parseMethod(trimmed, i + 1); methods.push(method); symbols.push({ name: fn[1]!, kind: "function", line: i + 1, signature: trimmed }); continue; }
      const sig = /^signal\s+([A-Za-z_]\w*)/.exec(trimmed);
      if (sig) { symbols.push({ name: sig[1]!, kind: "signal", line: i + 1, signature: trimmed }); continue; }
      const variable = /^(?:(@export(?:\([^)]*\))?)\s+)?var\s+([A-Za-z_]\w*)\s*(?::\s*([^=]+))?/.exec(trimmed);
      if (variable) symbols.push({ name: variable[2]!, kind: "variable", line: i + 1, type: variable[3]?.trim(), exported: Boolean(variable[1]), signature: trimmed });
    }
    return { ...info, symbols, methods };
  }

  findReferences(files: readonly { path: string; text: string }[], symbol: string): ScriptReference[] {
    assertExportName(symbol);
    const word = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    const out: ScriptReference[] = [];
    for (const file of files) {
      const lines = file.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const code = splitGdComment(lines[i]!).code;
        if (!word.test(code)) continue;
        const definition = /^\s*(?:(?:static\s+)?func|signal|var|@export)/.test(code);
        out.push({ path: file.path, line: i + 1, text: lines[i]!, kind: definition ? "definition" : "reference" });
      }
    }
    return out;
  }

  updateFunction(text: string, name: string, replacement: string): { text: string; functionName: string; startLine: number; endLine: number } {
    assertExportName(name);
    if (typeof replacement !== "string" || replacement.trim() === "") throw new GodotMcpError("INVALID_ARGUMENT", "函数替换内容不能为空", { name });
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const declarations: Array<{ index: number; kind: "function" | "other" | "class" }> = [];
    for (let i = 0; i < lines.length; i++) {
      const code = splitGdComment(lines[i]!).code;
      if (/^\s*class\s+[A-Za-z_]\w*\s*:\s*$/.test(code)) declarations.push({ index: i, kind: "class" });
      else if (/^\s*(?:static\s+)?func\s+[A-Za-z_]\w*\s*\(/.test(code)) declarations.push({ index: i, kind: "function" });
      else if (/^\s*(?:signal|var|const|enum|class_name|extends|@onready\b|@export\b|@tool\b|@icon\b|@static_unload\b)/.test(code)) declarations.push({ index: i, kind: "other" });
    }
    const index = declarations.find((d) => d.kind === "function" && new RegExp(`^\\s*(?:static\\s+)?func\\s+${escapeRegExp(name)}\\s*\\(`).test(splitGdComment(lines[d.index]!).code))?.index;
    if (index === undefined) throw new GodotMcpError("INVALID_ARGUMENT", `脚本中找不到函数: ${name}`, { name });
    const nextDeclaration = declarations.find((d) => d.index > index);
    if (nextDeclaration?.kind === "class") throw new GodotMcpError("INVALID_ARGUMENT", "目标函数后出现嵌套类，无法安全确定函数边界", { name, line: nextDeclaration.index + 1 });
    if (nextDeclaration?.kind === "other") throw new GodotMcpError("INVALID_ARGUMENT", "目标函数后出现其他顶层声明，无法安全确定函数边界", { name, line: nextDeclaration.index + 1 });
    let end = nextDeclaration?.index ?? lines.length;
    if (nextDeclaration === undefined) {
      while (end > index + 1 && lines[end - 1]!.trim() === "") end--;
      while (end > index + 1 && /^\s*#/.test(lines[end - 1]!)) end--;
    }
    const replacementLines = replacement.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    const replacementDecl = splitGdComment(replacementLines[0]!).code;
    if (!new RegExp(`^\\s*(?:static\\s+)?func\\s+${escapeRegExp(name)}\\s*\\(`).test(replacementDecl)) throw new GodotMcpError("INVALID_ARGUMENT", "替换内容必须以同名函数声明开头", { name });
    if (replacementLines.slice(1).some((line) => /^(?:static\s+)?func\s+[A-Za-z_]\w*\s*\(/.test(splitGdComment(line).code))) throw new GodotMcpError("INVALID_ARGUMENT", "替换内容不能包含另一个顶层函数声明", { name });
    lines.splice(index, end - index, ...replacementLines);
    return { text: lines.join(eol), functionName: name, startLine: index + 1, endLine: index + replacementLines.length };
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

function parseSignal(line: string): ScriptInfo["signals"][number] | null {
  const m = /^signal\s+([A-Za-z_]\w*)\s*(?:\((.*)\))?$/.exec(line);
  if (!m) return null;
  return { name: m[1]!, parameters: parseParameters(m[2] ?? "") };
}

function parseEnum(line: string): ScriptInfo["enums"][number] | null {
  const m = /^enum\s+([A-Za-z_]\w*)\s*\{(.*)\}$/.exec(line);
  if (!m) return null;
  return { name: m[1]!, values: splitComma(m[2]!).map((item) => {
    const [name, value] = item.split("=", 2).map((v) => v.trim());
    return value === undefined ? { name: name! } : { name: name!, value };
  }) };
}

function parseConst(line: string): ScriptInfo["constants"][number] | null {
  const m = /^const\s+([A-Za-z_]\w*)\s*(?::\s*([^=]+))?\s*(?:=\s*(.*))?$/.exec(line);
  return m ? { name: m[1]!, ...(m[2] ? { type: m[2].trim() } : {}), ...(m[3] ? { value: m[3].trim() } : {}) } : null;
}

function parseMethod(line: string, lineNumber: number): ScriptMethod {
  const m = /^(static\s+)?func\s+([A-Za-z_]\w*)\s*\((.*)\)\s*(?:->\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?))?/.exec(line);
  return { name: m?.[2] ?? "", line: lineNumber, static: Boolean(m?.[1]), parameters: parseParameters(m?.[3] ?? ""), ...(m?.[4] ? { returnType: m[4] } : {}), signature: line };
}

function parseParameters(raw: string): ScriptMethodParameter[] {
  return splitComma(raw).filter(Boolean).map((item) => {
    const eq = item.indexOf("="); const left = (eq < 0 ? item : item.slice(0, eq)).trim(); const def = eq < 0 ? undefined : item.slice(eq + 1).trim();
    const colon = left.indexOf(":"); const name = (colon < 0 ? left : left.slice(0, colon)).trim(); const type = colon < 0 ? undefined : left.slice(colon + 1).trim();
    return { name, ...(type ? { type } : {}), ...(def ? { default: def } : {}) };
  });
}

function splitComma(raw: string): string[] {
  const out: string[] = []; let start = 0; let depth = 0; let quote = false;
  for (let i = 0; i < raw.length; i++) { const c = raw[i]!; if (c === '"' && raw[i - 1] !== "\\") quote = !quote; if (quote) continue; if ("([{<".includes(c)) depth++; else if (")]}>".includes(c)) depth--; else if (c === "," && depth === 0) { out.push(raw.slice(start, i).trim()); start = i + 1; } }
  if (raw.slice(start).trim()) out.push(raw.slice(start).trim()); return out;
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

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
