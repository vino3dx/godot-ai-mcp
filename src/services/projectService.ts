// ProjectService:project.godot 配置的读取与无损修改。
//
// 纯逻辑:入参/出参都是文本,不接触文件系统、不加锁、不碰 Runtime —— 落盘与并发由更上层负责。
// 依赖 core/parser:
//   - index.js:parseGodotConfigFile / serializeGodotConfigFile / getGodotConfigValue
//   - internal.js:scanBalance(写入前拒绝会破坏文件的配置值)
// 格式依据见 src/core/parser/godotConfig.ts 顶部的 4.7.2 源码行号:
//   project_settings.cpp:1146 `[name]\n\n` + `key=value\n`(等号两侧无空格),段与段之间空一行。
import { GodotMcpError } from "../core/errors.js";
import { scanBalance } from "../core/parser/internal.js";
import {
  getGodotConfigValue,
  parseGodotConfigFile,
  serializeGodotConfigFile,
  type GodotConfigAST,
  type GodotConfigEntry,
  type GodotConfigKeyEntry,
  type GodotConfigSection,
  type GodotLineEnding,
} from "../core/parser/index.js";

/** 一个配置键及其原始值文本(未解码、可无损写回)。 */
export interface ProjectConfigValue {
  key: string;
  value: string;
}

/** 一个配置段及其全部键值。 */
export interface ProjectConfigSection {
  name: string;
  values: ProjectConfigValue[];
}

/** project.godot 的结构化视图。 */
export interface ProjectConfig {
  /** 文件头 `config_version=N`(首个段之前);缺失时为 undefined。 */
  configVersion?: number;
  sections: ProjectConfigSection[];
}

export class ProjectService {
  /** 读取整个配置:所有段的键值(值保留原文,含引号与多行)。 */
  getConfig(text: string): ProjectConfig {
    const ast = parseGodotConfigFile(text);
    const config: ProjectConfig = { sections: [] };
    for (const entry of ast.preamble) {
      if (entry.kind === "key" && entry.key === "config_version") {
        const n = Number.parseInt(entry.value.trim(), 10);
        if (!Number.isNaN(n)) config.configVersion = n;
      }
    }
    for (const section of ast.sections) {
      config.sections.push({
        name: section.name,
        values: section.entries.flatMap((e): ProjectConfigValue[] =>
          e.kind === "key" ? [{ key: e.key, value: e.value }] : []),
      });
    }
    return config;
  }

  /** 读取单个键的原始值;段或键不存在返回 undefined。 */
  getConfigValue(text: string, section: string, key: string): string | undefined {
    return getGodotConfigValue(parseGodotConfigFile(text), section, key);
  }

  /**
   * 修改(键已存在)或新增(键不存在则追加到该段;段不存在则新建段)配置项。
   * 返回无损序列化后的文本:除目标行/新增行外,其余字节不变。
   * value 为 Godot 原始表达式(字符串需自带引号,如 `"res://main.tscn"`)。
   */
  setConfigValue(text: string, section: string, key: string, value: string): string {
    assertSectionName(section);
    assertKeyName(key);
    assertValidValue(key, value);

    const ast = parseGodotConfigFile(text);
    const newline = ast.newline as GodotLineEnding;

    const sec = ast.sections.find((s) => s.name === section);
    if (sec) {
      const entry = sec.entries.find((e): e is GodotConfigKeyEntry => e.kind === "key" && e.key === key);
      if (entry) {
        entry.value = value; // 只替换值文本,保留键、等号写法与行尾
      } else {
        sec.entries.splice(insertKeyIndex(sec.entries), 0, makeKeyEntry(key, value, newline));
      }
    } else {
      appendSection(ast, makeSection(section, key, value, newline));
    }
    return serializeGodotConfigFile(ast);
  }
}

// ────────────────────────────── 内部工具 ──────────────────────────────

/** 新键插入点:最后一个键之后;段里还没有键时放到段头后的空行之后(entries[0] 通常是 blank)。 */
function insertKeyIndex(entries: GodotConfigEntry[]): number {
  let lastKey = -1;
  for (let i = 0; i < entries.length; i++) if (entries[i]!.kind === "key") lastKey = i;
  if (lastKey >= 0) return lastKey + 1;
  return entries.length > 0 && entries[0]!.kind === "blank" ? 1 : 0;
}

function makeKeyEntry(key: string, value: string, eol: GodotLineEnding): GodotConfigKeyEntry {
  return { kind: "key", key, value, prefix: `${key}=`, eol };
}

function makeSection(section: string, key: string, value: string, eol: GodotLineEnding): GodotConfigSection {
  return {
    kind: "section",
    name: section,
    headerRaw: `[${section}]`,
    headerEol: eol,
    entries: [
      { kind: "blank", raw: "", eol },
      makeKeyEntry(key, value, eol),
    ],
  };
}

/** 追加新段,并保证与前一个段体(或文件头)之间空一行,对齐 Godot 的 `[name]\n\n` 写法。 */
function appendSection(ast: GodotConfigAST, section: GodotConfigSection): void {
  const newline = ast.newline as GodotLineEnding;
  const target = ast.sections.length > 0
    ? ast.sections[ast.sections.length - 1]!.entries
    : ast.preamble;
  // 已有内容且末尾不是空行时补一个空行;完全空文件则不产生多余的前导空行。
  if (target.length > 0 && target[target.length - 1]!.kind !== "blank") {
    target.push({ kind: "blank", raw: "", eol: newline });
  }
  ast.sections.push(section);
}

/** 段名:非空、不含方括号与换行。 */
function assertSectionName(section: string): void {
  if (typeof section !== "string" || section.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", "section 不能为空", { section });
  }
  if (/[\[\]\r\n]/.test(section)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `段名非法(不得含方括号或换行): ${JSON.stringify(section)}`, { section });
  }
}

/** 键名:非空、不含 '=' 与换行。允许 `/`、`.`、`_`、`-` 等 Godot 配置键常用字符。 */
function assertKeyName(key: string): void {
  if (typeof key !== "string" || key.trim() === "" || key !== key.trim()) {
    throw new GodotMcpError("INVALID_ARGUMENT", `键名非法(非空且不得有首尾空白): ${JSON.stringify(key)}`, { key });
  }
  if (/[=\r\n]/.test(key)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `键名非法(不得含 '=' 或换行): ${JSON.stringify(key)}`, { key });
  }
}

/** 写入前校验:值必须是括号/引号平衡的完整 Godot 表达式,否则拒绝(不产出损坏文件)。 */
function assertValidValue(key: string, value: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", `配置值不能为空: ${key}`, { key, value });
  }
  const balance = scanBalance(value, 0);
  if (balance.depth !== 0 || balance.inString) {
    throw new GodotMcpError("INVALID_ARGUMENT", `配置值不是合法的 Godot 表达式(括号或引号不平衡): ${key}`, { key, value });
  }
}
