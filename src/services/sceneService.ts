// SceneService:.tscn 场景树的结构化读取与无损修改。
//
// 纯逻辑:入参/出参都是文本,不接触文件系统、不加锁、不碰 Runtime —— 落盘与并发由更上层负责。
// 依赖 core/parser:
//   - index.js:parseGodotResource / serializeGodotResource / findGodotResourceSections / getGodotSceneNodes
//   - internal.js:scanBalance(写入前拒绝会破坏文件的属性值;括号/引号平衡语义的唯一实现处)
// 格式依据见 src/core/parser/godotResource.ts 与 types.ts 顶部的 4.7.2 源码行号(段头属性、`name = value`)。
import { GodotMcpError } from "../core/errors.js";
import { findHeaderEnd, scanBalance, skipSpace, splitArrayElements, unquote } from "../core/parser/internal.js";
import {
  findGodotResourceSections,
  getGodotSceneNodes,
  parseGodotResource,
  serializeGodotResource,
  type GodotLineEnding,
  type GodotNodeAST,
  type GodotResourceAST,
  type GodotResourceAttribute,
  type GodotResourceBodyEntry,
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

/** scene_add_node 的入参。 */
export interface AddNodeOptions {
  /** 父节点路径;根为 "."(或 "/root")。 */
  parentPath: string;
  /** 节点类型(ClassDB 类名);本层仅做静态写法校验,不查 ClassDB。 */
  nodeType: string;
  /** 新节点名。 */
  nodeName: string;
  /** 段体属性(name / value 原文);属性名不得是 `[node]` 段头字段。 */
  properties?: ReadonlyArray<{ name: string; value: string }>;
  /** 父节点下已存在同名节点时:true 自动追加数字后缀,false(默认)报错。 */
  autoRename?: boolean;
}

export interface AddNodeResult {
  /** 无损序列化后的新文本。 */
  text: string;
  /** 新节点最终路径(autoRename 触发时与请求名不同)。 */
  nodePath: string;
  name: string;
}

/** scene_reparent_node 的入参。 */
export interface ReparentNodeOptions {
  nodePath: string;
  newParentPath: string;
  /** true 需要引擎计算全局变换,文本级实现不支持(会抛 INVALID_ARGUMENT)。 */
  keepGlobalTransform?: boolean;
}

export interface ReparentNodeResult {
  text: string;
  /** 移动后的新路径。 */
  nodePath: string;
  /** 实际被改写的节点数(目标及其子孙)。 */
  movedNodes: number;
}

/** 分组写操作的入参(scene_add_to_group / scene_remove_from_group 共用)。 */
export interface GroupOptions {
  nodePath: string;
  group: string;
}

export interface AddToGroupResult {
  text: string;
  /** false = 该节点已在组内(未改动文本)。 */
  added: boolean;
  groups: string[];
}

export interface RemoveFromGroupResult {
  text: string;
  /** false = 该节点本就不在组内(未改动文本)。 */
  removed: boolean;
  groups: string[];
}

/** scene_instantiate_scene 的入参。 */
export interface InstantiateSceneOptions {
  /** 当前场景自身的 res:// 路径(仅用于循环实例化检测)。 */
  sceneResPath: string;
  parentPath: string;
  /** 被实例化的场景路径(res:// 或项目相对路径)。 */
  instanceScenePath: string;
  /** 被实例化场景的根节点类型(读自目标文件);未知时省略 `type=`。 */
  instanceRootType?: string;
  /** 被实例化场景的根节点名(缺省节点名取它)。 */
  instanceRootName?: string;
  nodeName?: string;
}

export interface InstantiateSceneResult {
  text: string;
  nodePath: string;
  name: string;
  /** 写入/复用的 ext_resource id。 */
  instanceId: string;
  /** 归一化后的 res:// 路径。 */
  instancePath: string;
}

/** scene_connect_signal / scene_disconnect_signal 的入参。 */
export interface ConnectSignalOptions {
  sourcePath: string;
  signal: string;
  targetPath: string;
  method: string;
  /** 位掩码:CONNECT_DEFERRED=1 / CONNECT_PERSIST=2 / CONNECT_ONE_SHOT=4;0 或缺省时不写 `flags=`。 */
  flags?: number;
}

export interface ConnectSignalResult {
  text: string;
  /** 落盘的 flags(缺省 0)。 */
  flags: number;
}

export interface DisconnectSignalResult {
  text: string;
  /** false = 没有匹配的连接(未改动文本)。 */
  removed: boolean;
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
    assertPropertyEntry(key, value);

    const ast = parseGodotResource(tscnText);
    const section = requireNodeSection(ast, nodePath, "nodePath");
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

  // ────────────────── 写侧(T6):新增 / 移动 / 分组 / 实例化 / 信号 ──────────────────

  /**
   * 新增节点:在 parentPath 的子树之后插入 `[node ...]` 段(保持文件里的深度优先顺序)。
   * nodeType 只做静态写法校验(合法类名),不查 ClassDB —— 本层不依赖引擎(runtimeRequired:false)。
   */
  addNode(tscnText: string, o: AddNodeOptions): AddNodeResult {
    const type = assertClassName(o.nodeType, "nodeType");
    const requested = assertNodeName(o.nodeName, "nodeName");
    const ast = parseGodotResource(tscnText);
    const parent = normalizeNodePath(o.parentPath, "parentPath");
    requireNodeSection(ast, parent, "parentPath");
    const siblings = childNamesOf(ast, parent);

    let name = requested;
    if (siblings.includes(name)) {
      if (o.autoRename !== true) {
        throw new GodotMcpError("INVALID_ARGUMENT", `父节点下已存在同名节点: ${name}(可传 autoRename=true 自动改名)`, {
          nodeName: requested, parentPath: o.parentPath, siblings,
        });
      }
      name = uniqueSiblingName(requested, siblings);
    }

    const eol = newlineOf(ast);
    const properties = (o.properties ?? []).map((p) => assertPropertyEntry(p.name, p.value));
    const section = renderNodeSection({ name, parentAttr: parent, type, eol, properties });
    ast.sections.splice(subtreeEndIndex(ast, parent) + 1, 0, section);
    return { text: serializeGodotResource(ast), nodePath: joinNodePath(parent, name), name };
  }

  /**
   * 移动节点:目标及其全部子孙的 `parent` 路径前缀一并改写,整棵子树段搬到新父节点的子树之后
   * (保持深度优先顺序);段头里已有的 `owner` 若落在被移动的子树内也同步改写。
   */
  reparentNode(tscnText: string, o: ReparentNodeOptions): ReparentNodeResult {
    if (o.keepGlobalTransform === true) {
      throw new GodotMcpError(
        "INVALID_ARGUMENT",
        "keepGlobalTransform=true 需要引擎计算全局变换,文本级实现不支持;请省略或传 false(注意:移动后节点的全局变换可能改变)",
        { param: "keepGlobalTransform" },
      );
    }
    const target = normalizeNodePath(o.nodePath, "nodePath");
    if (target === ROOT) {
      throw new GodotMcpError("INVALID_ARGUMENT", "不能移动场景根节点(根节点没有父节点)", { nodePath: o.nodePath });
    }
    const newParent = normalizeNodePath(o.newParentPath, "newParentPath");
    const ast = parseGodotResource(tscnText);
    const targetSection = requireNodeSection(ast, target, "nodePath");
    if (newParent === target || newParent.startsWith(`${target}/`)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `不能把节点移动到自身或自己的子孙之下: ${target} -> ${newParent}`, {
        param: "newParentPath", nodePath: target, newParentPath: newParent,
      });
    }
    const newParentSection = requireNodeSection(ast, newParent, "newParentPath");
    const name = attrValue(targetSection, "name");
    if (name === undefined) {
      throw new GodotMcpError("PARSE_ERROR", `节点段缺少 name 属性: ${target}`, { nodePath: target });
    }
    const destPath = joinNodePath(newParent, name);
    if (immediateParentOf(targetSection) === newParent) {
      // 已在新父节点下:不改动(否则会把该子树重排到兄弟末尾,产生无意义的 diff)
      return { text: tscnText, nodePath: destPath, movedNodes: 0 };
    }

    const subtree = ast.sections.filter((s) => isInNodeSubtree(s, target));
    for (const section of subtree) {
      const parentRaw = attrValue(section, "parent");
      if (parentRaw !== undefined) {
        const next = section === targetSection ? newParent : mapPathPrefix(parentRaw, target, destPath);
        section.headerRaw = setHeaderAttr(section.headerRaw, "parent", quote(next));
      }
      const ownerRaw = attrValue(section, "owner");
      if (ownerRaw !== undefined) {
        const next = mapPathPrefix(ownerRaw, target, destPath);
        if (next !== ownerRaw) section.headerRaw = setHeaderAttr(section.headerRaw, "owner", quote(next));
      }
    }

    const moved = new Set(subtree);
    const rest = ast.sections.filter((s) => !moved.has(s));
    const parentIndex = rest.indexOf(newParentSection);
    let at = parentIndex + 1;
    for (let i = parentIndex + 1; i < rest.length; i++) {
      const s = rest[i]!;
      if (s.tag !== "node") continue;
      const p = nodeSectionPath(s);
      if (p !== undefined && (newParent === ROOT || p.startsWith(`${newParent}/`))) at = i + 1;
    }
    ast.sections = [...rest.slice(0, at), ...subtree, ...rest.slice(at)];
    return { text: serializeGodotResource(ast), nodePath: destPath, movedNodes: subtree.length };
  }

  /** 把节点加入组(已在组内则原样返回,不报错)。 */
  addToGroup(tscnText: string, o: GroupOptions): AddToGroupResult {
    const group = assertGroupName(o.group);
    const ast = parseGodotResource(tscnText);
    const section = requireNodeSection(ast, o.nodePath, "nodePath");
    const groups = groupsOf(section);
    if (groups.includes(group)) return { text: tscnText, added: false, groups };
    const next = [...groups, group];
    section.headerRaw = setHeaderAttr(section.headerRaw, "groups", renderStringArray(next));
    return { text: serializeGodotResource(ast), added: true, groups: next };
  }

  /** 把节点移出组(不在组内则原样返回,不报错);组清空时删除整个 `groups=` 属性。 */
  removeFromGroup(tscnText: string, o: GroupOptions): RemoveFromGroupResult {
    const group = assertGroupName(o.group);
    const ast = parseGodotResource(tscnText);
    const section = requireNodeSection(ast, o.nodePath, "nodePath");
    const groups = groupsOf(section);
    if (!groups.includes(group)) return { text: tscnText, removed: false, groups };
    const next = groups.filter((g) => g !== group);
    section.headerRaw = setHeaderAttr(section.headerRaw, "groups", next.length === 0 ? undefined : renderStringArray(next));
    return { text: serializeGodotResource(ast), removed: true, groups: next };
  }

  /**
   * 实例化子场景:写入 `[ext_resource type="PackedScene" ...]` + `[node ... instance=ExtResource("id")]`,
   * **不展开**子场景的子节点;同 path 的 ext_resource 已存在时复用(引擎同一 path 只写一条)。
   */
  instantiateScene(tscnText: string, o: InstantiateSceneOptions): InstantiateSceneResult {
    const resPath = toResPath(assertNonEmpty(o.instanceScenePath, "instanceScenePath"));
    if (resPath === toResPath(assertNonEmpty(o.sceneResPath, "sceneResPath"))) {
      throw new GodotMcpError("INVALID_ARGUMENT", `不能把场景实例化到自己内部(循环实例化): ${resPath}`, {
        param: "instanceScenePath", scenePath: o.sceneResPath, instanceScenePath: o.instanceScenePath,
      });
    }
    const ast = parseGodotResource(tscnText);
    const parent = normalizeNodePath(o.parentPath, "parentPath");
    requireNodeSection(ast, parent, "parentPath");

    const requested = o.nodeName ?? o.instanceRootName ?? baseNameOf(resPath);
    const name = assertNodeName(requested, o.nodeName === undefined ? "nodeName(缺省取自被实例化场景)" : "nodeName");
    const siblings = childNamesOf(ast, parent);
    if (siblings.includes(name)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `父节点下已存在同名节点: ${name}(实例化不支持自动改名,请传 nodeName)`, {
        nodeName: name, parentPath: o.parentPath, siblings,
      });
    }

    const instanceId = ensurePackedSceneExtResource(ast, resPath);
    const eol = newlineOf(ast);
    const section = renderNodeSection({
      name, parentAttr: parent, type: o.instanceRootType, instanceRef: `ExtResource(${quote(instanceId)})`, eol, properties: [],
    });
    ast.sections.splice(subtreeEndIndex(ast, parent) + 1, 0, section);
    return { text: serializeGodotResource(ast), nodePath: joinNodePath(parent, name), name, instanceId, instancePath: resPath };
  }

  /** 连接信号:写入 `[connection ...]` 段(随场景文件持久化)。同一 source/signal/target/method 重复连接报错。 */
  connectSignal(tscnText: string, o: ConnectSignalOptions): ConnectSignalResult {
    const signal = assertIdentifier(o.signal, "signal");
    const method = assertIdentifier(o.method, "method");
    const flags = assertFlags(o.flags);
    const ast = parseGodotResource(tscnText);
    const from = normalizeNodePath(o.sourcePath, "sourcePath");
    const to = normalizeNodePath(o.targetPath, "targetPath");
    requireNodeSection(ast, from, "sourcePath");
    requireNodeSection(ast, to, "targetPath");
    if (findConnection(ast, signal, from, to, method)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `连接已存在(重复连接): ${describeConnection(signal, from, to, method)}`, {
        signal, from, to, method,
      });
    }
    const eol = newlineOf(ast);
    // flags=0 时不写该属性,与 tests/fixtures 里引擎写出的 connection 段一致(该行为未经 4.6.3 实测)
    const attributes: GodotResourceAttribute[] = [
      { name: "signal", value: quote(signal) },
      { name: "from", value: quote(from) },
      { name: "to", value: quote(to) },
      { name: "method", value: quote(method) },
      ...(flags === 0 ? [] : [{ name: "flags", value: String(flags) }]),
    ];
    ast.sections.splice(connectionInsertIndex(ast), 0, {
      kind: "section",
      tag: "connection",
      tagName: "connection",
      headerRaw: headerLine("connection", attributes),
      headerEol: eol,
      attributes,
      body: [{ kind: "blank", raw: "", eol }],
    });
    return { text: serializeGodotResource(ast), flags };
  }

  /** 断开信号:删除匹配的 `[connection ...]` 段;没有该连接时原样返回(removed=false,不报错)。 */
  disconnectSignal(tscnText: string, o: ConnectSignalOptions): DisconnectSignalResult {
    const signal = assertIdentifier(o.signal, "signal");
    const method = assertIdentifier(o.method, "method");
    const ast = parseGodotResource(tscnText);
    const from = normalizeNodePath(o.sourcePath, "sourcePath");
    const to = normalizeNodePath(o.targetPath, "targetPath");
    const doomed = findConnection(ast, signal, from, to, method);
    if (!doomed) return { text: tscnText, removed: false };
    ast.sections = ast.sections.filter((s) => s !== doomed);
    return { text: serializeGodotResource(ast), removed: true };
  }
}

