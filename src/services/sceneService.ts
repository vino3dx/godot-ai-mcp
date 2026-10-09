// SceneService:.tscn 场景树的结构化读取与无损修改。
//
// 纯逻辑:入参/出参都是文本,不接触文件系统、不加锁、不碰 Runtime —— 落盘与并发由更上层负责。
// 依赖 core/parser:
//   - index.js:parseGodotResource / serializeGodotResource / findGodotResourceSections / getGodotSceneNodes
//   - internal.js:scanBalance(写入前拒绝会破坏文件的属性值;括号/引号平衡语义的唯一实现处)
// 格式依据见 src/core/parser/godotResource.ts 与 types.ts 顶部的 4.7.2 源码行号(段头属性、`name = value`)。
import { GodotMcpError } from "../core/errors.js";
import { scanBalance } from "../core/parser/internal.js";
import {
  findGodotResourceSections,
  getGodotSceneNodes,
  parseGodotResource,
  serializeGodotResource,
  type GodotNodeAST,
  type GodotResourceAST,
  type GodotResourceProperty,
  type GodotResourceSection,
} from "../core/parser/index.js";

/** 场景根节点的规范路径。 */
const ROOT = ".";

/**
 * 属于 `[node ...]` 段头的字段。它们由段头表达(改名/改父节点/分组等),不能当普通属性写进段体,
 * 否则会写出与段头冲突的重复字段。这些操作留给后续的 renameNode / reparentNode 等专用 API。
 */
const NODE_HEADER_ATTRS = new Set([
  "name", "type", "parent", "index", "unique_id", "instance", "instance_placeholder", "groups", "node_paths", "owner",
]);

/** 场景内一个节点(结构化视图)。 */
export interface SceneNode {
  name: string;
  /** 规范节点路径:根为 ".",子节点为 "Player",孙节点为 "Player/Sprite"。 */
  path: string;
  /** 父节点路径;根节点为 undefined。 */
  parentPath?: string;
  type?: string;
  /** 挂载脚本:解析成功的 `res://` 路径;解析不到时保留 `ExtResource("id")` 原文。 */
  script?: string;
  /** 实例化来源:`instance=ExtResource("id")` 解析出的 `res://` 路径,解析不到时保留原文。 */
  instance?: string;
  uniqueId?: number;
  groups: string[];
  /** 段体属性(值已去掉 `=` 后的分隔空白)。 */
  properties: Array<{ name: string; value: string }>;
  children: SceneNode[];
}

export interface SceneTree {
  /** 场景根节点(无 `[node]` 段时为 undefined,例如 .tres)。 */
  root?: SceneNode;
  /** 全部节点,深度优先(根在前);文件里引用不到的节点排在最后,不丢。 */
  nodes: SceneNode[];
}

export class SceneService {
  /** 提取结构化节点树:节点名称、类型、Path、父节点、挂载脚本、分组与属性。 */
  getSceneTree(tscnText: string): SceneTree {
    const ast = parseGodotResource(tscnText);
    const ext = extResourcePaths(ast);
    const astNodes = getGodotSceneNodes(ast);
    const created: SceneNode[] = [];
    const byPath = new Map<string, SceneNode>();
    let root: SceneNode | undefined;

    for (const astNode of astNodes) {
      const node = toSceneNode(astNode, ext);
      if (byPath.has(node.path)) {
        throw new GodotMcpError("PARSE_ERROR", `场景中存在重复的节点路径: ${node.path}`, { nodePath: node.path });
      }
      byPath.set(node.path, node);
      created.push(node);
      if (astNode.parent === undefined) {
        if (root) {
          throw new GodotMcpError("PARSE_ERROR", `场景存在多个根节点(缺少 parent 的 [node] 段): ${root.name} / ${node.name}`, { nodePath: node.path });
        }
        root = node;
      }
    }

    for (const astNode of astNodes) {
      const node = byPath.get(nodePathOf(astNode.name, astNode.parent));
      if (!node || node === root) continue;
      const rawParent = astNode.parent ?? ROOT;
      const parent = rawParent === ROOT ? root : byPath.get(rawParent);
      if (parent) {
        node.parentPath = parent.path;
        parent.children.push(node);
      } else {
        // 父节点不在本文件(例如父节点来自被实例化的子场景):挂到根下并保留真实 parentPath,不丢节点。
        node.parentPath = rawParent;
        if (root) root.children.push(node);
      }
    }

    const ordered: SceneNode[] = [];
    const seen = new Set<SceneNode>();
    const walk = (n: SceneNode): void => {
      if (seen.has(n)) return;
      seen.add(n);
      ordered.push(n);
      for (const c of n.children) walk(c);
    };
    if (root) walk(root);
    for (const n of created) if (!seen.has(n)) walk(n);
    return { root, nodes: ordered };
  }

