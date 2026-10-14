// P4:runtime_check_addon_status 的单元测试(全部不依赖真实 Godot)。
// 分三层:
//   1) godot 层纯函数:.gdextension / extension_list.cfg / project.godot / plugin.cfg 的文本解析、平台判定、diagnosis 规则;
//   2) 服务层静态扫描(注入 runner 替身 + 临时工程目录):.gdextension 收集、库存在性、插件文件存在性;
//   3) 服务层合并逻辑(替身伪造引擎回传):loaded / classes / engine.stderr / 引擎失败时的 null 语义。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { GodotCliService } from "../src/services/godotCli.js";
import { RuntimeService, type CheckAddonStatusOptions } from "../src/services/runtimeService.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { runtimeCheckAddonStatus } from "../src/tools/runtime/checkAddonStatus.js";
import {
  buildCheckAddonStatusArgs,
  computeDiagnosis,
  isAddonStatusPayload,
  isPlatformMatch,
  parseEnabledPluginPaths,
  parseExtensionList,
  parseGdextension,
  parsePluginCfg,
  platformDirectory,
  type AddonExtensionInfo,
  type AddonPluginInfo,
} from "../src/godot/runtime/checkAddonStatus.js";
import { defaultRunRunner, type GodotRunRunner, type RunProcessResult } from "../src/godot/runtime/run.js";
import type { AppContext } from "../src/services/context.js";

const quiet = createLogger("error", () => {});

// ────────────────────────────── 1) 纯解析 ──────────────────────────────

test("parseGdextension: 读出 entry_symbol / compatibility_minimum / [libraries] 全部条目", () => {
  const parsed = parseGdextension([
    '; 注释行',
    '[configuration]',
    '',
    'entry_symbol = "fake_library_init"',
    'compatibility_minimum = "4.6"',
    '',
    '[libraries]',
    '',
    'windows.debug.x86_64 = "res://bin/nope.dll"',
    'linux.release.x86_64 = "res://bin/nope.so"',
    '',
  ].join("\n"));
  assert.equal(parsed.entrySymbol, "fake_library_init");
  assert.equal(parsed.compatibilityMinimum, "4.6");
  assert.deepEqual(parsed.libraries, [
    { key: "windows.debug.x86_64", path: "res://bin/nope.dll" },
    { key: "linux.release.x86_64", path: "res://bin/nope.so" },
  ]);
});

test("parseGdextension: 缺字段时不猜(省略而不是填空)", () => {
  const parsed = parseGdextension("[configuration]\n\n[libraries]\n");
  assert.equal(parsed.entrySymbol, undefined);
  assert.equal(parsed.compatibilityMinimum, undefined);
  assert.deepEqual(parsed.libraries, []);
});

test("parseExtensionList: 逐行取路径,忽略空行与 `;` 注释", () => {
  assert.deepEqual(
    parseExtensionList("res://a/a.gdextension\r\n\r\n; 注释\nres://b/b.gdextension\n"),
    ["res://a/a.gdextension", "res://b/b.gdextension"],
  );
  assert.deepEqual(parseExtensionList(""), []);
});

test("parseEnabledPluginPaths: 解析 PackedStringArray 形式的 [editor_plugins] enabled", () => {
  const text = [
    "config_version=5",
    "",
    "[editor_plugins]",
    "",
    'enabled=PackedStringArray("res://addons/good/plugin.cfg", "res://addons/broken/plugin.cfg")',
    "",
  ].join("\n");
  assert.deepEqual(parseEnabledPluginPaths(text), [
    "res://addons/good/plugin.cfg",
    "res://addons/broken/plugin.cfg",
  ]);
  assert.deepEqual(parseEnabledPluginPaths("config_version=5\n"), []);
});

test("parsePluginCfg: 读出 [plugin] 的 name / script", () => {
  const cfg = parsePluginCfg('[plugin]\n\nname="MZ DLL Bridge"\nversion="1.0"\nscript="dll_bridge_plugin.gd"\n');
  assert.equal(cfg.name, "MZ DLL Bridge");
  assert.equal(cfg.script, "dll_bridge_plugin.gd");
});

