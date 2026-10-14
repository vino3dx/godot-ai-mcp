// runtime_check_addon_status 的引擎脚本与纯逻辑。
//
// 引擎端:临时 GDScript 在 headless `--script` 模式下一次回报
//   GDExtensionManager.get_loaded_extensions() / 请求的类是否注册 / 引擎版本;严格不写项目文件。
// Node 端(本模块):.gdextension、.godot/extension_list.cfg、project.godot([editor_plugins])、plugin.cfg 的
//   **文本解析**与 diagnosis 判定,全部是纯函数、不碰文件系统(读盘由 services/runtimeService 负责),便于单测。
//
// 实测结论(真实 Godot 4.6.3 stable,2026-10-14,Windows 本机;探针脚本与原始输出见本次任务报告):
//   1) `GDExtensionManager` 在 `--script` 模式下可用(Engine.has_singleton("GDExtensionManager") 为 true);
//      `get_loaded_extensions()` 返回 **Array[String]**,元素是 `.gdextension` 的 `res://` 路径
//      (实测 dll_bridge 工程得到 "res://addons/dll_bridge/dll_bridge.gdextension";
//       元素 typeof 为 STRING(=4),对其调用 get_class() 报 "Nonexistent function 'get_class' in base 'String'")。
//      → 因此 Node 侧一律按 res:// 路径字符串比对,不做对象身份比对。
//   2) 工程里有 .gdextension 但没有 .godot/extension_list.cfg 时:引擎**不尝试加载**该扩展
//      (loaded 为空,stderr 完全干净、无任何 ERROR);且运行期**不会**补写 extension_list.cfg
//      —— 实测 `--headless --script` 跑完连 .godot/ 目录都不会创建,只有编辑器扫描项目才会写。
//   3) extension_list.cfg 里列出、但库文件不存在时:引擎把 ERROR 打到 **stderr**
//      (open_dynamic_library platform/windows/os_windows.cpp:487 / gdextension.cpp:740 / gdextension_manager.cpp:329),
//      退出码仍是 0,脚本照常回传结果 → loaded 为空,对应 diagnosis `extension_not_loaded`。
//   4) `ClassDB.can_instantiate("NoSuchClass123")` 对不存在的类会打印
//      `ERROR: Cannot get class 'NoSuchClass123'.`(core/object/class_db.cpp:810),
//      所以脚本必须先 `ClassDB.class_exists` 再 `can_instantiate`(已照此实现,实测无多余报错)。
//   5) `--script` 模式**会执行项目 autoload**(实测 autoload 在项目内成功写出文件),
//      所以本工具不是无副作用的只读探针 → 工具的 annotations.readOnly = false。
import { getGodotConfigValue, parseGodotConfigFile, parseGodotLiteral } from "../../core/parser/index.js";
import { splitArrayElements, unquote } from "../../core/parser/internal.js";

/** classes 参数上限(校验器不支持 maxItems,这里显式约束)。 */
export const MAX_ADDON_CHECK_CLASSES = 50;

/**
 * 引擎端探针脚本(GDScript,制表符缩进)。headless 运行,只读:不加载场景、不写任何项目文件。
 * 入参经 `--` 之后的用户参数传入(`--class <Name>` 可出现多次),由 OS.get_cmdline_user_args() 解析。
 */
export const CHECK_ADDON_STATUS_SCRIPT = `extends SceneTree


func _initialize() -> void:
	var wanted: Array = []
	var args := OS.get_cmdline_user_args()
	var i := 0
	while i < args.size():
		var a: String = args[i]
		if a == "--class":
			i += 1
			if i < args.size():
				wanted.append(str(args[i]))
		i += 1

	# 实测 4.6.3:返回 Array[String],元素是 .gdextension 的 res:// 路径(不是 GDExtension 对象)。
	var loaded: Array = []
	for e in GDExtensionManager.get_loaded_extensions():
		loaded.append(str(e))

	var classes: Dictionary = {}
	for n in wanted:
		# 先 class_exists 再 can_instantiate:直接对不存在的类调 can_instantiate 会打印引擎 ERROR。
		if ClassDB.class_exists(n):
			classes[n] = {"exists": true, "can_instantiate": ClassDB.can_instantiate(n)}
		else:
			classes[n] = {"exists": false, "can_instantiate": false}

	var out: Dictionary = {
		"loadedExtensions": loaded,
		"classes": classes,
		"engineVersion": Engine.get_version_info()["string"],
	}
	print("MCP_RESULT_JSON=" + JSON.stringify(out))
	quit(0)
`;

/** 构建探针运行参数:--path <project> --headless --script <临时脚本> -- --class <name>...。 */
export function buildCheckAddonStatusArgs(
  projectDir: string,
  scriptPath: string,
  classes: readonly string[],
): string[] {
  const args = ["--path", projectDir, "--headless", "--script", scriptPath, "--"];
  for (const c of classes) args.push("--class", c);
  return args;
}

// ────────────────────────────── 引擎回传的 payload ──────────────────────────────

export interface AddonClassInfo {
  exists: boolean;
  can_instantiate: boolean;
}

