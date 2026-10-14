// ResourceService:.tres 资源信息读取与无损修改。
//
// 纯逻辑:入参/出参都是文本,不接触文件系统、不加锁、不碰 Runtime —— 落盘与并发由更上层负责。
// 依赖 core/parser:
//   - index.js:parseGodotResource / serializeGodotResource / findGodotResourceSections
//   - internal.js:scanBalance(写入前拒绝会破坏文件的属性值)、findHeaderEnd / skipSpace(段头行区间扫描)
// 格式依据见 src/core/parser/godotResource.ts 顶部的 4.7.2 源码行号:
//   `[ext_resource type="..." uid="..." path="..." id="..."]`(:1939;字段顺序由写入侧决定,解析不依赖顺序)。
import { GodotMcpError } from "../core/errors.js";
import { findHeaderEnd, scanBalance, skipSpace } from "../core/parser/internal.js";
import {
  findGodotResourceSections,
  parseGodotResource,
  serializeGodotResource,
  type GodotResourceAST,
  type GodotResourceProperty,
  type GodotResourceSection,
} from "../core/parser/index.js";
import { literalChange, type LiteralChange } from "../core/parser/literal.js";

/** 外部资源引用(ext_resource 条目)。 */
export interface ExternalResourceRef {
  id: string;
  type: string;
  path: string;
  uid?: string;
}

/** addOrUpdateExternalResource 的写入参数:id 为条目身份,type/path 必填,uid 可选。 */
export interface ExternalResourceInput {
  id: string;
  type: string;
  path: string;
  uid?: string;
}

export interface ResourceProperty {
  name: string;
  value: string;
}

export interface SubResourceInfo {
  id: string;
  type: string;
  properties: ResourceProperty[];
}

export interface ResourceInfo {
  /** 主资源类型([gd_resource type="..."])。 */
  type?: string;
  /** [gd_resource script_class="..."]。 */
  scriptClass?: string;
  format?: number;
  loadSteps?: number;
  uid?: string;
  externalResources: ExternalResourceRef[];
  subResources: SubResourceInfo[];
}

export class ResourceService {
  /** 提取 .tres 头部、外部依赖(ext_resource 列表与 UID)及子资源结构。 */
  getResourceInfo(tresText: string): ResourceInfo {
    const ast = parseGodotResource(tresText);
    const info: ResourceInfo = { externalResources: [], subResources: [] };

    const [header] = findGodotResourceSections(ast, "gd_resource");
    if (header) {
      const type = attrValue(header, "type");
      if (type !== undefined) info.type = type;
      const scriptClass = attrValue(header, "script_class");
      if (scriptClass !== undefined) info.scriptClass = scriptClass;
      const uid = attrValue(header, "uid");
      if (uid !== undefined) info.uid = uid;
      const format = attrValue(header, "format");
      if (format !== undefined && /^\d+$/.test(format)) info.format = Number(format);
      const loadSteps = attrValue(header, "load_steps");
      if (loadSteps !== undefined && /^\d+$/.test(loadSteps)) info.loadSteps = Number(loadSteps);
    }

    for (const section of findGodotResourceSections(ast, "ext_resource")) {
      const id = attrValue(section, "id");
      const type = attrValue(section, "type");
      const path = attrValue(section, "path");
      // 缺 id/type/path 的残缺条目(引擎不产出)跳过,不让单个坏条目挡住整体读取
      if (id === undefined || type === undefined || path === undefined) continue;
      const uid = attrValue(section, "uid");
      info.externalResources.push(uid === undefined ? { id, type, path } : { id, type, path, uid });
    }

    for (const section of findGodotResourceSections(ast, "sub_resource")) {
      const id = attrValue(section, "id");
      if (id === undefined) continue;
      const type = attrValue(section, "type");
      info.subResources.push({
        id,
        type: type ?? "",
        properties: section.body.flatMap((e): ResourceProperty[] =>
          e.kind === "property" ? [{ name: e.name, value: bodyValue(e) }] : []),
      });
    }
    return info;
  }