// ────────────────────────────── 内部工具 ──────────────────────────────

/** 规范化节点路径:根为 ".",其余为相对场景根的 `/` 分隔路径。接受 ".", "/root", "/root/A/B", "A/B", "./A"。 */
function normalizeNodePath(input: string, param = "nodePath"): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 不能为空`, { param, value: input });
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

/** 段的直接父节点路径;undefined 表示该段是场景根节点(无 `parent` 属性)。 */
function immediateParentOf(section: GodotResourceSection): string | undefined {
  return attrValue(section, "parent");
}

function joinNodePath(parent: string, name: string): string {
  return parent === ROOT ? name : `${parent}/${name}`;
}

/** 按路径取节点段;不存在(或没有根节点)抛 INVALID_ARGUMENT,并注明是哪个参数错的。 */
function requireNodeSection(ast: GodotResourceAST, path: string, param: string): GodotResourceSection {
  const target = normalizeNodePath(path, param);
  for (const section of findGodotResourceSections(ast, "node")) {
    if (nodeSectionPath(section) === target) return section;
  }
  if (target === ROOT) {
    throw new GodotMcpError("INVALID_ARGUMENT", `场景没有根节点(缺少不带 parent 的 [node] 段): ${param}`, { param, nodePath: path });
  }
  throw new GodotMcpError("INVALID_ARGUMENT", `${param} 指向的节点不存在: ${path}`, { param, nodePath: path, normalized: target });
}

function isInNodeSubtree(section: GodotResourceSection, rootPath: string): boolean {
  if (section.tag !== "node") return false;
  const p = nodeSectionPath(section);
  return p !== undefined && (p === rootPath || p.startsWith(`${rootPath}/`));
}

/** parent 子树里最后一个节点段的索引(parent 自身也算);找不到返回 -1。 */
function subtreeEndIndex(ast: GodotResourceAST, parent: string): number {
  let at = -1;
  ast.sections.forEach((section, i) => {
    if (section.tag !== "node") return;
    const p = nodeSectionPath(section);
    if (p === undefined) return;
    if (parent === ROOT || p === parent || p.startsWith(`${parent}/`)) at = i;
  });
  return at;
}

/** parent 下直接子节点的名字列表。 */
function childNamesOf(ast: GodotResourceAST, parent: string): string[] {
  const out: string[] = [];
  for (const section of findGodotResourceSections(ast, "node")) {
    if (immediateParentOf(section) !== parent) continue;
    const name = attrValue(section, "name");
    if (name !== undefined) out.push(name);
  }
  return out;
}

/** 重名时的自动改名:追加数字后缀。写法未经 4.6.3 实测,只保证同父不重名。 */
function uniqueSiblingName(base: string, taken: readonly string[]): string {
  for (let i = 2; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** 路径前缀改写:`from` → `to`,`from/...` → `to/...`,其余原样。 */
function mapPathPrefix(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

function newlineOf(ast: GodotResourceAST): GodotLineEnding {
  return ast.newline as GodotLineEnding;
}

/** 由属性列表渲染段头行 `[tag a=b c=d]`(值需已渲染好)。 */
function headerLine(tag: string, attributes: readonly GodotResourceAttribute[]): string {
  return `[${tag}${attributes.map((a) => ` ${a.name}=${a.value}`).join("")}]`;
}

/** 新 `[node]` 段的渲染参数。 */
interface NewNodeSectionOptions {
  name: string;
  /** `parent=` 的值:根的直接子节点为 "."。 */
  parentAttr: string;
  type?: string;
  /** `instance=ExtResource("id")` 的原文(实例化节点用);不展开子场景。 */
  instanceRef?: string;
  properties: ReadonlyArray<{ name: string; value: string }>;
  eol: GodotLineEnding;
}

/** 渲染 `[node ...]` 段(段体属性 + 尾随空行)。 */
function renderNodeSection(o: NewNodeSectionOptions): GodotResourceSection {
  const attributes: GodotResourceAttribute[] = [
    { name: "name", value: quote(o.name) },
    ...(o.type === undefined ? [] : [{ name: "type", value: quote(o.type) }]),
    { name: "parent", value: quote(o.parentAttr) },
    ...(o.instanceRef === undefined ? [] : [{ name: "instance", value: o.instanceRef }]),
  ];
  const body: GodotResourceBodyEntry[] = o.properties.map((p) => ({
    kind: "property", name: p.name, prefix: `${p.name} =`, value: ` ${p.value}`, eol: o.eol,
  }));
  body.push({ kind: "blank", raw: "", eol: o.eol });
  return {
    kind: "section",
    tag: "node",
    tagName: "node",
    headerRaw: headerLine("node", attributes),
    headerEol: o.eol,
    attributes,
    body,
  };
}

/** 节点名合法性:非空、无首尾空白、不含 Godot 保留字符(`Node::set_name` 禁止 `. / : @ %`)。 */
function assertNodeName(value: unknown, param: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 不能为空`, { param, value });
  }
  if (value !== value.trim()) {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 不得有首尾空白: ${JSON.stringify(value)}`, { param, value });
  }
  if (/[./:@%"\\\n\r\0]/.test(value)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 含非法字符(不得含 . / : @ % " 或反斜杠): ${JSON.stringify(value)}`, { param, value });
  }
  return value;
}