test("platformDirectory / isPlatformMatch: 三个平台的映射与键首段比对", () => {
  assert.equal(platformDirectory("win32"), "windows");
  assert.equal(platformDirectory("linux"), "linux");
  assert.equal(platformDirectory("darwin"), "macos");
  assert.equal(platformDirectory("freebsd"), null, "未知平台不做判定");

  assert.equal(isPlatformMatch("windows.debug.x86_64", "win32"), true);
  assert.equal(isPlatformMatch("linux.release.x86_64", "win32"), false);
  assert.equal(isPlatformMatch("macos.debug", "darwin"), true);
  assert.equal(isPlatformMatch("windows.debug.x86_64", "freebsd"), false, "未知平台一律 false");
  // 只判平台段:debug/release 与架构不参与判定(任务卡口径)
  assert.equal(isPlatformMatch("windows.release.arm64", "win32"), true);
});

test("isAddonStatusPayload: 形状自检(拒绝缺字段/类型不对的脏数据)", () => {
  assert.equal(isAddonStatusPayload({ loadedExtensions: [], classes: {}, engineVersion: "4.6.3" }), true);
  assert.equal(isAddonStatusPayload({ loadedExtensions: ["res://a.gdextension"], classes: { Node2D: { exists: true, can_instantiate: true } }, engineVersion: "x" }), true);
  assert.equal(isAddonStatusPayload({ loadedExtensions: [1], classes: {}, engineVersion: "x" }), false);
  assert.equal(isAddonStatusPayload({ loadedExtensions: [], classes: { A: { exists: true } }, engineVersion: "x" }), false);
  assert.equal(isAddonStatusPayload({ loadedExtensions: [], classes: [], engineVersion: "x" }), false);
  assert.equal(isAddonStatusPayload(null), false);
  assert.equal(isAddonStatusPayload("nope"), false);
});

test("buildCheckAddonStatusArgs: --path/--headless/--script 在前,类名经 -- 之后传入", () => {
  assert.deepEqual(buildCheckAddonStatusArgs("/proj", "/tmp/p.gd", ["Node2D", "NoSuch"]), [
    "--path", "/proj", "--headless", "--script", "/tmp/p.gd", "--", "--class", "Node2D", "--class", "NoSuch",
  ]);
  assert.deepEqual(buildCheckAddonStatusArgs("/proj", "/tmp/p.gd", []), [
    "--path", "/proj", "--headless", "--script", "/tmp/p.gd", "--",
  ]);
});

// ────────────────────────────── 2) diagnosis 规则(构造数据,零依赖) ──────────────────────────────

function ext(over: Partial<AddonExtensionInfo> = {}): AddonExtensionInfo {
  return {
    path: "res://addons/a/a.gdextension",
    loaded: null,
    listedInExtensionList: false,
    libraries: [],
    ...over,
  };
}

function plugin(over: Partial<AddonPluginInfo> = {}): AddonPluginInfo {
  return { path: "res://addons/a/plugin.cfg", cfgExists: true, scriptExists: true, ...over };
}

test("diagnosis: 有 .gdextension 但没有 extension_list.cfg → extension_list_missing", () => {
  const d = computeDiagnosis({
    extensionListFound: false,
    extensions: [ext()],
    loadedExtensions: null,
    requestedClasses: [],
    classResults: null,
    plugins: [],
  });
  assert.deepEqual(d, ["extension_list_missing"]);
});

test("diagnosis: 没有 .gdextension 时不报 extension_list_missing", () => {
  const d = computeDiagnosis({
    extensionListFound: false,
    extensions: [],
    loadedExtensions: null,
    requestedClasses: [],
    classResults: null,
    plugins: [],
  });
  assert.deepEqual(d, []);
});