  /**
   * 修改(属性已存在)或新增(不存在则在段体末尾、尾随空行之前插入)节点属性。
   * 返回无损序列化后的文本:除目标行/新增行外,其余字节不变。
   */
  updateNodeProperty(tscnText: string, nodePath: string, key: string, value: string): string {
    if (key.trim() === "" || /[\s=]/.test(key)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `属性名非法(不得含空白或 '='): ${JSON.stringify(key)}`, { key });
    }
    if (NODE_HEADER_ATTRS.has(key)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `"${key}" 是节点段头字段,不能作为段体属性写入`, { key });
    }
    assertValidValue(key, value);

    const ast = parseGodotResource(tscnText);
    const section = findNodeSection(ast, nodePath);
    const entry = section.body.find((e): e is GodotResourceProperty => e.kind === "property" && e.name === key);
    if (entry) {
      entry.value = `${separatorOf(entry.value)}${value}`; // 保留原行的 `=` 后空白写法
    } else {
      section.body.splice(insertIndex(section.body), 0, {
        kind: "property",
        name: key,
        prefix: `${key} =`,
        value: ` ${value}`,
        eol: section.headerEol,
      });
    }
    return serializeGodotResource(ast);
  }

  /** 删除节点及其所有子节点(含各自段头/段体/尾随空行);返回无损序列化后的文本。 */
  removeNode(tscnText: string, nodePath: string): string {
    const target = normalizeNodePath(nodePath);
    if (target === ROOT) {
      throw new GodotMcpError("INVALID_ARGUMENT", "不能删除场景根节点(删除后场景没有根)", { nodePath });
    }
    const ast = parseGodotResource(tscnText);
    const doomed = new Set<GodotResourceSection>();
    for (const section of findGodotResourceSections(ast, "node")) {
      const path = nodeSectionPath(section);
      if (path !== undefined && (path === target || path.startsWith(`${target}/`))) doomed.add(section);
    }
    if (doomed.size === 0) {
      throw new GodotMcpError("INVALID_ARGUMENT", `场景中找不到节点: ${nodePath}`, { nodePath, normalized: target });
    }
    ast.sections = ast.sections.filter((s) => !doomed.has(s));
    return serializeGodotResource(ast);
  }
}

// ────────────────────────────── 内部工具 ──────────────────────────────

/** 规范化节点路径:根为 ".",其余为相对场景根的 `/` 分隔路径。接受 ".", "/root", "/root/A/B", "A/B", "./A"。 */
function normalizeNodePath(input: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", "nodePath 不能为空", { nodePath: input });
  }
  let p = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (p === "root") return ROOT;
  if (p.startsWith("root/")) p = p.slice("root/".length);
  p = p.replace(/^\.\//, "").replace(/\/+$/, "");
  return p === "" || p === ROOT ? ROOT : p;
}

/** Godot 的 `parent` 字段语义:无 parent 为场景根;`parent="."` 是根的直接子节点,其余相对场景根。 */
function nodePathOf(name: string, parent: string | undefined): string {
  if (parent === undefined) return ROOT;
  return parent === ROOT ? name : `${parent}/${name}`;
}

function nodeSectionPath(section: GodotResourceSection): string | undefined {
  const name = attrValue(section, "name");
  return name === undefined ? undefined : nodePathOf(name, attrValue(section, "parent"));
}

