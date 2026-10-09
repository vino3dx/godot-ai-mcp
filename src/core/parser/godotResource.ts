// .tscn / .tres(Godot 文本资源)的无损解析与序列化。
//
// 格式依据(4.7.2 源码,非记忆):
//   - scene/resources/resource_format_text.cpp
//       :1818 `[gd_scene format=N uid="uid://..."]` / :1819 段头后空一行
//       :1818 `[gd_resource type="..." script_class="..." format=N uid="..."]`
//       :1998 资源属性 `name = value`(等号两侧各一个空格)
//       :1923 `[sub_resource type="..." id="..."]`
//       :2024 `[node name="A" type="T" parent="." owner="..." index="N" unique_id=N ...]`
//       :1939 外部资源段 `[ext_resource type="..." uid="..." path="..." id="..."]`(字段顺序由写入侧决定,本解析器不依赖顺序)
//       :2105 `[connection signal=... from=... to=... method=... flags=N unbinds=N binds= ...]`
//       :2150 `[editable path="..."]`
//   - core/variant/variant_parser.cpp :1891 解析入口;注释符只有 `;`;值可跨行(Dictionary `{\n...\n}`)
//
// 关键约定:段头整行原样保留(headerRaw),序列化时不重建,因此 `id=` 与 `uid=` 绝不被改写。
// 纯函数:入参为字符串,出参为 AST / 字符串;不接触文件系统。

import { GodotMcpError } from "../errors.js";
import type {
  GodotNodeAST,
  GodotResourceAST,
  GodotResourceBodyEntry,
  GodotResourcePassthrough,
  GodotResourceProperty,
  GodotResourceSection,
  GodotResourceTag,
  GodotLineEnding,
} from "./types.js";
import { detectNewline, findHeaderEnd, findTopLevel, parseHeader, scanBalance, skipSpace, splitArrayElements, splitLines, unquote } from "./internal.js";
import type { LinePiece } from "./internal.js";

const KNOWN_TAGS = new Set<string>([
  "gd_scene", "gd_resource", "resource", "ext_resource", "sub_resource", "node", "connection", "editable",
]);

/** 解析 .tscn / .tres。缺少 `[gd_scene]` / `[gd_resource]` 头部或结构损坏时抛 PARSE_ERROR(带行号)。 */
export function parseGodotResource(text: string): GodotResourceAST {
  const pieces = splitLines(text);
  const preamble: GodotResourcePassthrough[] = [];
  const sections: GodotResourceSection[] = [];
  let current: GodotResourceBodyEntry[] | null = null; // null 表示还在 preamble 阶段
  const pushPassthrough = (e: GodotResourcePassthrough): void => {
    if (current) current.push(e); else preamble.push(e);
  };

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const head = skipSpace(piece.text, 0);
    const c = piece.text.charAt(head);

    if (c === "") {
      pushPassthrough({ kind: "blank", raw: piece.text, eol: piece.eol });
      continue;
    }
    if (c === ";") {
      pushPassthrough({ kind: "comment", raw: piece.text, eol: piece.eol });
      continue;
    }
    if (c === "[") {
      const section = readSection(piece.text, piece.eol, i + 1);
      if (section) { sections.push(section); current = section.body; continue; }
      pushPassthrough({ kind: "raw", raw: piece.text, eol: piece.eol });
      continue;
    }
    const eq = findTopLevel(piece.text, "=", head);
    if (eq < 0) {
      pushPassthrough({ kind: "raw", raw: piece.text, eol: piece.eol });
      continue;
    }
    const read = readPropertyEntry(pieces, i, eq, i + 1);
    // 段头之前出现的 `k = v` 不合法,按原样行保留(仍无损)。
    if (current) current.push(read.entry);
    else pushPassthrough({ kind: "raw", raw: read.entry.prefix + read.entry.value, eol: read.entry.eol });
    i = read.index;
  }

  if (!sections.some((s) => s.tag === "gd_scene" || s.tag === "gd_resource")) {
    throw new GodotMcpError("PARSE_ERROR", "缺少 [gd_scene] 或 [gd_resource] 头部段", { line: 1 });
  }

  return { kind: "godot_resource", preamble, sections, newline: detectNewline(text) };
}