/** 引擎脚本 print 出来的 payload(字段名与 GDScript 输出逐字对应)。 */
export interface AddonStatusPayload {
  /** 已加载扩展的 .gdextension 路径(res:// 开头;实测值形如 res://a/b.gdextension)。 */
  loadedExtensions: string[];
  /** 请求的类名 → 注册信息。 */
  classes: Record<string, AddonClassInfo>;
  engineVersion: string;
}

/** payload 的 JSON 结构自检:形状不符时由调用方转成结构化错误,而不是把脏数据当结果用。 */
export function isAddonStatusPayload(v: unknown): v is AddonStatusPayload {
  if (v === null || typeof v !== "object") return false;
  const p = v as Partial<AddonStatusPayload>;
  if (!Array.isArray(p.loadedExtensions)) return false;
  if (p.loadedExtensions.some((x) => typeof x !== "string")) return false;
  if (typeof p.engineVersion !== "string") return false;
  if (p.classes === null || typeof p.classes !== "object" || Array.isArray(p.classes)) return false;
  for (const info of Object.values(p.classes as Record<string, unknown>)) {
    if (info === null || typeof info !== "object") return false;
    const c = info as Partial<AddonClassInfo>;
    if (typeof c.exists !== "boolean" || typeof c.can_instantiate !== "boolean") return false;
  }
  return true;
}

// ────────────────────────────── 返回结构 ──────────────────────────────

/** .gdextension 的 [libraries] 一条:键名 + 库文件（原文路径） + 本机判定。 */
export interface GdextensionLibraryInfo {
  /** 原始键名,如 "windows.debug.x86_64"。 */
  key: string;
  /** 原文路径(通常 res:// 开头)。 */
  path: string;
  /** 该文件在工程里是否存在。 */
  exists: boolean;
  /** 键名的平台段是否等于本机平台(win32→windows / linux→linux / darwin→macos)。 */
  platformMatch: boolean;
}

export interface AddonExtensionInfo {
  /** .gdextension 文件的 res:// 路径。 */
  path: string;
  /** 引擎是否加载了它;引擎未跑/失败时为 null(未知,不是 false)。 */
  loaded: boolean | null;
  /** .godot/extension_list.cfg 是否列出了它。 */
  listedInExtensionList: boolean;
  entrySymbol?: string;
  compatibilityMinimum?: string;
  libraries: GdextensionLibraryInfo[];
}

export interface AddonPluginInfo {
  /** project.godot [editor_plugins] enabled 里写的 plugin.cfg 的 res:// 路径。 */
  path: string;
  cfgExists: boolean;
  name?: string;
  /** plugin.cfg 的 script 原文(通常相对插件目录)。 */
  script?: string;
  scriptExists: boolean;
}

export interface AddonEngineOk {
  ok: true;
  version: string;
  /** 引擎 stderr 的非空摘要(例如扩展加载失败/脚本报错);stderr 干净时缺省。 */
  stderr?: string;
}

export interface AddonEngineFail {
  ok: false;
  error: { code: string; message: string };
}

/** 引擎部分:找不到 Godot / 超时 / 非零退出 / 回传形状不对 → ok:false(静态部分照常返回)。 */
export type AddonEngine = AddonEngineOk | AddonEngineFail;

export interface AddonStatusResult {
  engine: AddonEngine;
  extensionListFound: boolean;
  extensions: AddonExtensionInfo[];
  /** 引擎成功时是类名 → 注册信息;引擎未跑/失败时为 null(未知,不可据此断言"类不存在")。 */
  classes: Record<string, AddonClassInfo> | null;
  plugins: AddonPluginInfo[];
  diagnosis: string[];
  /** 整个探针的墙钟耗时(静态扫描 + 引擎运行)。 */
  durationMs: number;
}

// ────────────────────────────── 纯解析 ──────────────────────────────

/** .gdextension 里 [libraries] 的一条(尚未做存在性/平台判定)。 */
export interface GdextensionLibraryRef {
  key: string;
  path: string;
}

export interface ParsedGdextension {
  entrySymbol?: string;
  compatibilityMinimum?: string;
  libraries: GdextensionLibraryRef[];
}

/**
 * 解析 .gdextension(ConfigFile 风格:`[configuration]` / `[libraries]`,键值 `key = "value"`)。
 * 解析不出字符串的字段一律省略,不猜(与 core/parser/literal 的口径一致)。
 */
export function parseGdextension(text: string): ParsedGdextension {
  const ast = parseGodotConfigFile(text);
  const out: ParsedGdextension = { libraries: [] };
  const entry = asString(getGodotConfigValue(ast, "configuration", "entry_symbol"));
  if (entry !== undefined) out.entrySymbol = entry;
  const minimum = asString(getGodotConfigValue(ast, "configuration", "compatibility_minimum"));
  if (minimum !== undefined) out.compatibilityMinimum = minimum;

  const libraries = ast.sections.find((s) => s.name === "libraries");
  if (libraries) {
    for (const e of libraries.entries) {
      if (e.kind !== "key") continue;
      const p = asString(e.value);
      if (p !== undefined) out.libraries.push({ key: e.key, path: p });
    }
  }
  return out;
}