  /**
   * 修改(属性已存在)或新增(不存在则在段体末尾、尾随空行之前插入)指定 Section 的属性。
   * sectionHeader:"resource" 为主资源段,其余按 sub_resource 的 id 匹配。
   * 返回无损序列化后的文本:除目标行/新增行外,其余字节不变。
   */
  updateResourceProperty(tresText: string, sectionHeader: string, key: string, value: string): string {
    return this.updateResourcePropertyResult(tresText, sectionHeader, key, value).text;
  }

  /**
   * 与 updateResourceProperty 完全相同的写入,额外回报结构化前后值。
   * before/after 都是**文件里的静态字面量**(不是引擎加载后的资源值);
   * 属性原本不在文件中时 before 为 null 且 inFile=false,不伪造引擎默认值。
   */
  updateResourcePropertyResult(
    tresText: string, sectionHeader: string, key: string, value: string,
  ): { text: string; change: LiteralChange } {
    if (key.trim() === "" || /[\s=]/.test(key)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `属性名非法(不得含空白或 '='): ${JSON.stringify(key)}`, { key });
    }
    assertValidValue(key, value);

    const ast = parseGodotResource(tresText);
    const section = findTargetSection(ast, sectionHeader);
    if (section.tag === "sub_resource" && (key === "type" || key === "id")) {
      throw new GodotMcpError("INVALID_ARGUMENT", `"${key}" 是 sub_resource 段头字段,不能作为段体属性写入`, { key });
    }

    const entry = section.body.find((e): e is GodotResourceProperty => e.kind === "property" && e.name === key);
    const beforeRaw = entry === undefined ? null : bodyValue(entry);
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
    return { text: serializeGodotResource(ast), change: literalChange(key, beforeRaw, value) };
  }

  /**
   * 添加或更新外部资源引用:
   *   - 同 id 的 ext_resource → 更新其 type/path(以及提供了的 uid);
   *   - 无同 id 但存在同 path+type 的条目 → 复用该条目(只补 uid,不产生重复;现有 id 为准);
   *   - 都没有 → 新增 ext_resource 段,插在最后一个 ext_resource 之后(没有则紧跟 gd_resource 头之后)。
   */
  addOrUpdateExternalResource(tresText: string, res: ExternalResourceInput): string {
    if (typeof res !== "object" || res === null || typeof res.id !== "string" || typeof res.type !== "string" || typeof res.path !== "string") {
      throw new GodotMcpError("INVALID_ARGUMENT", "外部资源引用需要字符串字段 id / type / path", { res });
    }
    for (const [field, v] of Object.entries(res)) {
      if (v === undefined) continue;
      if (typeof v !== "string" || v === "" || /["\n\r\0]/.test(v)) {
        throw new GodotMcpError("INVALID_ARGUMENT", `外部资源字段非法(非空且不得含引号/换行): ${field}`, { field, value: v });
      }
    }

    const ast = parseGodotResource(tresText);
    const extSections = findGodotResourceSections(ast, "ext_resource");

    let target: GodotResourceSection | undefined;
    let matchedById = false;
    for (const section of extSections) {
      if (attrValue(section, "id") === res.id) { target = section; matchedById = true; break; }
    }
    if (!target) {
      for (const section of extSections) {
        if (attrValue(section, "path") === res.path && attrValue(section, "type") === res.type) { target = section; break; }
      }
    }

    if (target) {
      const updates = new Map<string, string>();
      if (matchedById) {
        updates.set("type", res.type);
        updates.set("path", res.path);
      }
      if (res.uid !== undefined) updates.set("uid", res.uid);
      target.headerRaw = rewriteHeaderAttrs(target.headerRaw, updates); // 只重写该行,其余字节不动
      return serializeGodotResource(ast);
    }

    const at = extInsertIndex(ast);
    const eol = (ast.sections[at - 1] ?? ast.sections[0])!.headerEol;
    const uidPart = res.uid === undefined ? "" : ` uid=${quote(res.uid)}`;
    ast.sections.splice(at, 0, {
      kind: "section",
      tag: "ext_resource",
      tagName: "ext_resource",
      headerRaw: `[ext_resource type=${quote(res.type)}${uidPart} path=${quote(res.path)} id=${quote(res.id)}]`,
      headerEol: eol,
      attributes: [
        { name: "type", value: quote(res.type) },
        ...(res.uid === undefined ? [] : [{ name: "uid", value: quote(res.uid) }]),
        { name: "path", value: quote(res.path) },
        { name: "id", value: quote(res.id) },
      ],
      body: [{ kind: "blank", raw: "", eol }],
    });
    return serializeGodotResource(ast);
  }
}