/**
 * 节点类型的**静态**校验:只检查写法像合法类名(标识符),不查 ClassDB。
 * 「是否是可实例化的 Node 派生类」需要引擎,留给后续 runtime 类工具;此处不猜。
 */
function assertClassName(value: unknown, param: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_]\w*$/.test(value)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 必须是合法的 Godot 类名(标识符): ${JSON.stringify(value)}(仅静态校验,未查 ClassDB)`, { param, value });
  }
  return value;
}

/** 信号名 / 方法名的静态校验(Godot 标识符)。 */
function assertIdentifier(value: unknown, param: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_]\w*$/.test(value)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 必须是合法的 Godot 标识符: ${JSON.stringify(value)}`, { param, value });
  }
  return value;
}

/** flags 位掩码:CONNECT_DEFERRED=1 / CONNECT_PERSIST=2 / CONNECT_ONE_SHOT=4。 */
function assertFlags(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new GodotMcpError("INVALID_ARGUMENT", `flags 必须是非负整数位掩码(DEFERRED=1, PERSIST=2, ONE_SHOT=4): ${JSON.stringify(value)}`, { param: "flags", value });
  }
  return value;
}

/** 组名:非空、无首尾空白、不含换行(引号与反斜杠会被转义)。 */
function assertGroupName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", "group 不能为空", { param: "group", value });
  }
  if (value !== value.trim() || /[\n\r\0]/.test(value)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `group 不得有首尾空白或换行: ${JSON.stringify(value)}`, { param: "group", value });
  }
  return value;
}

