// Stage 2 / T2.3:ResourceService(.tres 信息读取与无损修改)。
//
// 样例是手写的"代表性 .tres 文本"(真实样例待 tests/fixtures/sample_project 就位),
// 用于验证依赖提取、属性修改与"除目标行外逐字节不变"的无损序列化。
import { test } from "node:test";
import assert from "node:assert/strict";
import { GodotMcpError } from "../src/core/errors.js";
import { parseGodotResource, serializeGodotResource } from "../src/core/parser/index.js";
import { ResourceService } from "../src/services/resourceService.js";

const MATERIAL = `[gd_resource type="StandardMaterial3D" load_steps=3 format=3 uid="uid://mat123"]

[ext_resource type="Script" path="res://scripts/mat.gd" id="1_mat"]

[sub_resource type="GDScript" id="GDScript_1"]
script/source = "extends Resource\\nfunc hi(): pass\\n"

[resource]
script = ExtResource("1_mat")
albedo_color = Color(0.8, 0.2, 0.2, 1)
; material note
roughness = 0.5
`;

const service = new ResourceService();

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
  assert.equal(serializeGodotResource(parseGodotResource(text)), text);
}

// ---------- getResourceInfo ----------

test("getResourceInfo: 头部 / 外部依赖(含 UID) / 子资源结构", () => {
  const info = service.getResourceInfo(MATERIAL);
  assert.equal(info.type, "StandardMaterial3D");
  assert.equal(info.format, 3);
  assert.equal(info.loadSteps, 3);
  assert.equal(info.uid, "uid://mat123");
  assert.equal(info.scriptClass, undefined);
  assert.deepEqual(info.externalResources, [{ id: "1_mat", type: "Script", path: "res://scripts/mat.gd" }]);
  assert.equal(info.externalResources[0]?.uid, undefined);
  assert.deepEqual(info.subResources.map((s) => [s.id, s.type]), [["GDScript_1", "GDScript"]]);
  assert.deepEqual(info.subResources[0]?.properties, [
    { name: "script/source", value: '"extends Resource\\nfunc hi(): pass\\n"' },
  ]);
});

test("getResourceInfo: script_class 与带 UID 的 ext_resource", () => {
  const info = service.getResourceInfo(
    '[gd_resource type="Resource" script_class="MyThing" format=3]\n\n[ext_resource type="Script" path="res://a.gd" id="1" uid="uid://a1"]\n\n[resource]\nx = 1\n',
  );
  assert.equal(info.scriptClass, "MyThing");
  assert.deepEqual(info.externalResources, [{ id: "1", type: "Script", path: "res://a.gd", uid: "uid://a1" }]);
});

// ---------- updateResourceProperty ----------

test("updateResourceProperty: 改 [resource] 已有属性只动该行,其余字节(含注释)不变", () => {
  const out = service.updateResourceProperty(MATERIAL, "resource", "roughness", "0.75");
  const d = lineDiff(MATERIAL, out);
  assert.deepEqual(d.removed, ["roughness = 0.5"]);
  assert.deepEqual(d.added, ["roughness = 0.75"]);
  assertLossless(out);
  assert.ok(out.includes("; material note"));
  assert.ok(out.includes('script = ExtResource("1_mat")'));

  const info = service.getResourceInfo(out); // 依赖结构未受影响
  assert.deepEqual(info.externalResources, [{ id: "1_mat", type: "Script", path: "res://scripts/mat.gd" }]);
  assert.equal(info.subResources[0]?.properties[0]?.value, '"extends Resource\\nfunc hi(): pass\\n"');
});

test("updateResourceProperty: 按 sub_resource id 修改子资源属性,diff 只有一行", () => {
  const out = service.updateResourceProperty(MATERIAL, "GDScript_1", "script/source", '"extends Node\\n"');
  const d = lineDiff(MATERIAL, out);
  assert.deepEqual(d.removed, ['script/source = "extends Resource\\nfunc hi(): pass\\n"']);
  assert.deepEqual(d.added, ['script/source = "extends Node\\n"']);
  assertLossless(out);
  assert.equal(service.getResourceInfo(out).subResources[0]?.properties[0]?.value, '"extends Node\\n"');
});

test("updateResourceProperty: 新增属性插入段体末尾([resource] 与 sub_resource)", () => {
  const main = service.updateResourceProperty(MATERIAL, "resource", "metallic", "0.1");
  assert.equal(main, MATERIAL.replace("roughness = 0.5\n", "roughness = 0.5\nmetallic = 0.1\n"));
  assertLossless(main);

  const sub = service.updateResourceProperty(MATERIAL, "GDScript_1", "advanced", "true");
  assert.equal(sub, MATERIAL.replace('script/source = "extends Resource\\nfunc hi(): pass\\n"\n', 'script/source = "extends Resource\\nfunc hi(): pass\\n"\nadvanced = true\n'));
  assertLossless(sub);
});

test("updateResourceProperty: 值未变化时输出与输入逐字节相同", () => {
  assert.equal(service.updateResourceProperty(MATERIAL, "resource", "roughness", "0.5"), MATERIAL);
});

test("updateResourceProperty: 支持多行值(Dictionary),再读取后值完整", () => {
  const out = service.updateResourceProperty(MATERIAL, "resource", "metadata/meta", '{\n"key": "v"\n}');
  assert.equal(out, MATERIAL.replace("roughness = 0.5\n", 'roughness = 0.5\nmetadata/meta = {\n"key": "v"\n}\n'));
  assertLossless(out);
});

