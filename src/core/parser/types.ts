// Godot 文本资源(project.godot / .tscn / .tres)的 AST 类型。此文件零依赖(不 import 任何模块)。
//
// 「无损」的建模约定:每个条目都保留 **原文**(raw / prefix / headerRaw)与 **行尾**(eol)。
// 序列化时直接把原文拼回去,所以未被改动的内容逐字节保持原样;
// 只有消费者显式改写某个 value 字段时,该行才会被重新渲染(其余行不受影响)。
//
// 依据(Godot 4.7.2 源码,不凭记忆):
//   - scene/resources/resource_format_text.cpp
//       :1818 段头 `[gd_scene format=N uid="uid://..."]`;:1998 资源属性 `name = value`;
//       :2024 节点段头 `[node name=... type=... parent=...]`;:2105 connection 字段顺序;
//       :2139 `binds= `(等号后有空格);:2046 `unique_id=N`(无引号)
//   - core/config/project_settings.cpp :1146 _save_settings_text
//       段头 `[name]\n\n`,键值 `key=value\n`(等号两侧无空格)
//   - core/variant/variant_parser.cpp :1891 parse_tag_assign_eof,注释符只有 `;`;
//       :2316 Dictionary 跨行写出 `{\n"k": v,\n...\n}`,:2386 Array 单行 `[a, b]`
//   - core/io/config_file.cpp :191 _internal_save

/** 行尾序列。"" 表示文件末尾没有换行。 */
export type GodotLineEnding = "\n" | "\r\n" | "\r" | "";

// ────────────────────────────── project.godot(INI 风格) ──────────────────────────────

/** 键值行:`key=value`。可能跨多行(如 input map 的 Dictionary)。 */
export interface GodotConfigKeyEntry {
  kind: "key";
  /** 键名(已去掉两侧空白与成对引号,内容已反转义) */
  key: string;
  /** 值原文,可能含换行,不含行尾终止符 */
  value: string;
  /** 从行首到等号(含)的原文,序列化时与 value 拼接 */
  prefix: string;
  eol: GodotLineEnding;
}

/** 原样保留的行:注释(`;` 开头)、空行、无法识别的内容。 */
export interface GodotConfigPassthroughEntry {
  kind: "comment" | "blank" | "raw";
  /** 整行原文,不含行尾 */
  raw: string;
  eol: GodotLineEnding;
}

export type GodotConfigEntry = GodotConfigKeyEntry | GodotConfigPassthroughEntry;

export interface GodotConfigSection {
  kind: "section";
  /** 段名,不含方括号;`\]` 已还原为 `]` */
  name: string;
  /** 段头整行原文(含可能的缩进与尾随 `;` 注释) */
  headerRaw: string;
  headerEol: GodotLineEnding;
  entries: GodotConfigEntry[];
}

export interface GodotConfigAST {
  kind: "godot_config";
  /** 第一个 `[section]` 之前的所有行(文件头注释、config_version=… 等) */
  preamble: GodotConfigEntry[];
  sections: GodotConfigSection[];
  /** 探测到的主导行尾,新增行时使用 */
  newline: string;
}

// ────────────────────────────── .tscn / .tres ──────────────────────────────

/** 已识别的段头标签;未知标签为 "unknown",真实名字见 tagName。 */
export type GodotResourceTag =
  | "gd_scene" | "gd_resource" | "resource" | "ext_resource"
  | "sub_resource" | "node" | "connection" | "editable" | "unknown";

/** 段头内的一个 `name=value`。value 保留原文(含引号)。 */
export interface GodotResourceAttribute {
  name: string;
  value: string;
}

/** 段内属性行:`name = value`(等号两侧各一个空格,见 resource_format_text.cpp:1998)。 */
export interface GodotResourceProperty {
  kind: "property";
  /** 属性名(已去掉两侧空白与成对引号,内容已反转义) */
  name: string;
  /** 值原文,可能跨多行 */
  value: string;
  /** 从行首到等号(含)的原文 */
  prefix: string;
  eol: GodotLineEnding;
}

/** 段内原样保留的行:注释、空行、无法识别的内容。 */
export interface GodotResourcePassthrough {
  kind: "comment" | "blank" | "raw";
  raw: string;
  eol: GodotLineEnding;
}

export type GodotResourceBodyEntry = GodotResourceProperty | GodotResourcePassthrough;

export interface GodotResourceSection {
  kind: "section";
  tag: GodotResourceTag;
  /** 段头标签原文(unknown 时保留真实名字) */
  tagName: string;
  /** 段头整行原文。序列化时原样输出,因此 id / uid 绝不会被改写。 */
  headerRaw: string;
  headerEol: GodotLineEnding;
  /** 段头属性,按出现顺序(如 uid、id、path、type、name、parent…) */
  attributes: GodotResourceAttribute[];
  /** 段内容,按出现顺序(属性行与原样行交织) */
  body: GodotResourceBodyEntry[];
}

export interface GodotResourceAST {
  kind: "godot_resource";
  /** 首个段头之前的行(通常为空;保留以备注释/BOM 后内容) */
  preamble: GodotResourcePassthrough[];
  sections: GodotResourceSection[];
  newline: string;
}

/**
 * `[node ...]` 段的结构化视图(由 getGodotSceneNodes 产出)。
 * 注意:这一层是**只读视图**;写回仍走 section.headerRaw,ID/UID/写法不会被改动。
 */
export interface GodotNodeAST {
  /** `name="..."` 解引号后的值 */
  name: string;
  /** `type="..."`;实例化节点(有 instance=)通常没有 type */
  type?: string;
  /** `parent="..."` */
  parent?: string;
  /** `index="N"` → N(无 index 属性时为 undefined) */
  index?: number;
  /** `unique_id=N` → N */
  uniqueId?: number;
  /** `instance=ExtResource("id")` 原文 */
  instance?: string;
  /** `instance_placeholder="..."` 原文 */
  instancePlaceholder?: string;
  /** `groups=[...]` 解出的组名 */
  groups: string[];
  /** `node_paths=[...]` 解出的元素原文(通常是 NodePath("...")) */
  nodePaths: string[];
  /** 未被上面字段消费的段头属性,原样保留 */
  extraAttributes: GodotResourceAttribute[];
  /** 段内属性行,按顺序 */
  properties: GodotResourceProperty[];
  /** 对应原始段 */
  section: GodotResourceSection;
}