function assertNonEmpty(value: unknown, param: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 不能为空`, { param, value });
  }
  return value.trim();
}

/** 渲染为段头字符串字面量(转义 `\` 与 `"`)。 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 段头行内一个属性的区间:nameStart 是属性名起点,start/end 是值 token 的区间。 */
interface HeaderAttrSpan { name: string; nameStart: number; start: number; end: number }

/** 段头行内的全部 `name=value` 区间;无法定位段头时 close 为 -1。 */
function headerAttrSpans(headerRaw: string): { spans: HeaderAttrSpan[]; close: number } {
  const open = headerRaw.indexOf("[");
  if (open < 0) return { spans: [], close: -1 };
  const close = findHeaderEnd(headerRaw, open);
  if (close < 0) return { spans: [], close: -1 };

  const spans: HeaderAttrSpan[] = [];
  let i = skipSpace(headerRaw, open + 1);
  while (i < close && !/[\s=]/.test(headerRaw.charAt(i))) i++; // 跳过 tag
  i = skipSpace(headerRaw, i);
  while (i < close) {
    const nameStart = i;
    while (i < close && !/[\s=]/.test(headerRaw.charAt(i))) i++;
    const name = headerRaw.slice(nameStart, i);
    i = skipSpace(headerRaw, i);
    if (name === "" || headerRaw.charAt(i) !== "=") {
      if (i <= nameStart) i++;
      continue;
    }
    i = skipSpace(headerRaw, i + 1);
    const valueStart = i;
    i = scanHeaderValueEnd(headerRaw, i, close);
    if (i > valueStart) spans.push({ name, nameStart, start: valueStart, end: i });
    i = skipSpace(headerRaw, i);
  }
  return { spans, close };
}

/** 段头里一个属性值的结束位置:字符串到闭引号、括号块到配对闭合、裸值到空白。 */
function scanHeaderValueEnd(text: string, from: number, limit: number): number {
  const first = text.charAt(from);
  if (first === '"') {
    let i = from + 1;
    while (i < limit) {
      const c = text.charAt(i);
      if (c === "\\") i += 2;
      else if (c === '"') return i + 1;
      else i++;
    }
    return limit;
  }
  if (first === "[" || first === "{" || first === "(") {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = from; i < limit; i++) {
      const c = text.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === "[" || c === "{" || c === "(") depth++;
      else if (c === "]" || c === "}" || c === ")") { depth--; if (depth === 0) return i + 1; }
    }
    return limit;
  }
  let i = from;
  while (i < limit && !/\s/.test(text.charAt(i))) i++;
  return i;
}

