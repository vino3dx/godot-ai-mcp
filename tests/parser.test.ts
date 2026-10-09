// Stage 2 / T2.1:统一解析器(src/core/parser/index.ts)的无损往返测试。
//
// 覆盖两条格式族:
//   1) project.godot(INI 风格)    → parseGodotConfigFile / serializeGodotConfigFile
//   2) .tscn / .tres(Godot 文本资源) → parseGodotResource / serializeGodotResource
//
// 内联样例是手写的"代表性 Godot 文本格式",仅用于验证解析/编辑/往返逻辑;
// 真实样例必须由 Godot 4.7.2 生成(见 tests/fixtures/README.md),故不写入 fixtures。
// fixtures 自动发现测试在真实样例就位后自动启用,缺失时优雅跳过。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GodotMcpError } from "../src/core/errors.js";
import {
  parseGodotConfigFile,
  serializeGodotConfigFile,
  getGodotConfigValue,
  setGodotConfigValue,
  parseGodotResource,
  serializeGodotResource,
  findGodotResourceSections,
  getGodotResourceProperty,
  setGodotResourceProperty,
  getGodotSceneNodes,
  type GodotResourceProperty,
  type GodotResourceSection,
  type GodotResourceTag,
} from "../src/core/parser/index.js";

// ---------- 样例(手写,非引擎产出) ----------

const PROJECT_GODOT = `; Engine configuration file (test sample, not engine output).
config_version=5

[application]

config/name="Demo Game"
run/main_scene="res://scenes/main.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[autoload]

Game="*res://scripts/game.gd"

[input]

jump={
"deadzone": 0.2,
"events": [Object(InputEventKey,"physical_keycode":32)]
}

[layer_names]

2d_physics/layer_1="World"

[unknown_section]

some_unknown_key=Vector3(1, 2, 3)
`;

const MAIN_TSCN = `[gd_scene load_steps=4 format=3 uid="uid://testabc123"]

[ext_resource type="Script" path="res://scripts/player.gd" id="1_script"]

[sub_resource type="RectangleShape2D" id="RectangleShape2D_1"]
size = Vector2(20, 40)

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1_script")
; a comment inside the scene
position = Vector2(0, 0)

[node name="Sprite" type="Sprite2D" parent="."]

[node name="Collision" type="CollisionShape2D" parent="."]
shape = SubResource("RectangleShape2D_1")

[connection signal="ready" from="." to="."]
`;

const MATERIAL_TRES = `[gd_resource type="StandardMaterial3D" load_steps=2 format=3]

[sub_resource type="GDScript" id="GDScript_1"]
script/source = "extends Node\\nfunc _ready(): pass\\n"

[resource]
albedo_color = Color(0.8, 0.2, 0.2, 1)
roughness = 0.5
metallic = 0.1
`;

// ---------- 工具 ----------

/**
 * 规范解析器把 `.tscn/.tres` 属性行 `name = value` 中 `=` 之后的原文(含紧随的分隔空格)
 * 存进 `value`,因此 `prefix + value` 能逐字节还原原行。下面两个辅助函数把该分隔空格
 * 收进/补回,让用例专注值本身的语义;原始契约由「属性值原文」一例显式锁定。
 */
function readProp(section: GodotResourceSection, name: string): string | undefined {
  const raw = getGodotResourceProperty(section, name);
  return raw === undefined ? undefined : raw.replace(/^[ \t]/, "");
}

function writeProp(section: GodotResourceSection, name: string, value: string): boolean {
  return setGodotResourceProperty(section, name, ` ${value}`);
}

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

function isParseError(e: unknown): e is GodotMcpError {
  return e instanceof GodotMcpError && e.code === "PARSE_ERROR";
}

function expectParseError(fn: () => unknown, line?: number): void {
  assert.throws(fn, isParseError);
  if (line !== undefined) {
    try {
      fn();
    } catch (e) {
      if (isParseError(e)) assert.equal(e.details?.["line"], line, `expected line ${line}, got: ${e.message}`);
    }
  }
}

/** 按标签取首个段;缺失即断言失败。 */
function sectionByTag(ast: ReturnType<typeof parseGodotResource>, tag: GodotResourceTag): GodotResourceSection {
  const [sec] = findGodotResourceSections(ast, tag);
  assert.ok(sec, `缺少 [${tag}] 段`);
  return sec;
}

// ---------- project.godot ----------