test("updateResourceProperty: 非法入参被拒绝(空段/未知段/sub 段头字段/空值/不平衡值)", () => {
  assert.throws(() => service.updateResourceProperty(MATERIAL, "  ", "x", "1"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateResourceProperty(MATERIAL, "Nope", "x", "1"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateResourceProperty(MATERIAL, "GDScript_1", "type", '"X"'), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateResourceProperty(MATERIAL, "GDScript_1", "id", '"x"'), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateResourceProperty(MATERIAL, "resource", "roughness", ""), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateResourceProperty(MATERIAL, "resource", "roughness", '"unterminated'), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateResourceProperty(MATERIAL, "resource", "roughness", "Color(1, 2"), isCode("INVALID_ARGUMENT"));
});

// ---------- addOrUpdateExternalResource ----------

test("addOrUpdateExternalResource: 按 id 更新 type/path,diff 只有一行", () => {
  const out = service.addOrUpdateExternalResource(MATERIAL, { id: "1_mat", type: "Script", path: "res://scripts/other.gd" });
  const d = lineDiff(MATERIAL, out);
  assert.deepEqual(d.removed, ['[ext_resource type="Script" path="res://scripts/mat.gd" id="1_mat"]']);
  assert.deepEqual(d.added, ['[ext_resource type="Script" path="res://scripts/other.gd" id="1_mat"]']);
  assertLossless(out);
  assert.deepEqual(service.getResourceInfo(out).externalResources, [
    { id: "1_mat", type: "Script", path: "res://scripts/other.gd" },
  ]);
});

test("addOrUpdateExternalResource: 同值更新幂等;给已有条目补 uid(追加到 ] 前)", () => {
  assert.equal(
    service.addOrUpdateExternalResource(MATERIAL, { id: "1_mat", type: "Script", path: "res://scripts/mat.gd" }),
    MATERIAL,
  );
  const out = service.addOrUpdateExternalResource(MATERIAL, { id: "1_mat", type: "Script", path: "res://scripts/mat.gd", uid: "uid://s1" });
  assert.deepEqual(lineDiff(MATERIAL, out).added, ['[ext_resource type="Script" path="res://scripts/mat.gd" id="1_mat" uid="uid://s1"]']);
  assert.deepEqual(service.getResourceInfo(out).externalResources, [
    { id: "1_mat", type: "Script", path: "res://scripts/mat.gd", uid: "uid://s1" },
  ]);
});

test("addOrUpdateExternalResource: 新增条目插在最后一个 ext_resource 之后", () => {
  const out = service.addOrUpdateExternalResource(MATERIAL, { id: "2_tex", type: "Texture2D", path: "res://icon.svg" });
  assert.equal(
    out,
    MATERIAL.replace(
      '[ext_resource type="Script" path="res://scripts/mat.gd" id="1_mat"]\n\n',
      '[ext_resource type="Script" path="res://scripts/mat.gd" id="1_mat"]\n\n[ext_resource type="Texture2D" path="res://icon.svg" id="2_tex"]\n\n',
    ),
  );
  assertLossless(out);
  assert.deepEqual(service.getResourceInfo(out).externalResources.map((e) => e.id), ["1_mat", "2_tex"]);
});

test("addOrUpdateExternalResource: 文件没有 ext_resource 时紧跟 gd_resource 头之后新增(uid 用规范顺序)", () => {
  const noExt = '[gd_resource type="LabelSettings" format=3]\n\n[resource]\nfont_size = 12\n';
  const out = service.addOrUpdateExternalResource(noExt, { id: "1_f", type: "FontFile", path: "res://font.ttf", uid: "uid://f1" });
  assert.equal(
    out,
    '[gd_resource type="LabelSettings" format=3]\n\n[ext_resource type="FontFile" uid="uid://f1" path="res://font.ttf" id="1_f"]\n\n[resource]\nfont_size = 12\n',
  );
  assertLossless(out);
});

test("addOrUpdateExternalResource: 同 path+type 复用已有条目,不产生重复(id 以现有为准)", () => {
  const out = service.addOrUpdateExternalResource(MATERIAL, { id: "9_other", type: "Script", path: "res://scripts/mat.gd" });
  assert.equal(out, MATERIAL); // 复用且无需变更:输出逐字节不变
  const withUid = service.addOrUpdateExternalResource(MATERIAL, { id: "9_other", type: "Script", path: "res://scripts/mat.gd", uid: "uid://s2" });
  assert.deepEqual(lineDiff(MATERIAL, withUid).added, ['[ext_resource type="Script" path="res://scripts/mat.gd" id="1_mat" uid="uid://s2"]']);
  assert.equal(service.getResourceInfo(withUid).externalResources.length, 1);
});

test("addOrUpdateExternalResource: 更新时未知属性、间距与转义逐字节保留", () => {
  const weird = '[gd_resource type="X" format=3]\n\n[ext_resource type="Script" path="res://a.gd" id="1" check=7  extra="keep"]\n\n[resource]\nx = 1\n';
  const out = service.addOrUpdateExternalResource(weird, { id: "1", type: "Script", path: "res://b.gd" });
  assert.equal(out, weird.replace('path="res://a.gd"', 'path="res://b.gd"'));
  assertLossless(out);
});

test("addOrUpdateExternalResource: 非法字段被拒绝(空/含引号/含换行)", () => {
  assert.throws(() => service.addOrUpdateExternalResource(MATERIAL, { id: "", type: "Script", path: "res://a.gd" }), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.addOrUpdateExternalResource(MATERIAL, { id: "1", type: 'Sc"ript', path: "res://a.gd" }), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.addOrUpdateExternalResource(MATERIAL, { id: "1", type: "Script", path: "res://a\nb.gd" }), isCode("INVALID_ARGUMENT"));
});