/**
 * 改写段头里的单个属性:renderedValue 传 undefined 表示删除该属性,
 * 传字符串表示设置(调用方负责已渲染:字符串需自带引号)。其余字节逐字节保留。
 */
function setHeaderAttr(headerRaw: string, name: string, renderedValue: string | undefined): string {
  const { spans, close } = headerAttrSpans(headerRaw);
  if (close < 0) return headerRaw; // 防御:该行来自已识别的段,不该发生
  const target = spans.find((s) => s.name === name);
  if (renderedValue === undefined) {
    if (!target) return headerRaw;
    // 删除整个 `name=value`(含属性名前的空白),只留值会把 `name=` 变成孤儿
    let from = target.nameStart;
    while (from > 0 && /[ \t]/.test(headerRaw.charAt(from - 1))) from--;
    return headerRaw.slice(0, from) + headerRaw.slice(target.end);
  }
  if (target) return headerRaw.slice(0, target.start) + renderedValue + headerRaw.slice(target.end);
  return headerRaw.slice(0, close) + ` ${name}=${renderedValue}` + headerRaw.slice(close);
}

/** 节点当前的组列表(与 getGodotSceneNodes 相同的解析规则)。 */
function groupsOf(section: GodotResourceSection): string[] {
  const raw = section.attributes.find((a) => a.name === "groups")?.value;
  return raw === undefined ? [] : splitArrayElements(raw).map(unquote);
}