// ────────────────────────────── 内部工具 ──────────────────────────────

/** 目标段:"resource" 为主资源段;其余按 sub_resource 的 id 匹配。 */
function findTargetSection(ast: GodotResourceAST, sectionHeader: string): GodotResourceSection {
  const header = sectionHeader.trim();
  if (header === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", "sectionHeader 不能为空", { sectionHeader });
  }
  if (header === "resource") {
    const [section] = findGodotResourceSections(ast, "resource");
    if (!section) {
      throw new GodotMcpError("INVALID_ARGUMENT", "文件中没有 [resource] 主资源段", { sectionHeader });
    }
    return section;
  }
  for (const section of findGodotResourceSections(ast, "sub_resource")) {
    if (attrValue(section, "id") === header) return section;
  }
  throw new GodotMcpError("INVALID_ARGUMENT", `找不到子资源: ${sectionHeader}`, { sectionHeader });
}

/** 新 ext_resource 的插入位置:最后一个 ext_resource 之后;没有则紧跟 gd_resource/gd_scene 头段之后。 */
function extInsertIndex(ast: GodotResourceAST): number {
  const gdIndex = ast.sections.findIndex((s) => s.tag === "gd_resource" || s.tag === "gd_scene");
  let at = gdIndex < 0 ? 0 : gdIndex + 1;
  for (let i = at; i < ast.sections.length; i++) {
    if (ast.sections[i]!.tag === "ext_resource") at = i + 1;
  }
  return at;
}

/** 段头行内的属性值区间(value token 的 [start, end))。 */
interface HeaderAttrSpan {
  name: string;
  start: number;
  end: number;
}

/**
 * 段头行内做属性值替换(右起拼接,偏移不失效);未涉及的属性、间距与 `]` 后内容逐字节保留;
 * updates 里不存在于段头的属性追加到 `]` 之前。值一律渲染为带引号字符串。
 */
function rewriteHeaderAttrs(headerRaw: string, updates: Map<string, string>): string {
  if (updates.size === 0) return headerRaw;
  const open = headerRaw.indexOf("[");
  const close = open < 0 ? -1 : findHeaderEnd(headerRaw, open);
  if (close < 0) return headerRaw; // 防御:该行来自已识别的段,不该发生

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
      if (i === nameStart) i++;
      continue;
    }
    i = skipSpace(headerRaw, i + 1);
    const valueStart = i;
    if (headerRaw.charAt(i) === '"') {
      i++;
      while (i < close) {
        const c = headerRaw.charAt(i);
        if (c === "\\") i += 2;
        else if (c === '"') { i++; break; }
        else i++;
      }
    } else {
      while (i < close && !/\s/.test(headerRaw.charAt(i))) i++;
    }
    if (i > valueStart) spans.push({ name, start: valueStart, end: i });
    i = skipSpace(headerRaw, i);
  }

  let out = headerRaw;
  const seen = new Set<string>();
  for (const span of spans.sort((a, b) => b.start - a.start)) {
    const value = updates.get(span.name);
    if (value === undefined) continue;
    seen.add(span.name);
    out = out.slice(0, span.start) + quote(value) + out.slice(span.end);
  }
  const missing = [...updates]
    .filter(([name]) => !seen.has(name))
    .map(([name, value]) => ` ${name}=${quote(value)}`)
    .join("");
  if (missing !== "") out = out.slice(0, close) + missing + out.slice(close);
  return out;
}

/** 渲染为 Godot 段头字符串字面量(转义 `\` 与 `"`)。 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

/** 去掉成对引号并反转义(与解析器的 unquote 同规则;此处仅用于段头/id 这类短文本)。 */
function decodeQuoted(raw: string): string {
  const t = raw.trim();
  if (t.length < 2 || t.charAt(0) !== '"' || t.charAt(t.length - 1) !== '"') return t;
  return t.slice(1, -1).replace(/\\(.)/g, "$1");
}