test("diagnosis: 清单存在但未列出该扩展 → extension_not_listed", () => {
  const d = computeDiagnosis({
    extensionListFound: true,
    extensions: [ext({ listedInExtensionList: false })],
    loadedExtensions: [],
    requestedClasses: [],
    classResults: null,
    plugins: [],
  });
  assert.deepEqual(d, ["extension_not_listed:res://addons/a/a.gdextension"]);
});

test("diagnosis: 已列出但引擎未加载 → extension_not_loaded(仅 engine.ok)", () => {
  const base = {
    extensionListFound: true,
    extensions: [ext({ listedInExtensionList: true })],
    requestedClasses: [],
    classResults: null,
    plugins: [],
  };
  assert.deepEqual(computeDiagnosis({ ...base, loadedExtensions: [] }), [
    "extension_not_loaded:res://addons/a/a.gdextension",
  ]);
  assert.deepEqual(computeDiagnosis({ ...base, loadedExtensions: ["res://addons/a/a.gdextension"] }), []);
  // 引擎没跑成(loadedExtensions 为 null):不知道就不要断言"未加载"
  assert.deepEqual(computeDiagnosis({ ...base, loadedExtensions: null }), []);
});

test("diagnosis: library_missing 仅当 platformMatch 的库全部不存在", () => {
  const mk = (libraries: AddonExtensionInfo["libraries"]): string[] =>
    computeDiagnosis({
      extensionListFound: true,
      extensions: [ext({ listedInExtensionList: true, libraries })],
      loadedExtensions: ["res://addons/a/a.gdextension"],
      requestedClasses: [],
      classResults: null,
      plugins: [],
    });
  const lib = (exists: boolean, platformMatch: boolean) => ({ key: "k", path: "res://bin/x", exists, platformMatch });

  assert.deepEqual(mk([lib(false, true)]), ["library_missing:res://addons/a/a.gdextension"]);
  assert.deepEqual(mk([lib(false, true), lib(false, true)]), ["library_missing:res://addons/a/a.gdextension"]);
  assert.deepEqual(mk([lib(false, true), lib(true, true)]), [], "有一个存在就不算缺失");
  assert.deepEqual(mk([lib(true, true)]), []);
  assert.deepEqual(mk([lib(false, false)]), [], "非本机平台的库不算");
  assert.deepEqual(mk([]), []);
});

test("diagnosis: class_missing 仅在 engine.ok 时判定,保留请求顺序", () => {
  assert.deepEqual(
    computeDiagnosis({
      extensionListFound: false,
      extensions: [],
      loadedExtensions: [],
      requestedClasses: ["Node2D", "NoSuchClass123"],
      classResults: { Node2D: { exists: true, can_instantiate: true }, NoSuchClass123: { exists: false, can_instantiate: false } },
      plugins: [],
    }),
    ["class_missing:NoSuchClass123"],
  );
  // 引擎失败:不得据此断言类不存在
  assert.deepEqual(
    computeDiagnosis({
      extensionListFound: false,
      extensions: [],
      loadedExtensions: null,
      requestedClasses: ["NoSuchClass123"],
      classResults: null,
      plugins: [],
    }),
    [],
  );
});

test("diagnosis: plugin_files_missing 覆盖 cfg 缺失与 script 缺失,齐全时不报", () => {
  assert.deepEqual(
    computeDiagnosis({
      extensionListFound: false,
      extensions: [],
      loadedExtensions: null,
      requestedClasses: [],
      classResults: null,
      plugins: [
        plugin({ path: "res://addons/ok/plugin.cfg" }),
        plugin({ path: "res://addons/nocfg/plugin.cfg", cfgExists: false, scriptExists: false }),
        plugin({ path: "res://addons/noscript/plugin.cfg", scriptExists: false }),
      ],
    }),
    ["plugin_files_missing:res://addons/nocfg/plugin.cfg", "plugin_files_missing:res://addons/noscript/plugin.cfg"],
  );
});

// ────────────────────────────── 3) 服务层(注入 runner 替身) ──────────────────────────────