/** Godot Array 的单行写法 `["a", "b"]`;`groups=` 的真实样例本仓库暂无,分隔符未经 4.6.3 实测。 */
function renderStringArray(values: readonly string[]): string {
  return `[${values.map(quote).join(", ")}]`;
}

/** 归一化为 `res://` 形式(纯字符串处理,不解析项目根,也不查文件系统)。 */
function toResPath(path: string): string {
  const rel = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^res:\/\//, "")
    .replace(/^\/+/, "")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
  return `res://${rel}`;
}

/** `res://scenes/child.tscn` → `child`(缺省节点名兜底用)。 */
function baseNameOf(resPath: string): string {
  const file = resPath.slice(resPath.lastIndexOf("/") + 1);
  return file.replace(/\.[^.]*$/, "") || file;
}

/** 新 ext_resource 的插入位置:最后一个 ext_resource 之后;没有则紧跟 gd_scene/gd_resource 头段之后。 */
function extInsertIndex(ast: GodotResourceAST): number {
  const header = ast.sections.findIndex((s) => s.tag === "gd_scene" || s.tag === "gd_resource");
  let at = header < 0 ? 0 : header + 1;
  for (let i = at; i < ast.sections.length; i++) {
    if (ast.sections[i]!.tag === "ext_resource") at = i + 1;
  }
  return at;
}