/** .godot/extension_list.cfg:一行一个 res:// 路径(`;` 开头视为注释)。 */
export function parseExtensionList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith(";"));
}

/**
 * project.godot `[editor_plugins] enabled` → 已启用插件的 plugin.cfg 路径(按文件里的顺序)。
 * 值形如 `PackedStringArray("res://addons/a/plugin.cfg", "res://addons/b/plugin.cfg")`。
 */
export function parseEnabledPluginPaths(projectText: string): string[] {
  const raw = getGodotConfigValue(parseGodotConfigFile(projectText), "editor_plugins", "enabled");
  if (raw === undefined) return [];
  return splitArrayElements(raw)
    .map((e) => unquote(e))
    .filter((p) => p !== "");
}

/** plugin.cfg 的 [plugin] 段:name / script(script 通常是相对插件目录的路径)。 */
export function parsePluginCfg(text: string): { name?: string; script?: string } {
  const ast = parseGodotConfigFile(text);
  const out: { name?: string; script?: string } = {};
  const name = asString(getGodotConfigValue(ast, "plugin", "name"));
  if (name !== undefined) out.name = name;
  const script = asString(getGodotConfigValue(ast, "plugin", "script"));
  if (script !== undefined) out.script = script;
  return out;
}

/** process.platform → .gdextension [libraries] 的平台段;未知平台返回 null(不做平台判定)。 */
export function platformDirectory(platform: string): string | null {
  switch (platform) {
    case "win32": return "windows";
    case "linux": return "linux";
    case "darwin": return "macos";
    default: return null;
  }
}

/**
 * 库键名的平台段是否匹配本机:取键的第一个 `.` 段与平台目录比较
 * (`windows.debug.x86_64` → "windows")。**只判平台,不判 debug/release 与架构**。
 */
export function isPlatformMatch(libraryKey: string, platform: string): boolean {
  const dir = platformDirectory(platform);
  return dir !== null && libraryKey.split(".")[0] === dir;
}

// ────────────────────────────── diagnosis ──────────────────────────────

export interface DiagnosisInput {
  extensionListFound: boolean;
  /** 已按 path 排序的扩展。 */
  extensions: readonly AddonExtensionInfo[];
  /** 引擎成功时给出的已加载扩展路径;引擎未跑/失败时为 null(此时不判 extension_not_loaded)。 */
  loadedExtensions: readonly string[] | null;
  /** 请求检查的类名(调用方顺序)。 */
  requestedClasses: readonly string[];
  /** 引擎成功时的类结果;引擎未跑/失败时为 null(此时不判 class_missing)。 */
  classResults: Readonly<Record<string, AddonClassInfo>> | null;
  plugins: readonly AddonPluginInfo[];
}

/**
 * 汇总 diagnosis(字符串数组,元素为 `code` 或 `code:detail`)。顺序固定,便于比对:
 *   1. `extension_list_missing`(存在 .gdextension 但没有 .godot/extension_list.cfg)
 *   2. 每个扩展(按 path 升序):`extension_not_listed:<path>` / `extension_not_loaded:<path>` / `library_missing:<path>`
 *   3. 每个请求的类:`class_missing:<Name>`
 *   4. 每个启用的插件:`plugin_files_missing:<path>`
 *
 * 判定口径(与任务卡一致):
 *   - extension_not_listed / extension_not_loaded 只在能判定时给出(后者仅 engine.ok);
 *   - library_missing 仅当**至少有一条 platformMatch 的库**且它们**全部**不存在;
 *   - class_missing 仅在 engine.ok 时判定。
 */
export function computeDiagnosis(input: DiagnosisInput): string[] {
  const out: string[] = [];
  const { extensions, extensionListFound, loadedExtensions, requestedClasses, classResults, plugins } = input;

  if (extensions.length > 0 && !extensionListFound) out.push("extension_list_missing");

  const loaded = loadedExtensions === null ? null : new Set(loadedExtensions);
  for (const ext of extensions) {
    if (extensionListFound) {
      if (!ext.listedInExtensionList) out.push(`extension_not_listed:${ext.path}`);
      else if (loaded !== null && !loaded.has(ext.path)) out.push(`extension_not_loaded:${ext.path}`);
    }
    const platformLibs = ext.libraries.filter((l) => l.platformMatch);
    if (platformLibs.length > 0 && platformLibs.every((l) => !l.exists)) out.push(`library_missing:${ext.path}`);
  }

  if (classResults !== null) {
    for (const name of requestedClasses) {
      if (classResults[name]?.exists !== true) out.push(`class_missing:${name}`);
    }
  }

  for (const p of plugins) {
    if (!p.cfgExists || !p.scriptExists) out.push(`plugin_files_missing:${p.path}`);
  }
  return out;
}

// ────────────────────────────── 内部 ──────────────────────────────

/** 配置项原文 → 字符串(带引号则解引号;裸词取 trim 后的原文);空值返回 undefined。 */
function asString(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseGodotLiteral(raw);
  if (typeof parsed === "string") return parsed;
  const t = raw.trim();
  return t === "" ? undefined : t;
}
