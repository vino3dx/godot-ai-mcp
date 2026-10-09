// Godot 文本格式的底层扫描工具:按行拆分、括号/引号平衡、段头切分。纯函数,只依赖同目录的类型。
// 所有下标从 0 起算。扫描规则对齐 core/variant/variant_parser.cpp 的 get_token/parse_value:
// 字符串用 `"` 包裹、`\` 转义;`[` `]` / `{` `}` / `(` `)` 成对嵌套。

import type { GodotLineEnding } from "./types.js";

export interface LinePiece {
  /** 行内容,不含行尾 */
  text: string;
  /** 行尾:"\n" | "\r\n" | "\r" | ""(最后一行无换行) */
  eol: GodotLineEnding;
}

/** 按行拆分并保留每行原文与行尾。行尾换行归属前一行,不会多出空行。 */
export function splitLines(text: string): LinePiece[] {
  const out: LinePiece[] = [];
  const re = /\r\n|\n|\r/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: text.slice(start, m.index), eol: m[0] as GodotLineEnding });
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push({ text: text.slice(start), eol: "" });
  return out;
}

/** 探测主导行尾;无换行时默认 "\n"。 */
export function detectNewline(text: string): string {
  const m = /\r\n|\n|\r/.exec(text);
  return m ? m[0] : "\n";
}

export interface Balance {
  /** 未闭合的括号层数 */
  depth: number;
  /** 是否停在未闭合的字符串里 */
  inString: boolean;
}

/** 从 `from` 起扫描引号与括号平衡状态。depth 与 inString 均为初值时表示完整的值。 */
export function scanBalance(text: string, from: number, initial?: Balance): Balance {
  let depth = initial ? initial.depth : 0;
  let inString = initial ? initial.inString : false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const c = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") depth--;
  }
  return { depth, inString };
}

/** 在括号深度 0 且不在字符串内查找首个 `ch`;找不到返回 -1。 */
export function findTopLevel(text: string, ch: string, from = 0): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const c = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/** 段头 `[ ... ]` 的闭合位置(深度归零的那个 `]`);找不到返回 -1。 */
export function findHeaderEnd(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const c = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

export function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\n";
}

export function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isSpace(text.charAt(i))) i++;
  return i;
}

/** 字符串结束引号的下标(`i` 指向开引号);未闭合返回 -1。 */
function findStringEnd(text: string, i: number, limit: number): number {
  let escaped = false;
  for (let j = i + 1; j < limit; j++) {
    const c = text.charAt(j);
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === '"') return j;
  }
  return -1;
}

/** 从 `i` 处括号起,匹配闭合字符的下标;跨类型用栈匹配。找不到返回 -1。 */
function findClose(text: string, i: number, limit: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let j = i; j < limit; j++) {
    const c = text.charAt(j);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "[" || c === "{" || c === "(") stack.push(c);
    else if (c === "]" || c === "}" || c === ")") {
      stack.pop();
      if (stack.length === 0) return j;
    }
  }
  return -1;
}

/** 读取一个 token(带引号字符串 / 括号块 / 裸词)。保证 next > i。 */
function readToken(text: string, i: number, limit: number): { text: string; next: number } {
  const c = text.charAt(i);
  if (c === '"') {
    const end = findStringEnd(text, i, limit);
    return end < 0 ? { text: text.slice(i), next: limit } : { text: text.slice(i, end + 1), next: end + 1 };
  }
  if (c === "[" || c === "{" || c === "(") {
    const end = findClose(text, i, limit);
    return end < 0 ? { text: text.slice(i), next: limit } : { text: text.slice(i, end + 1), next: end + 1 };
  }
  let j = i;
  while (j < limit && !isSpace(text.charAt(j)) && text.charAt(j) !== "=") j++;
  return { text: text.slice(i, j), next: Math.max(j, i + 1) };
}

/** 去掉成对引号并反转义(Godot `String::c_escape` 子集)。没有引号时返回 trim 后的原文。 */
export function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length < 2 || t.charAt(0) !== '"' || t.charAt(t.length - 1) !== '"') return t;
  const body = t.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c !== "\\") { out += c; continue; }
    const n = body.charAt(++i);
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n === "b") out += "\b";
    else if (n === "f") out += "\f";
    else if (n === "u" || n === "U") {
      const len = n === "u" ? 4 : 6;
      const cp = parseInt(body.slice(i + 1, i + 1 + len), 16);
      if (Number.isNaN(cp)) out += n;
      else { out += String.fromCodePoint(cp); i += len; }
    } else out += n;
  }
  return out;
}

export interface HeaderToken {
  name: string;
  value: string;
}

/**
 * 解析段头内部内容(不含最外层方括号):
 *   `node name="A" type="Node2D" groups=["a", "b"]`
 *   → tag `node`,属性 [name, type, groups]
 * tag 若带引号会被解开;属性值保留原文(含引号)。
 */
export function parseHeader(text: string, open: number, close: number): { tag: string; attributes: HeaderToken[] } {
  let i = skipSpace(text, open + 1);
  const tagTok = readToken(text, i, close);
  i = tagTok.next;
  const tag = tagTok.text.charAt(0) === '"' ? unquote(tagTok.text) : tagTok.text;

  const attributes: HeaderToken[] = [];
  while (i < close) {
    i = skipSpace(text, i);
    if (i >= close) break;
    const nameTok = readToken(text, i, close);
    if (nameTok.next <= i) break;
    i = nameTok.next;
    i = skipSpace(text, i);
    if (text.charAt(i) !== "=") {
      if (nameTok.text !== "") attributes.push({ name: nameTok.text, value: "" });
      continue;
    }
    i = skipSpace(text, i + 1);
    const valTok = readToken(text, i, close);
    attributes.push({ name: nameTok.text, value: valTok.text });
    i = Math.max(valTok.next, i + 1);
  }
  return { tag, attributes };
}

/** 把 `["a", "b"]` / `PackedStringArray("a")` / `[NodePath("x"), NodePath("y")]` 拆成顶层元素原文。 */
export function splitArrayElements(raw: string): string[] {
  const t = raw.trim();
  const open = t.search(/[[(]/);
  if (open < 0) return [];
  const closer = t.charAt(open) === "[" ? "]" : ")";
  const close = t.lastIndexOf(closer);
  if (close <= open) return [];
  const inner = t.slice(open + 1, close);

  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") depth--;
    else if (c === "," && depth === 0) { out.push(inner.slice(start, i).trim()); start = i + 1; }
  }
  const tail = inner.slice(start).trim();
  if (tail !== "") out.push(tail);
  return out.filter((s) => s !== "");
}