/** 新 ext_resource 的 id:形如 `2_mcp`;引擎只把它当 key(命名风格未经 4.6.3 实测)。 */
function uniqueExtId(ast: GodotResourceAST): string {
  const used = new Set(
    findGodotResourceSections(ast, "ext_resource")
      .map((s) => attrValue(s, "id"))
      .filter((v): v is string => v !== undefined),
  );
  for (let n = used.size + 1; ; n++) {
    const id = `${n}_mcp`;
    if (!used.has(id)) return id;
  }
}

/**
 * 取/建 PackedScene 的 ext_resource:同 path 已存在则复用其 id(引擎同一 path 只写一条)。
 * 不写 `uid=`:4.6.3 运行时 ResourceSaver 也不写(见 tests/fixtures/SOURCE.md),引擎按 path 解析。
 */
function ensurePackedSceneExtResource(ast: GodotResourceAST, resPath: string): string {
  for (const section of findGodotResourceSections(ast, "ext_resource")) {
    const id = attrValue(section, "id");
    const path = attrValue(section, "path");
    if (id !== undefined && path !== undefined && toResPath(path) === resPath) return id;
  }
  const id = uniqueExtId(ast);
  const eol = newlineOf(ast);
  const attributes: GodotResourceAttribute[] = [
    { name: "type", value: quote("PackedScene") },
    { name: "path", value: quote(resPath) },
    { name: "id", value: quote(id) },
  ];
  ast.sections.splice(extInsertIndex(ast), 0, {
    kind: "section",
    tag: "ext_resource",
    tagName: "ext_resource",
    headerRaw: headerLine("ext_resource", attributes),
    headerEol: eol,
    attributes,
    body: [{ kind: "blank", raw: "", eol }],
  });
  return id;
}