test("project.godot round-trip: serialize(parse(x)) === x(含注释/空行/未知段/多行值)", () => {
  assert.equal(serializeGodotConfigFile(parseGodotConfigFile(PROJECT_GODOT)), PROJECT_GODOT);
});

test("project.godot round-trip: CRLF 行尾逐字节保留", () => {
  const crlf = "config_version=5\r\n\r\n[app]\r\nx=1\r\n";
  assert.equal(serializeGodotConfigFile(parseGodotConfigFile(crlf)), crlf);
});

test("project.godot get: 原始值文本逐字返回(含引号与多行)", () => {
  const doc = parseGodotConfigFile(PROJECT_GODOT);
  assert.equal(getGodotConfigValue(doc, "application", "config/name"), '"Demo Game"');
  assert.equal(getGodotConfigValue(doc, "application", "config/features"), 'PackedStringArray("4.7", "Forward Plus")');
  assert.equal(getGodotConfigValue(doc, "unknown_section", "some_unknown_key"), "Vector3(1, 2, 3)");
  assert.equal(
    getGodotConfigValue(doc, "input", "jump"),
    '{\n"deadzone": 0.2,\n"events": [Object(InputEventKey,"physical_keycode":32)]\n}',
  );
  assert.equal(getGodotConfigValue(doc, "missing", "key"), undefined);
});

test("project.godot 顶级键:config_version=5 在首个 section 之前,可读可往返", () => {
  const doc = parseGodotConfigFile(PROJECT_GODOT);
  assert.equal(getGodotConfigValue(doc, "", "config_version"), "5");
  assert.equal(serializeGodotConfigFile(parseGodotConfigFile("config_version=5\n[app]\nx=1\n")), "config_version=5\n[app]\nx=1\n");
});

test("project.godot 改一个键:diff 只有一行,其余属性(含未知段)原样存留", () => {
  const doc = parseGodotConfigFile(PROJECT_GODOT);
  assert.equal(setGodotConfigValue(doc, "application", "config/name", '"Renamed"'), true);
  const out = serializeGodotConfigFile(doc);
  const d = lineDiff(PROJECT_GODOT, out);
  assert.deepEqual(d.removed, ['config/name="Demo Game"']);
  assert.deepEqual(d.added, ['config/name="Renamed"']);

  const doc2 = parseGodotConfigFile(out);
  assert.equal(getGodotConfigValue(doc2, "application", "config/name"), '"Renamed"');
  assert.equal(getGodotConfigValue(doc2, "application", "run/main_scene"), '"res://scenes/main.tscn"');
  assert.equal(getGodotConfigValue(doc2, "application", "config/features"), 'PackedStringArray("4.7", "Forward Plus")');
  assert.equal(getGodotConfigValue(doc2, "autoload", "Game"), '"*res://scripts/game.gd"');
  assert.equal(getGodotConfigValue(doc2, "unknown_section", "some_unknown_key"), "Vector3(1, 2, 3)");
  assert.match(getGodotConfigValue(doc2, "input", "jump") ?? "", /"deadzone": 0\.2/); // 多行值未受影响
});

test("project.godot 替换为多行值:旧行全删、新行全入,重新 parse 值完整", () => {
  const doc = parseGodotConfigFile(PROJECT_GODOT);
  assert.equal(
    setGodotConfigValue(doc, "input", "jump", '{\n"deadzone": 0.5,\n"events": [Object(InputEventKey,"physical_keycode":87)]\n}'),
    true,
  );
  const out = serializeGodotConfigFile(doc);
  const d = lineDiff(PROJECT_GODOT, out);
  // 首行 jump={ 与尾行 } 的首尾字符相同,落在公共前/后缀;真正变化的是中间 2 行
  assert.deepEqual(d.removed, ['"deadzone": 0.2,', '"events": [Object(InputEventKey,"physical_keycode":32)]']);
  assert.deepEqual(d.added, ['"deadzone": 0.5,', '"events": [Object(InputEventKey,"physical_keycode":87)]']);
  assert.equal(
    getGodotConfigValue(parseGodotConfigFile(out), "input", "jump"),
    '{\n"deadzone": 0.5,\n"events": [Object(InputEventKey,"physical_keycode":87)]\n}',
  );
});