function runnerReturning(result: Partial<RunProcessResult>): GodotRunRunner {
  return async () => ({
    exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "",
    stdoutTruncated: false, stderrTruncated: false, durationMs: 3,
    ...result,
  });
}

const PAYLOAD = {
  loadedExtensions: ["res://fake.gdextension"],
  classes: { Node2D: { exists: true, can_instantiate: true }, NoSuchClass123: { exists: false, can_instantiate: false } },
  engineVersion: "4.6.3-stable (official)",
};

/** 临时工程:.gdextension(库缺失)+ 三个已启用插件(齐全 / script 缺失 / cfg 缺失)。 */
function makeAddonProject(
  t: { after: (fn: () => void) => void },
  runner: GodotRunRunner,
): { dir: string; svc: RuntimeService; check: (o?: Partial<CheckAddonStatusOptions>) => ReturnType<RuntimeService["checkAddonStatus"]> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-addon-unit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel: string, text: string): void => {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  write("project.godot", [
    "config_version=5",
    "",
    "[editor_plugins]",
    "",
    'enabled=PackedStringArray("res://addons/ok/plugin.cfg", "res://addons/noscript/plugin.cfg", "res://addons/nocfg/plugin.cfg")',
    "",
  ].join("\n"));
  write("fake.gdextension", [
    "[configuration]",
    "",
    'entry_symbol = "fake_library_init"',
    'compatibility_minimum = "4.6"',
    "",
    "[libraries]",
    "",
    'windows.debug.x86_64 = "res://bin/nope.dll"',
    'linux.release.x86_64 = "res://bin/nope.so"',
    "",
  ].join("\n"));
  write("addons/ok/plugin.cfg", '[plugin]\n\nname="Ok"\nscript="ok.gd"\n');
  write("addons/ok/ok.gd", "extends EditorPlugin\n");
  write("addons/noscript/plugin.cfg", '[plugin]\n\nname="NoScript"\nscript="gone.gd"\n');
  write("addons/nocfg/keep.txt", "还有目录但没有 plugin.cfg\n");

  const exe = path.join(dir, "godot.exe");
  fs.writeFileSync(exe, "");
  const project = new ProjectResolver({ cwd: dir });
  const godot = new GodotCliService({ env: { GODOT_PATH: exe } });
  const svc = new RuntimeService({ godot, project, runQueue: new TaskQueue(new LockManager()), runner });
  return { dir, svc, check: (o = {}) => svc.checkAddonStatus({ projectPath: dir, tool: "runtime_check_addon_status", ...o }) };
}

test("静态扫描: .gdextension 字段/库存在性/平台判定 + 插件三态(不依赖引擎)", async (t) => {
  const { check } = makeAddonProject(t, runnerReturning({ stdout: `MCP_RESULT_JSON=${JSON.stringify(PAYLOAD)}` }));
  const r = await check();

  // 引擎部分(替身伪造成功)
  assert.deepEqual(r.engine, { ok: true, version: "4.6.3-stable (official)" });
  assert.equal(r.extensionListFound, false, "测试工程没有 .godot/extension_list.cfg");

  assert.equal(r.extensions.length, 1);
  const e = r.extensions[0]!;
  assert.equal(e.path, "res://fake.gdextension");
  assert.equal(e.entrySymbol, "fake_library_init");
  assert.equal(e.compatibilityMinimum, "4.6");
  assert.equal(e.listedInExtensionList, false);
  assert.equal(e.loaded, true, "替身回报已加载该路径");
  assert.deepEqual(e.libraries.map((l) => l.key), ["windows.debug.x86_64", "linux.release.x86_64"]);
  for (const l of e.libraries) assert.equal(l.exists, false, "库文件都不存在");
  assert.equal(e.libraries[0]!.platformMatch, process.platform === "win32");
  assert.equal(e.libraries[1]!.platformMatch, process.platform === "linux");

  // 类结果按引擎回传照抄
  assert.deepEqual(r.classes?.["Node2D"], { exists: true, can_instantiate: true });

  // 插件三态(顺序 = project.godot 里的启用顺序)
  assert.deepEqual(r.plugins, [
    { path: "res://addons/ok/plugin.cfg", cfgExists: true, name: "Ok", script: "ok.gd", scriptExists: true },
    { path: "res://addons/noscript/plugin.cfg", cfgExists: true, name: "NoScript", script: "gone.gd", scriptExists: false },
    { path: "res://addons/nocfg/plugin.cfg", cfgExists: false, scriptExists: false },
  ]);

  // diagnosis:清单缺失 + 本机平台库缺失 + 两个插件文件问题
  assert.ok(r.diagnosis.includes("extension_list_missing"));
  assert.ok(r.diagnosis.includes("plugin_files_missing:res://addons/noscript/plugin.cfg"));
  assert.ok(r.diagnosis.includes("plugin_files_missing:res://addons/nocfg/plugin.cfg"));
  assert.equal(
    r.diagnosis.includes("library_missing:res://fake.gdextension"),
    process.platform === "win32" || process.platform === "linux",
    "只有本机平台的库全缺才报",
  );
  assert.equal(r.diagnosis.includes("extension_not_loaded:res://fake.gdextension"), false, "未列出时不报 not_loaded");
  assert.ok(r.durationMs >= 0);
});