/** 匹配 signal/from/to/method 四要素的连接段;没有则 undefined。 */
function findConnection(
  ast: GodotResourceAST, signal: string, from: string, to: string, method: string,
): GodotResourceSection | undefined {
  return findGodotResourceSections(ast, "connection").find(
    (s) => attrValue(s, "signal") === signal && attrValue(s, "from") === from
      && attrValue(s, "to") === to && attrValue(s, "method") === method,
  );
}

function describeConnection(signal: string, from: string, to: string, method: string): string {
  return `${from === ROOT ? "场景根" : from}.${signal} -> ${to === ROOT ? "场景根" : to}.${method}`;
}

/** 新 connection 的插入位置:最后一个 connection/node 段之后,但不越过 `[editable]` 段。 */
function connectionInsertIndex(ast: GodotResourceAST): number {
  const header = ast.sections.findIndex((s) => s.tag === "gd_scene" || s.tag === "gd_resource");
  let at = header < 0 ? 0 : header + 1;
  for (let i = at; i < ast.sections.length; i++) {
    const tag = ast.sections[i]!.tag;
    if (tag === "editable") break;
    if (tag === "ext_resource" || tag === "sub_resource" || tag === "node" || tag === "connection") at = i + 1;
  }
  return at;
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

/** 段体属性名校验:非空、不含空白/`=`、不是 `[node]` 段头字段。 */
function assertPropertyName(key: unknown): string {
  if (typeof key !== "string" || key.trim() === "" || /[\s=]/.test(key)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `属性名非法(不得含空白或 '='): ${JSON.stringify(key)}`, { key });
  }
  if (NODE_HEADER_ATTRS.has(key)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `"${key}" 是节点段头字段,不能作为段体属性写入`, { key });
  }
  return key;
}

/** 段体属性名校验 + 值校验;用于写入前的统一把关。 */
function assertPropertyEntry(key: unknown, value: string): { name: string; value: string } {
  const name = assertPropertyName(key);
  assertValidValue(name, value);
  return { name, value };
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
