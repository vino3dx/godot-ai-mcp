// Stage 3 / T3:ProjectService(project.godot 配置读取与无损修改)。
//
// 样例是手写的"代表性 project.godot 文本"(真实样例待 tests/fixtures/sample_project 就位),
// 用于验证配置结构提取、"除目标行外逐字节不变"的无损序列化与新增键/段的插入位置。
import { test } from "node:test";
import assert from "node:assert/strict";
import { GodotMcpError } from "../src/core/errors.js";
import { parseGodotConfigFile, serializeGodotConfigFile } from "../src/core/parser/index.js";
import { ProjectService } from "../src/services/projectService.js";

const PROJECT = `; Engine configuration file.
config_version=5

[application]

config/name="Demo Game"
run/main_scene="res://scenes/main.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[display]

window/size/viewport_width=1280
window/size/viewport_height=720

[rendering]

renderer/rendering_method="forward_plus"
`;

const service = new ProjectService();

/** 最小行级 diff(公共前缀/后缀对齐),用于断言"diff 只有一行"。 */
function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const la = a.split("\n");
  const lb = b.split("\n");
  let p = 0;
  while (p < la.length && p < lb.length && la[p] === lb[p]) p++;
  let s = 0;
  while (s < la.length - p && s < lb.length - p && la[la.length - 1 - s] === lb[lb.length - 1 - s]) s++;
  return { removed: la.slice(p, la.length - s), added: lb.slice(p, lb.length - s) };
}

function isCode(code: string) {
  return (e: unknown): boolean => e instanceof GodotMcpError && e.code === code;
}

/** 无损自检:结果必须能被解析并逐字节还原。 */
function assertLossless(text: string): void {
  assert.equal(serializeGodotConfigFile(parseGodotConfigFile(text)), text);
}

// ---------- getConfig / getConfigValue ----------

test("getConfig: 段结构、键值原文与 configVersion", () => {
  const config = service.getConfig(PROJECT);
  assert.equal(config.configVersion, 5);
  assert.deepEqual(config.sections.map((s) => s.name), ["application", "display", "rendering"]);
  const app = config.sections.find((s) => s.name === "application");
  assert.deepEqual(app?.values, [
    { key: "config/name", value: '"Demo Game"' },
    { key: "run/main_scene", value: '"res://scenes/main.tscn"' },
    { key: "config/features", value: 'PackedStringArray("4.7", "Forward Plus")' },
  ]);
});

test("getConfigValue: 读单个键;段/键不存在返回 undefined", () => {
  assert.equal(service.getConfigValue(PROJECT, "application", "config/name"), '"Demo Game"');
  assert.equal(service.getConfigValue(PROJECT, "display", "window/size/viewport_width"), "1280");
  assert.equal(service.getConfigValue(PROJECT, "application", "no/such/key"), undefined);
  assert.equal(service.getConfigValue(PROJECT, "nope", "config/name"), undefined);
});

// ---------- setConfigValue ----------

test("setConfigValue: 改已有键只动该行,其余字节(注释/其他段)不变", () => {
  const out = service.setConfigValue(PROJECT, "application", "config/name", '"Renamed"');
  const d = lineDiff(PROJECT, out);
  assert.deepEqual(d.removed, ['config/name="Demo Game"']);
  assert.deepEqual(d.added, ['config/name="Renamed"']);
  assertLossless(out);
  assert.equal(service.getConfigValue(out, "application", "run/main_scene"), '"res://scenes/main.tscn"');
  assert.equal(service.getConfigValue(out, "display", "window/size/viewport_height"), "720");
});

test("setConfigValue: 键不存在则追加到该段最后一个键之后", () => {
  const out = service.setConfigValue(PROJECT, "display", "window/size/mode", "0");
  assert.equal(
    out,
    PROJECT.replace(
      "window/size/viewport_height=720\n",
      "window/size/viewport_height=720\nwindow/size/mode=0\n",
    ),
  );
  assertLossless(out);
  assert.equal(service.getConfigValue(out, "display", "window/size/mode"), "0");
});

test("setConfigValue: 段不存在则新建段(与前一段之间空一行)", () => {
  const out = service.setConfigValue(PROJECT, "physics", "3d/default_gravity", "9.8");
  assert.equal(
    out,
    PROJECT.replace(
      "renderer/rendering_method=\"forward_plus\"\n",
      "renderer/rendering_method=\"forward_plus\"\n\n[physics]\n\n3d/default_gravity=9.8\n",
    ),
  );
  assertLossless(out);
  assert.equal(service.getConfigValue(out, "physics", "3d/default_gravity"), "9.8");
});

test("setConfigValue: 值未变化时输出与输入逐字节相同(幂等)", () => {
  assert.equal(service.setConfigValue(PROJECT, "application", "config/name", '"Demo Game"'), PROJECT);
});

test("setConfigValue: 支持多行值(Dictionary)且重新读取完整", () => {
  const out = service.setConfigValue(PROJECT, "display", "window/stretch/mode", '{\n"a": 1\n}');
  assert.ok(out.includes('window/stretch/mode={\n"a": 1\n}'));
  assertLossless(out);
  assert.equal(service.getConfigValue(out, "display", "window/stretch/mode"), '{\n"a": 1\n}');
});

test("setConfigValue: 空文件也能新建段", () => {
  const out = service.setConfigValue("", "application", "config/name", '"X"');
  assert.equal(out, "[application]\n\nconfig/name=\"X\"\n");
  assertLossless(out);
});

test("setConfigValue: 非法入参被拒绝(空段/空键/非法键/空值/不平衡值)", () => {
  assert.throws(() => service.setConfigValue(PROJECT, "", "k", "1"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.setConfigValue(PROJECT, "app", "", "1"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.setConfigValue(PROJECT, "app", "a=b", "1"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.setConfigValue(PROJECT, "app", "  k", "1"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.setConfigValue(PROJECT, "app", "k", ""), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.setConfigValue(PROJECT, "app", "k", '"unterminated'), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.setConfigValue(PROJECT, "app", "k", "Vector2(1, 2"), isCode("INVALID_ARGUMENT"));
});
