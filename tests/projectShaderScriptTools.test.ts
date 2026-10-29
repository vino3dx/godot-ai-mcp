// Stage 3 / T3:project_* / shader_* / script_* 工具经 ToolHost 的端到端(路径解析 → 读 → Service → 写)。
// 用临时项目目录(project.godot + 内联 .gdshader/.gd)验证读/改/错误信封,不依赖真实 Godot。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { createAppContext } from "../src/services/context.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";
import type { AppContext } from "../src/services/context.js";

const quiet = createLogger("error", () => {});

const PROJECT_GODOT = `; Engine configuration file.
config_version=5

[application]

config/name="Demo Game"

[display]

window/size/viewport_width=1280
`;

const SHADER = `shader_type spatial;
render_mode unshaded;

uniform vec3 albedo : source_color = vec3(1.0);
uniform float roughness = 0.5;
`;

const SCRIPT = `extends CharacterBody2D
class_name Player

@export var speed: float = 300.0
`;

interface Host { dir: string; host: ToolHost<AppContext> }

function makeHost(t: { after: (fn: () => void) => void }, cwd?: string): Host {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-mcp-pss-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "shaders"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "project.godot"), PROJECT_GODOT);
  fs.writeFileSync(path.join(dir, "shaders", "main.gdshader"), SHADER);
  fs.writeFileSync(path.join(dir, "scripts", "player.gd"), SCRIPT);
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: cwd ?? dir }));
  return { dir, host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet) };
}

function ok(r: ToolResult): Record<string, unknown> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; data: unknown }).data as Record<string, unknown>;
}

function err(r: ToolResult): { code: string; message: string } {
  assert.equal(r.ok, false, JSON.stringify(r));
  return (r as { ok: false; error: { code: string; message: string } }).error;
}

// ---------- project ----------

test("project_get_config: 读取全部配置 + 返回 hash/resPath", async (t) => {
  const { host } = makeHost(t);
  const data = ok(await host.callTool("project_get_config", {}));
  assert.equal(data["resPath"], "res://project.godot");
  assert.equal((data["hash"] as string).length, 64);
  const config = data["config"] as { configVersion?: number; sections: Array<{ name: string; values: Array<{ key: string; value: string }> }> };
  assert.equal(config.configVersion, 5);
  assert.deepEqual(config.sections.map((s) => s.name), ["application", "display"]);
  assert.deepEqual(config.sections[0]?.values, [{ key: "config/name", value: '"Demo Game"' }]);
});

test("project_set_config: 改应用名 + 新增窗口高度键", async (t) => {
  const { dir, host } = makeHost(t);
  const wrote = ok(await host.callTool("project_set_config", {
    section: "application", key: "config/name", value: '"Renamed"',
  }));
  assert.equal(wrote["changed"], true);
  let onDisk = fs.readFileSync(path.join(dir, "project.godot"), "utf8");
  assert.ok(onDisk.includes('config/name="Renamed"'));

  const added = ok(await host.callTool("project_set_config", {
    section: "display", key: "window/size/viewport_height", value: "720",
  }));
  assert.equal(added["changed"], true);
  onDisk = fs.readFileSync(path.join(dir, "project.godot"), "utf8");
  assert.ok(onDisk.includes("window/size/viewport_height=720"));
  assert.ok(onDisk.includes("window/size/viewport_width=1280")); // 既有键保留
});

test("project_set_config: change 回报文件静态前后值(新增键 before=null)", async (t) => {
  const { host } = makeHost(t);
  const wrote = ok(await host.callTool("project_set_config", {
    section: "application", key: "config/name", value: '"Renamed"',
  }));
  assert.deepEqual(wrote["change"], {
    property: "config/name",
    before: { raw: '"Demo Game"', value: "Demo Game" },
    after: { raw: '"Renamed"', value: "Renamed" },
    inFile: true,
  });

  const added = ok(await host.callTool("project_set_config", {
    section: "display", key: "window/size/viewport_height", value: "720",
  }));
  assert.deepEqual(added["change"], {
    property: "window/size/viewport_height",
    before: null,
    after: { raw: "720", value: 720 },
    inFile: false,
  });
});

// ---------- shader ----------

test("shader_get_info / shader_update_uniform_default: 读取与安全更新", async (t) => {
  const { dir, host } = makeHost(t);
  const data = ok(await host.callTool("shader_get_info", { path: "res://shaders/main.gdshader" }));
  const info = data["info"] as { shaderType?: string; renderModes: string[]; uniforms: Array<{ name: string; default?: string }> };
  assert.equal(info.shaderType, "spatial");
  assert.deepEqual(info.renderModes, ["unshaded"]);
  assert.deepEqual(info.uniforms.map((u) => u.name), ["albedo", "roughness"]);

  const wrote = ok(await host.callTool("shader_update_uniform_default", {
    path: "res://shaders/main.gdshader", name: "roughness", value: "0.75",
  }));
  assert.equal(wrote["changed"], true);
  const onDisk = fs.readFileSync(path.join(dir, "shaders", "main.gdshader"), "utf8");
  assert.ok(onDisk.includes("uniform float roughness = 0.75;"));
  assert.ok(onDisk.includes("uniform vec3 albedo : source_color = vec3(1.0);")); // 其他 uniform 不变
});