test("extension_list.cfg 存在并列出该扩展、但引擎未加载 → extension_not_loaded + 静态字段正确", async (t) => {
  const { dir, check } = makeAddonProject(t, runnerReturning({ stdout: `MCP_RESULT_JSON=${JSON.stringify({ ...PAYLOAD, loadedExtensions: [] })}` }));
  fs.mkdirSync(path.join(dir, ".godot"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".godot", "extension_list.cfg"), "res://fake.gdextension\n");

  const r = await check();
  assert.equal(r.extensionListFound, true);
  assert.equal(r.extensions[0]!.listedInExtensionList, true);
  assert.equal(r.extensions[0]!.loaded, false);
  assert.ok(r.diagnosis.includes("extension_not_loaded:res://fake.gdextension"));
  assert.equal(r.diagnosis.includes("extension_list_missing"), false);
  assert.equal(r.diagnosis.includes("extension_not_listed:res://fake.gdextension"), false);
});

test("engine.stderr 有内容时进 engine.stderr 摘要;干净时省略", async (t) => {
  const noisy = makeAddonProject(t, runnerReturning({
    stdout: `MCP_RESULT_JSON=${JSON.stringify(PAYLOAD)}`,
    stderr: "ERROR: GDExtension dynamic library not found.\nERROR: Error loading extension: 'res://fake.gdextension'.\n",
  }));
  const r1 = await noisy.check();
  assert.equal(r1.engine.ok, true);
  assert.match((r1.engine as { stderr?: string }).stderr ?? "", /GDExtension dynamic library not found/);

  const clean = makeAddonProject(t, runnerReturning({ stdout: `MCP_RESULT_JSON=${JSON.stringify(PAYLOAD)}`, stderr: "\n" }));
  const r2 = await clean.check();
  assert.deepEqual(r2.engine, { ok: true, version: "4.6.3-stable (official)" });
});

test("引擎不可用:静态部分照常返回,loaded/classes 为 null 且不误报 not_loaded/class_missing", async (t) => {
  // GODOT_PATH 指向不存在的文件 → locate() 抛 GODOT_NOT_FOUND(与真实路径一致)
  const { svc } = makeAddonProject(t, runnerReturning({}));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "godot-addon-unit-missing-"));
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir2, "project.godot"), "config_version=5\n");

  const bad = new RuntimeService({
    godot: new GodotCliService({ env: { GODOT_PATH: path.join(dir2, "nope.exe") } }),
    project: new ProjectResolver({ cwd: dir2 }),
    runQueue: new TaskQueue(new LockManager()),
    runner: runnerReturning({}),
  });
  const r = await bad.checkAddonStatus({ projectPath: dir2, classes: ["Node2D"], tool: "runtime_check_addon_status" });

  assert.equal(r.engine.ok, false);
  assert.equal((r.engine as { error: { code: string } }).error.code, "GODOT_NOT_FOUND");
  assert.equal(r.classes, null, "引擎没跑成 → 类结果未知(不是空对象)");
  assert.deepEqual(r.extensions, []);
  assert.deepEqual(r.plugins, []);
  assert.deepEqual(r.diagnosis, [], "不得凭猜测报 class_missing");
  assert.equal(svc instanceof RuntimeService, true);
});