test("project.godot set:不存在的段/键返回 false,不改动原文", () => {
  const doc = parseGodotConfigFile(PROJECT_GODOT);
  assert.equal(setGodotConfigValue(doc, "physics", "3d/default_gravity", "9.8"), false); // 段不存在
  assert.equal(setGodotConfigValue(doc, "application", "no/such/key", "1"), false); // 键不存在
  assert.equal(serializeGodotConfigFile(doc), PROJECT_GODOT);
});

test("project.godot 边界:非法格式抛 PARSE_ERROR 且带行号", () => {
  expectParseError(() => parseGodotConfigFile("[unclosed\n"), 1); // 段头不完整
  expectParseError(() => parseGodotConfigFile('[a]\nx={"unterminated\n'), 2); // 字符串未闭合
  expectParseError(() => parseGodotConfigFile("[a]\nx=Vector2(1, 2\n"), 2); // 括号未闭合
});

test("project.godot 边界:只有注释与空行的文件可解析且原样往返", () => {
  const only = "; comment\n\n; another\n";
  const doc = parseGodotConfigFile(only);
  assert.equal(doc.sections.length, 0);
  assert.equal(serializeGodotConfigFile(doc), only);
});

test("project.godot 无法识别的行按原文保留(无损)", () => {
  const weird = "[app]\nnot_a_pair\n; tail\n";
  assert.equal(serializeGodotConfigFile(parseGodotConfigFile(weird)), weird);
});

// ---------- .tscn / .tres ----------

test(".tscn / .tres round-trip: serialize(parse(x)) === x", () => {
  assert.equal(serializeGodotResource(parseGodotResource(MAIN_TSCN)), MAIN_TSCN);
  assert.equal(serializeGodotResource(parseGodotResource(MATERIAL_TRES)), MATERIAL_TRES);
});

test(".tscn round-trip: CRLF 行尾与注释/空行逐字节保留", () => {
  const crlf = "; header comment\r\n\r\n[gd_scene format=3]\r\n\r\n; trailing comment\r\n";
  assert.equal(serializeGodotResource(parseGodotResource(crlf)), crlf);
});

test(".tscn 段头属性与段筛选:按标签定位,属性原文(含引号)返回", () => {
  const doc = parseGodotResource(MAIN_TSCN);
  const scene = sectionByTag(doc, "gd_scene");
  assert.deepEqual(scene.attributes.map((a) => a.name), ["load_steps", "format", "uid"]);
  assert.equal(scene.attributes.find((a) => a.name === "uid")?.value, '"uid://testabc123"');

  assert.equal(findGodotResourceSections(doc, "ext_resource").length, 1);
  assert.equal(findGodotResourceSections(doc, "sub_resource").length, 1);
  assert.equal(findGodotResourceSections(doc, "node").length, 3);
  assert.equal(findGodotResourceSections(doc, "connection").length, 1);
});

test(".tscn 属性值原文:`=` 后的内容(含分隔空格)属于 value,prefix + value 逐字节还原", () => {
  const player = findGodotResourceSections(parseGodotResource(MAIN_TSCN), "node")[0]!;
  const entry = player.body.find((e): e is GodotResourceProperty => e.kind === "property" && e.name === "position");
  assert.ok(entry, "缺少 position 属性行");
  assert.equal(entry.prefix, "position =");
  assert.equal(entry.value, " Vector2(0, 0)");
});

test(".tscn 改节点属性:diff 只有一行,ext/sub_resource 引用与其他节点存留", () => {
  const doc = parseGodotResource(MAIN_TSCN);
  const player = findGodotResourceSections(doc, "node")[0]!;
  assert.equal(writeProp(player, "position", "Vector2(100, 200)"), true);
  const out = serializeGodotResource(doc);
  const d = lineDiff(MAIN_TSCN, out);
  assert.deepEqual(d.removed, ["position = Vector2(0, 0)"]);
  assert.deepEqual(d.added, ["position = Vector2(100, 200)"]);

  const doc2 = parseGodotResource(out);
  const player2 = findGodotResourceSections(doc2, "node")[0]!;
  assert.equal(readProp(player2, "position"), "Vector2(100, 200)");
  assert.equal(readProp(player2, "script"), 'ExtResource("1_script")');
  const collision = findGodotResourceSections(doc2, "node")[2]!;
  assert.equal(readProp(collision, "shape"), 'SubResource("RectangleShape2D_1")');
  assert.match(out, /\[ext_resource type="Script" path="res:\/\/scripts\/player\.gd" id="1_script"\]/);
});