function findNodeSection(ast: GodotResourceAST, nodePath: string): GodotResourceSection {
  const target = normalizeNodePath(nodePath);
  for (const section of findGodotResourceSections(ast, "node")) {
    if (nodeSectionPath(section) === target) return section;
  }
  throw new GodotMcpError("INVALID_ARGUMENT", `场景中找不到节点: ${nodePath}`, { nodePath, normalized: target });
}

function toSceneNode(n: GodotNodeAST, ext: Map<string, string>): SceneNode {
  const node: SceneNode = {
    name: n.name,
    path: nodePathOf(n.name, n.parent),
    properties: n.properties.map((p) => ({ name: p.name, value: bodyValue(p) })),
    groups: [...n.groups],
    children: [],
  };
  if (n.type !== undefined) node.type = n.type;
  if (n.uniqueId !== undefined) node.uniqueId = n.uniqueId;
  if (n.instance !== undefined) node.instance = resolveExtRef(n.instance, ext) ?? n.instance;
  const script = n.properties.find((p) => p.name === "script");
  if (script) {
    const raw = bodyValue(script);
    node.script = resolveExtRef(raw, ext) ?? raw;
  }
  return node;
}

/** 段体属性值:`name = value` 中 `=` 之后的原文(含分隔空白),读取时去掉一个分隔空白。 */
function bodyValue(property: GodotResourceProperty): string {
  return property.value.replace(/^[ \t]/, "");
}

function separatorOf(raw: string): string {
  return /^[ \t]*/.exec(raw)?.[0] ?? "";
}

/** 新属性插入点:最后一个非空行之后(尾随空行留到段尾)。 */
function insertIndex(body: GodotResourceSection["body"]): number {
  let at = 0;
  for (let i = 0; i < body.length; i++) if (body[i]!.kind !== "blank") at = i + 1;
  return at;
}

/** 写入前校验:值必须是括号/引号平衡的完整 Godot 表达式,否则拒绝(不产出损坏文件)。 */
function assertValidValue(key: string, value: string): void {
  if (value.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", `属性值不能为空: ${key}`, { key, value });
  }
  const balance = scanBalance(value, 0);
  if (balance.depth !== 0 || balance.inString) {
    throw new GodotMcpError("INVALID_ARGUMENT", `属性值不是合法的 Godot 表达式(括号或引号不平衡): ${key}`, { key, value });
  }
}

/** 段头字段取值(去引号 / 反转义);裸值(如 `format=3`)原样返回。 */
function attrValue(section: GodotResourceSection, name: string): string | undefined {
  const raw = section.attributes.find((a) => a.name === name)?.value;
  return raw === undefined ? undefined : decodeQuoted(raw);
}

/** `id` → `path` 映射,用于把 `ExtResource("1_script")` 解析成 `res://…`。 */
function extResourcePaths(ast: GodotResourceAST): Map<string, string> {
  const map = new Map<string, string>();
  for (const section of findGodotResourceSections(ast, "ext_resource")) {
    const id = attrValue(section, "id");
    const path = attrValue(section, "path");
    if (id !== undefined && id !== "" && path !== undefined) map.set(id, path);
  }
  return map;
}

const EXT_REF = /ExtResource\(\s*("(?:[^"\\]|\\.)*")\s*\)/;

function resolveExtRef(raw: string | undefined, ext: Map<string, string>): string | undefined {
  const id = raw === undefined ? undefined : EXT_REF.exec(raw)?.[1];
  return id === undefined ? undefined : ext.get(decodeQuoted(id));
}

/** 去掉成对引号并反转义(与解析器的 unquote 同规则;此处仅用于段头/id 这类短文本)。 */
function decodeQuoted(raw: string): string {
  const t = raw.trim();
  if (t.length < 2 || t.charAt(0) !== '"' || t.charAt(t.length - 1) !== '"') return t;
  return t.slice(1, -1).replace(/\\(.)/g, "$1");
}