test("引擎退出非零 / 超时 → engine.ok=false 且错误码透传", async (t) => {
  const failed = makeAddonProject(t, runnerReturning({ exitCode: 1, stderr: "boom" }));
  const r1 = await failed.check();
  assert.equal(r1.engine.ok, false);
  assert.equal((r1.engine as { error: { code: string } }).error.code, "GODOT_PROCESS_FAILED");
  assert.equal(r1.classes, null);

  const timedOut = makeAddonProject(t, runnerReturning({ timedOut: true, exitCode: null }));
  const r2 = await timedOut.check({ timeoutMs: 250 });
  assert.equal(r2.engine.ok, false);
  assert.equal((r2.engine as { error: { code: string } }).error.code, "TASK_TIMEOUT");
});

test("引擎 stdout 没有 MCP_RESULT_JSON → RUNTIME_FAILED(而不是把空数据当成功)", async (t) => {
  const { check } = makeAddonProject(t, runnerReturning({ stdout: "Godot Engine v4.6.3.stable.official\n" }));
  const r = await check();
  assert.equal(r.engine.ok, false);
  assert.equal((r.engine as { error: { code: string } }).error.code, "RUNTIME_FAILED");
  assert.equal(r.classes, null);
  assert.equal(r.extensions[0]!.loaded, null);
});

// ────────────────────────────── 4) 工具层 ──────────────────────────────

test("工具层:经 ToolHost 走通;classes 超过 50 个返回 INVALID_ARGUMENT", async (t) => {
  const { dir, svc } = makeAddonProject(t, runnerReturning({ stdout: `MCP_RESULT_JSON=${JSON.stringify(PAYLOAD)}` }));
  const ctx = { runtime: svc } as unknown as AppContext;
  const host = new ToolHost(new ToolRegistry<AppContext>().registerAll([runtimeCheckAddonStatus]), ctx, quiet);

  const okRes = await host.callTool("runtime_check_addon_status", { projectPath: dir, classes: ["Node2D", "NoSuchClass123"] });
  assert.equal(okRes.ok, true);
  const data = (okRes as { ok: true; data: { diagnosis: string[]; classes: Record<string, unknown> } }).data;
  assert.ok(data.diagnosis.includes("class_missing:NoSuchClass123"));
  assert.equal((data.classes as Record<string, { exists: boolean }>)["Node2D"]!.exists, true);

  const tooMany = await host.callTool("runtime_check_addon_status", {
    projectPath: dir,
    classes: Array.from({ length: 51 }, (_v, i) => `C${i}`),
  });
  assert.equal(tooMany.ok, false);
  assert.equal((tooMany as { ok: false; error: { code: string } }).error.code, "INVALID_ARGUMENT");

  // 参数类型不对 → 校验层拦下(不进入引擎)
  const badType = await host.callTool("runtime_check_addon_status", { classes: "Node2D" });
  assert.equal(badType.ok, false);
  assert.equal((badType as { ok: false; error: { code: string } }).error.code, "INVALID_ARGUMENT");
});

// ────────────────────────────── 5) 真实 spawn(用 node,不启动 Godot) ──────────────────────────────

test("defaultRunRunner: 引擎探针路径上的超时会被 SIGKILL 并标记 timedOut", async () => {
  const res = await defaultRunRunner(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 300 });
  assert.equal(res.timedOut, true);
  assert.equal(res.exitCode, null);
});
