// project.godot(INI 风格)的无损解析与序列化。
//
// 格式依据(4.7.2 源码,非记忆):
//   - core/config/project_settings.cpp:1146 `_save_settings_text`
//       文件头 `; ...` 注释;`config_version=N`;段头 `[name]\n\n`;键值 `key=value\n`(等号两侧**无**空格)。
//   - core/variant/variant_parser.cpp:1891 `parse_tag_assign_eof`
//       注释符只有 `;`(:1910);键与值可跨行(:2316 Dictionary 写出 `{\n...\n}`)。
//   - core/io/config_file.cpp:191 `_internal_save`
//       段名里的 `]` 以 `\]` 转义写出。
//
// 纯函数:入参为字符串,出参为 AST / 字符串;不接触文件系统。

import { GodotMcpError } from "../errors.js";
import type { GodotConfigAST, GodotConfigEntry, GodotConfigKeyEntry, GodotConfigSection, GodotLineEnding } from "./types.js";
import { detectNewline, findHeaderEnd, findTopLevel, scanBalance, skipSpace, splitLines, unquote } from "./internal.js";
import type { LinePiece } from "./internal.js";

/** 解析 project.godot。损坏输入抛 PARSE_ERROR(带 1 起算的行号)。 */
export function parseGodotConfigFile(text: string): GodotConfigAST {
  const pieces = splitLines(text);
  const preamble: GodotConfigEntry[] = [];
  const sections: GodotConfigSection[] = [];
  let current: GodotConfigEntry[] = preamble;

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const head = skipSpace(piece.text, 0);
    const c = piece.text.charAt(head);

    if (c === "") { // 空行
      current.push({ kind: "blank", raw: piece.text, eol: piece.eol });
      continue;
    }
    if (c === ";") { // 注释
      current.push({ kind: "comment", raw: piece.text, eol: piece.eol });
      continue;
    }
    if (c === "[") { // 段头
      const section = readSection(piece.text, piece.eol, i + 1);
      if (section) { sections.push(section); current = section.entries; continue; }
      current.push({ kind: "raw", raw: piece.text, eol: piece.eol });
      continue;
    }
    const eq = findTopLevel(piece.text, "=", head);
    if (eq < 0) { // 无法识别,原样保留
      current.push({ kind: "raw", raw: piece.text, eol: piece.eol });
      continue;
    }
    const read = readKeyEntry(pieces, i, eq);
    current.push(read.entry);
    i = read.index;
  }

  return { kind: "godot_config", preamble, sections, newline: detectNewline(text) };
}

/** 序列化。未改动的内容逐字节还原。 */
export function serializeGodotConfigFile(ast: GodotConfigAST): string {
  let out = "";
  for (const e of ast.preamble) out += renderConfigEntry(e);
  for (const s of ast.sections) {
    out += s.headerRaw + s.headerEol;
    for (const e of s.entries) out += renderConfigEntry(e);
  }
  return out;
}

/**
 * 读取键值原文;段或键不存在返回 undefined。
 * `section === ""` 表示段外(preamble,如 `config_version`)。
 */
export function getGodotConfigValue(ast: GodotConfigAST, section: string, key: string): string | undefined {
  const entries = sectionEntries(ast, section);
  if (!entries) return undefined;
  return findKeyEntry(entries, key)?.value;
}

/**
 * 改写已有键的值(仅替换值文本,保留键、等号写法与行尾)。键不存在返回 false。
 * 只影响目标行,其余字节不变。
 */
export function setGodotConfigValue(ast: GodotConfigAST, section: string, key: string, value: string): boolean {
  const entries = sectionEntries(ast, section);
  if (!entries) return false;
  const entry = findKeyEntry(entries, key);
  if (!entry) return false;
  entry.value = value;
  return true;
}

function sectionEntries(ast: GodotConfigAST, section: string): GodotConfigEntry[] | undefined {
  return section === "" ? ast.preamble : ast.sections.find((s) => s.name === section)?.entries;
}

function findKeyEntry(entries: GodotConfigEntry[], key: string): GodotConfigKeyEntry | undefined {
  return entries.find((e): e is GodotConfigKeyEntry => e.kind === "key" && e.key === key);
}

function renderConfigEntry(e: GodotConfigEntry): string {
  return e.kind === "key" ? e.prefix + e.value + e.eol : e.raw + e.eol;
}

/** `[name]`;方括号内有未闭合内容时抛 PARSE_ERROR。尾随内容不是空白或注释则返回 null(降级为 raw)。 */
function readSection(text: string, eol: GodotLineEnding, line: number): GodotConfigSection | null {
  const open = skipSpace(text, 0);
  if (text.charAt(open) !== "[") return null;
  const close = findHeaderEnd(text, open);
  if (close < 0) {
    throw new GodotMcpError("PARSE_ERROR", `project.godot 第 ${line} 行:段头缺少 "]"`, { line });
  }
  const trailing = text.slice(close + 1).trim();
  if (trailing !== "" && !trailing.startsWith(";")) return null;
  const name = text.slice(open + 1, close).replaceAll("\\]", "]");
  return { kind: "section", name, headerRaw: text, headerEol: eol, entries: [] };
}

/** 读一条键值行,必要时把后续行并入(值跨行)。 */
function readKeyEntry(pieces: LinePiece[], start: number, eq: number): { entry: GodotConfigKeyEntry; index: number } {
  const first = pieces[start]!;
  let raw = first.text;
  let index = start;
  let eol = first.eol;
  let balance = scanBalance(raw, eq + 1);
  while ((balance.depth > 0 || balance.inString) && index + 1 < pieces.length) {
    index++;
    raw += pieces[index - 1]!.eol + pieces[index]!.text;
    eol = pieces[index]!.eol;
    balance = scanBalance(raw, eq + 1);
  }
  if (balance.depth > 0 || balance.inString) {
    throw new GodotMcpError("PARSE_ERROR", `project.godot 第 ${start + 1} 行:值未闭合(括号或引号不平衡)`, { line: start + 1 });
  }
  return {
    entry: { kind: "key", key: unquote(first.text.slice(0, eq)), value: raw.slice(eq + 1), prefix: first.text.slice(0, eq + 1), eol },
    index,
  };
}