/** 序列化。未改动的内容逐字节还原,段头的 id / uid 原样写出。 */
export function serializeGodotResource(ast: GodotResourceAST): string {
  let out = "";
  for (const e of ast.preamble) out += e.raw + e.eol;
  for (const s of ast.sections) {
    out += s.headerRaw + s.headerEol;
    for (const e of s.body) out += e.kind === "property" ? e.prefix + e.value + e.eol : e.raw + e.eol;
  }
  return out;
}

/** 按标签筛选段。 */
export function findGodotResourceSections(ast: GodotResourceAST, tag: GodotResourceTag): GodotResourceSection[] {
  return ast.sections.filter((s) => s.tag === tag);
}

/** 读取段内属性原文;不存在返回 undefined。 */
export function getGodotResourceProperty(section: GodotResourceSection, name: string): string | undefined {
  return section.body.find((e): e is GodotResourceProperty => e.kind === "property" && e.name === name)?.value;
}

/** 改写段内已有属性的值(仅替换值文本,保留属性名/等号写法/行尾)。属性不存在返回 false。 */
export function setGodotResourceProperty(section: GodotResourceSection, name: string, value: string): boolean {
  const entry = section.body.find((e): e is GodotResourceProperty => e.kind === "property" && e.name === name);
  if (!entry) return false;
  entry.value = value;
  return true;
}

const NODE_CONSUMED = new Set<string>([
  "name", "type", "parent", "index", "unique_id", "instance", "instance_placeholder", "groups", "node_paths",
]);

/** 把 AST 里的 `[node ...]` 段转成结构化视图(只读;写回仍走 section.headerRaw)。 */
export function getGodotSceneNodes(ast: GodotResourceAST): GodotNodeAST[] {
  return findGodotResourceSections(ast, "node").map((section) => {
    const attr = (n: string): string | undefined => section.attributes.find((a) => a.name === n)?.value;
    const type = attr("type");
    const parent = attr("parent");
    const indexRaw = attr("index");
    const uniqueRaw = attr("unique_id");
    const instance = attr("instance");
    const instancePlaceholder = attr("instance_placeholder");
    const groups = splitArrayElements(attr("groups") ?? "").map(unquote);
    const nodePaths = splitArrayElements(attr("node_paths") ?? "");
    const index = indexRaw === undefined ? undefined : Number.parseInt(unquote(indexRaw), 10);
    const uniqueId = uniqueRaw === undefined ? undefined : Number.parseInt(uniqueRaw.trim(), 10);

    const node: GodotNodeAST = {
      name: unquote(attr("name") ?? ""),
      groups,
      nodePaths,
      extraAttributes: section.attributes.filter((a) => !NODE_CONSUMED.has(a.name)),
      properties: section.body.filter((e): e is GodotResourceProperty => e.kind === "property"),
      section,
    };
    if (type !== undefined) node.type = unquote(type);
    if (parent !== undefined) node.parent = unquote(parent);
    if (index !== undefined && !Number.isNaN(index)) node.index = index;
    if (uniqueId !== undefined && !Number.isNaN(uniqueId)) node.uniqueId = uniqueId;
    if (instance !== undefined) node.instance = instance;
    if (instancePlaceholder !== undefined) node.instancePlaceholder = instancePlaceholder;
    return node;
  });
}

function readSection(text: string, eol: GodotLineEnding, line: number): GodotResourceSection | null {
  const open = skipSpace(text, 0);
  if (text.charAt(open) !== "[") return null;
  const close = findHeaderEnd(text, open);
  if (close < 0) {
    throw new GodotMcpError("PARSE_ERROR", `第 ${line} 行:段头缺少 "]"`, { line });
  }
  const trailing = text.slice(close + 1).trim();
  if (trailing !== "" && !trailing.startsWith(";")) return null;
  const { tag, attributes } = parseHeader(text, open, close);
  const section: GodotResourceSection = {
    kind: "section",
    tag: (KNOWN_TAGS.has(tag) ? tag : "unknown") as GodotResourceTag,
    tagName: tag,
    headerRaw: text,
    headerEol: eol,
    attributes,
    body: [],
  };
  return section;
}

function readPropertyEntry(pieces: LinePiece[], start: number, eq: number, line: number): { entry: GodotResourceProperty; index: number } {
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
    throw new GodotMcpError("PARSE_ERROR", `第 ${line} 行:属性值未闭合(括号或引号不平衡)`, { line });
  }
  return {
    entry: { kind: "property", name: unquote(first.text.slice(0, eq)), value: raw.slice(eq + 1), prefix: first.text.slice(0, eq + 1), eol },
    index,
  };
}