test(".tscn set:属性不存在时返回 false,不改动原文", () => {
  const doc = parseGodotResource(MAIN_TSCN);
  const sprite = findGodotResourceSections(doc, "node")[1]!;
  assert.equal(setGodotResourceProperty(sprite, "texture", " ExtResource(\"1_tex\")"), false);
  assert.equal(serializeGodotResource(doc), MAIN_TSCN);
});

test(".tres 修改 sub_resource / resource 属性:diff 一行,多行字符串原样存留", () => {
  const doc = parseGodotResource(MATERIAL_TRES);
  assert.equal(writeProp(sectionByTag(doc, "resource"), "roughness", "0.75"), true);
  const out = serializeGodotResource(doc);
  assert.deepEqual(lineDiff(MATERIAL_TRES, out).removed, ["roughness = 0.5"]);
  assert.deepEqual(lineDiff(MATERIAL_TRES, out).added, ["roughness = 0.75"]);

  const doc2 = parseGodotResource(out);
  assert.equal(readProp(sectionByTag(doc2, "resource"), "roughness"), "0.75");
  assert.equal(readProp(sectionByTag(doc2, "sub_resource"), "script/source"), '"extends Node\\nfunc _ready(): pass\\n"');
  assert.equal(readProp(sectionByTag(doc2, "resource"), "albedo_color"), "Color(0.8, 0.2, 0.2, 1)");
});

test(".tscn 结构化节点视图:name/type/parent 解码,属性行与注释分离", () => {
  const nodes = getGodotSceneNodes(parseGodotResource(MAIN_TSCN));
  assert.equal(nodes.length, 3);
  assert.deepEqual(
    nodes.map((n) => [n.name, n.type, n.parent]),
    [["Player", "CharacterBody2D", undefined], ["Sprite", "Sprite2D", "."], ["Collision", "CollisionShape2D", "."]],
  );
  const player = nodes[0]!;
  assert.deepEqual(player.properties.map((p) => p.name), ["script", "position"]);
  assert.deepEqual(player.groups, []);
  assert.deepEqual(player.extraAttributes, []);
  assert.equal(player.section.tag, "node");
});

test(".tscn 边界:非法格式抛 PARSE_ERROR 且带行号", () => {
  expectParseError(() => parseGodotResource("stray line\n"), 1); // 缺少 [gd_scene]/[gd_resource] 头部
  expectParseError(() => parseGodotResource('[gd_scene format=3]\n[node bad header\n'), 2); // 段头缺少 ]
  expectParseError(() => parseGodotResource('[gd_scene format=3]\n[node name="A]\n'), 2); // 段头字符串未闭合
  expectParseError(() => parseGodotResource('[gd_scene format=3]\n\n[node name="A"]\ntext = "unclosed\n'), 4); // 值字符串未闭合
  expectParseError(() => parseGodotResource('[gd_scene format=3]\n\n[node name="A"]\nx=Vector3(1,2\n'), 4); // 括号未闭合
});

test(".tscn 边界:多行值内以 [ 开头的续行不会被误认为段头", () => {
  const tricky = '[gd_scene format=3]\n\n[node name="A"]\ndata=[\n[1, 2],\n[3, 4]\n]\n';
  assert.equal(serializeGodotResource(parseGodotResource(tricky)), tricky);
  const doc = parseGodotResource(tricky);
  assert.equal(readProp(findGodotResourceSections(doc, "node")[0]!, "data"), "[\n[1, 2],\n[3, 4]\n]");
});

// ---------- 真实 fixtures(样例就位后自动启用) ----------

test("fixtures: 真实样例逐字节往返无损(样例缺失时跳过)", (t) => {
  const dir = path.join(import.meta.dirname!, "..", "..", "tests", "fixtures", "sample_project");
  if (!fs.existsSync(dir)) {
    t.skip("tests/fixtures/sample_project 不存在:等待真实 Godot 4.7.2 样例(见 tests/fixtures/README.md)");
    return;
  }
  const files = fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map(String)
    .filter((f) => /\.(godot|tscn|tres)$/i.test(f));
  assert.ok(files.length > 0, "sample_project 存在但没有任何 .godot/.tscn/.tres");
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    if (path.basename(f) === "project.godot") {
      assert.equal(serializeGodotConfigFile(parseGodotConfigFile(src)), src, `round-trip failed: ${f}`);
    } else {
      assert.equal(serializeGodotResource(parseGodotResource(src)), src, `round-trip failed: ${f}`);
    }
  }
});