test("shader_update_uniform_default: change 回报文件静态前后值(认不得的表达式只有 raw)", async (t) => {
  const { host } = makeHost(t);
  const p = "res://shaders/main.gdshader";
  const wrote = ok(await host.callTool("shader_update_uniform_default", { path: p, name: "roughness", value: "0.75" }));
  assert.deepEqual(wrote["change"], {
    property: "roughness",
    before: { raw: "0.5", value: 0.5 },
    after: { raw: "0.75", value: 0.75 },
    inFile: true,
  });

  // vec3(...) 不是 Godot 文本字面量的可解析写法 → 只给 raw
  const vec = ok(await host.callTool("shader_update_uniform_default", { path: p, name: "albedo", value: "vec3(0.2)" }));
  assert.deepEqual(vec["change"], {
    property: "albedo",
    before: { raw: "vec3(1.0)" },
    after: { raw: "vec3(0.2)" },
    inFile: true,
  });
});

// ---------- script ----------

test("script_get_info / script_update_export_default: 读取与安全更新", async (t) => {
  const { dir, host } = makeHost(t);
  const data = ok(await host.callTool("script_get_info", { path: "res://scripts/player.gd" }));
  const info = data["info"] as { extends?: string; className?: string; exports: Array<{ name: string; default?: string }> };
  assert.equal(info.extends, "CharacterBody2D");
  assert.equal(info.className, "Player");
  assert.deepEqual(info.exports, [{ name: "speed", type: "float", default: "300.0" }]);

  const wrote = ok(await host.callTool("script_update_export_default", {
    path: "res://scripts/player.gd", name: "speed", value: "500.0",
  }));
  assert.equal(wrote["changed"], true);
  const onDisk = fs.readFileSync(path.join(dir, "scripts", "player.gd"), "utf8");
  assert.ok(onDisk.includes("@export var speed: float = 500.0"));
  assert.ok(onDisk.includes("class_name Player")); // 其余字节不变
});

test("script_update_export_default: change 回报文件静态前后值", async (t) => {
  const { host } = makeHost(t);
  const p = "res://scripts/player.gd";
  const wrote = ok(await host.callTool("script_update_export_default", { path: p, name: "speed", value: "500.0" }));
  assert.deepEqual(wrote["change"], {
    property: "speed",
    before: { raw: "300.0", value: 300 },
    after: { raw: "500.0", value: 500 },
    inFile: true,
  });
});

test("script_update_function: dryRun、hash 冲突和提交安全", async (t) => {
  const { dir, host } = makeHost(t);
  const p = "res://scripts/root.gd";
  const targetPath = path.join(dir, "scripts", "root.gd");
  fs.writeFileSync(targetPath, "extends Node\nvar ready_calls := 0\n\nfunc _on_ready() -> void:\n\tready_calls += 1\n\n# keep this footer\n");
  const before = fs.readFileSync(targetPath, "utf8");
  const dry = ok(await host.callTool("script_update_function", { path: p, name: "_on_ready", replacement: "func _on_ready() -> void:\n\tprint(\"ok\")", dryRun: true }));
  assert.equal(dry["changed"], true);
  assert.equal(fs.readFileSync(targetPath, "utf8"), before);
  const conflict = err(await host.callTool("script_update_function", { path: p, name: "_on_ready", replacement: "func _on_ready() -> void:\n\tpass", expectedHash: "stale" }));
  assert.equal(conflict.code, "FILE_CHANGED");
  const result = ok(await host.callTool("script_update_function", { path: p, name: "_on_ready", replacement: "func _on_ready() -> void:\n\tprint(\"ok\")" }));
  assert.equal(result["changed"], true);
  const after = fs.readFileSync(targetPath, "utf8");
  assert.ok(after.includes("func _on_ready() -> void:\n\tprint(\"ok\")"));
  assert.ok(after.includes("var ready_calls := 0"));
});

// ---------- 错误信封 ----------

test("project/shader/script 工具:文件不存在 / 未知参数 / 目标缺失 分别报对应错误", async (t) => {
  const { host } = makeHost(t);
  assert.equal(err(await host.callTool("project_get_config", { path: "res://nope.godot" })).code, "FILE_NOT_FOUND");
  assert.equal(err(await host.callTool("project_set_config", { section: "a", key: "b", value: "1", bogus: 2 })).code, "INVALID_ARGUMENT");
  assert.equal(err(await host.callTool("shader_update_uniform_default", { path: "res://shaders/main.gdshader", name: "nope", value: "1" })).code, "INVALID_ARGUMENT");
  assert.equal(err(await host.callTool("script_update_export_default", { path: "res://scripts/player.gd", name: "nope", value: "1" })).code, "INVALID_ARGUMENT");
});

test("projectPath 参数可覆盖项目根(cwd 无 project.godot 时)", async (t) => {
  const { dir, host } = makeHost(t, os.tmpdir());
  const data = ok(await host.callTool("project_get_config", { projectPath: dir }));
  assert.equal((data["config"] as { configVersion?: number }).configVersion, 5);
});
