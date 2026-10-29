// Stage 2 / T2.2:SceneService(.tscn 场景树读取与无损修改)。
//
// 样例是手写的"代表性 .tscn 文本"(真实样例待 tests/fixtures/sample_project 就位),
// 用于验证树结构提取与"除目标行外逐字节不变"的无损序列化。
import { test } from "node:test";
import assert from "node:assert/strict";
import { GodotMcpError } from "../src/core/errors.js";
import { parseGodotResource, serializeGodotResource } from "../src/core/parser/index.js";
import { SceneService } from "../src/services/sceneService.js";

const SCENE = `[gd_scene load_steps=3 format=3 uid="uid://scenetest"]

[ext_resource type="Script" path="res://scripts/player.gd" id="1_player"]

[node name="Main" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="."]
script = ExtResource("1_player")
position = Vector2(1, 2)
; player note

[node name="Sprite" type="Sprite2D" parent="Player"]
position = Vector2(0, 0)

[node name="Label" type="Label" parent="Player" groups=["ui"]]
text = "Hi"

[connection signal="ready" from="Player" to="." method="_on_ready"]
`;

const service = new SceneService();

test("findNodes: exact node path, subtree and static type categories", () => {
  assert.deepEqual(service.findNodes(SCENE, { nodePath: "Player" }).nodes.map((n) => n.path), ["Player"]);
  assert.deepEqual(service.findNodes(SCENE, { nodePath: "/root/Player", includeSubtree: true }).nodes.map((n) => n.path), ["Player", "Player/Sprite", "Player/Label"]);
  assert.deepEqual(service.findNodes(SCENE, { typeCategory: "control" }).nodes.map((n) => n.name), ["Label"]);
  assert.deepEqual(service.findNodes(SCENE, { type: "Sprite2D" }).nodes.map((n) => n.path), ["Player/Sprite"]);
});

test("findNodes: supports combined filters and bounded results", () => {
  const result = service.findNodes(SCENE, { pathPrefix: "/root/Player", group: "ui", maxResults: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.nodes.map((n) => n.path), ["Player/Label"]);
  assert.equal(service.findNodes(SCENE, { type: "Node2D" }).nodes[0]?.path, ".");
});

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
function assertLosslessPreserved(text: string): void {
  assert.equal(serializeGodotResource(parseGodotResource(text)), text);
}

// ---------- 场景树提取 ----------

test("getSceneTree: 根节点/子节点结构与规范 Path、parentPath", () => {
  const tree = service.getSceneTree(SCENE);
  assert.equal(tree.root?.name, "Main");
  assert.equal(tree.root?.path, ".");
  assert.equal(tree.root?.type, "Node2D");
  assert.equal(tree.root?.parentPath, undefined);
  assert.deepEqual(tree.root?.children.map((n) => n.path), ["Player"]);

  const player = tree.nodes.find((n) => n.path === "Player");
  assert.ok(player);
  assert.equal(player.type, "CharacterBody2D");
  assert.equal(player.parentPath, ".");
  assert.deepEqual(player.children.map((n) => n.path), ["Player/Sprite", "Player/Label"]);

  const sprite = tree.nodes.find((n) => n.path === "Player/Sprite");
  assert.equal(sprite?.parentPath, "Player");
  assert.equal(sprite?.type, "Sprite2D");
});

test("getSceneTree: 节点列表为深度优先且不丢节点", () => {
  const tree = service.getSceneTree(SCENE);
  assert.deepEqual(tree.nodes.map((n) => n.path), [".", "Player", "Player/Sprite", "Player/Label"]);
});

test("getSceneTree: 挂载脚本解析为 res:// 路径;分组与属性来自段头/段体", () => {
  const tree = service.getSceneTree(SCENE);
  const player = tree.nodes.find((n) => n.path === "Player");
  assert.equal(player?.script, "res://scripts/player.gd");
  assert.deepEqual(player?.properties, [
    { name: "script", value: 'ExtResource("1_player")' },
    { name: "position", value: "Vector2(1, 2)" },
  ]);

  const label = tree.nodes.find((n) => n.path === "Player/Label");
  assert.deepEqual(label?.groups, ["ui"]);
  assert.deepEqual(label?.properties, [{ name: "text", value: '"Hi"' }]);
});

test("getSceneTree: 段头字段(unique_id)与解析不到的 ExtResource 原文", () => {
  const tree = service.getSceneTree(
    '[gd_scene format=3]\n\n[node name="Root" type="Node"]\n\n[node name="Child" type="Node" parent="." unique_id=2]\nscript = ExtResource("9_missing")\n',
  );
  const child = tree.nodes.find((n) => n.path === "Child");
  assert.equal(child?.uniqueId, 2);
  assert.equal(child?.script, 'ExtResource("9_missing")');
});

// ---------- 修改节点属性 ----------

test("updateNodeProperty: 改已有属性只动该行,其余字节(含注释/connection)不变", () => {
  const out = service.updateNodeProperty(SCENE, "Player", "position", "Vector2(3, 4)");
  const d = lineDiff(SCENE, out);
  assert.deepEqual(d.removed, ["position = Vector2(1, 2)"]);
  assert.deepEqual(d.added, ["position = Vector2(3, 4)"]);
  assertLosslessPreserved(out);

  const player = service.getSceneTree(out).nodes.find((n) => n.path === "Player");
  assert.equal(player?.properties.find((p) => p.name === "position")?.value, "Vector2(3, 4)");
  assert.equal(player?.script, "res://scripts/player.gd");
  assert.ok(out.includes("; player note"));
  assert.ok(out.includes('[connection signal="ready" from="Player" to="." method="_on_ready"]'));
});

test("updateNodeProperty: 值未变化时输出与输入逐字节相同", () => {
  assert.equal(service.updateNodeProperty(SCENE, "Player", "position", "Vector2(1, 2)"), SCENE);
});

test("updateNodeProperty: 新增属性插入段体末尾(尾随空行之前)", () => {
  const out = service.updateNodeProperty(SCENE, "Player", "z_index", "10");
  assert.equal(out, SCENE.replace("; player note\n", "; player note\nz_index = 10\n"));
  assertLosslessPreserved(out);
  assert.equal(service.getSceneTree(out).nodes.find((n) => n.path === "Player")?.properties.at(-1)?.value, "10");
});

test("updateNodeProperty: 路径可用 /root 前缀与 ./ 相对写法", () => {
  const out = service.updateNodeProperty(SCENE, "/root/Player/Sprite", "z_index", "5");
  assert.equal(out, SCENE.replace("position = Vector2(0, 0)\n\n", "position = Vector2(0, 0)\nz_index = 5\n\n"));
  assertLosslessPreserved(out);
  // 根节点路径为 "."(或 /root);节点名不是路径
  assert.equal(
    service.updateNodeProperty(SCENE, "/root", "metadata/extra", "1"),
    service.updateNodeProperty(SCENE, ".", "metadata/extra", "1"),
  );
});

test("updateNodeProperty: 支持多行值(Dictionary),再解析后值完整", () => {
  const out = service.updateNodeProperty(SCENE, ".", "metadata/extra", '{\n"a": 1\n}');
  assert.equal(out, SCENE.replace('[node name="Main" type="Node2D"]\n', '[node name="Main" type="Node2D"]\nmetadata/extra = {\n"a": 1\n}\n'));
  assertLosslessPreserved(out);
  const main = service.getSceneTree(out).nodes.find((n) => n.path === ".");
  assert.equal(main?.properties.find((p) => p.name === "metadata/extra")?.value, '{\n"a": 1\n}');
});

test("updateNodeProperty: 非法入参被拒绝(空名/段头字段/空值/不平衡值/节点不存在)", () => {
  assert.throws(() => service.updateNodeProperty(SCENE, "Player", "", "1"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateNodeProperty(SCENE, "Player", "groups", '["x"]'), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateNodeProperty(SCENE, "Player", "position", ""), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateNodeProperty(SCENE, "Player", "position", '"unterminated'), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateNodeProperty(SCENE, "Player", "position", "Vector2(1, 2"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateNodeProperty(SCENE, "Player", "position", "Vector2(1, 2))"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateNodeProperty(SCENE, "Ghost", "position", "Vector2(1, 2)"), isCode("INVALID_ARGUMENT"));
});

// ---------- 删除节点 ----------

test("removeNode: 删叶子节点时只移除该段(含尾随空行),兄弟节点与 connection 不变", () => {
  const out = service.removeNode(SCENE, "Player/Sprite");
  assert.equal(out, SCENE.replace('[node name="Sprite" type="Sprite2D" parent="Player"]\nposition = Vector2(0, 0)\n\n', ""));
  assertLosslessPreserved(out);

  const tree = service.getSceneTree(out);
  assert.deepEqual(tree.nodes.map((n) => n.path), [".", "Player", "Player/Label"]);
  assert.equal(tree.nodes.find((n) => n.path === "Player")?.script, "res://scripts/player.gd");
  assert.ok(out.includes('[connection signal="ready" from="Player" to="." method="_on_ready"]'));
});

test("removeNode: 删父节点连带整棵子树,其余段逐字节不变", () => {
  const out = service.removeNode(SCENE, "Player");
  const head = SCENE.slice(0, SCENE.indexOf('[node name="Player"'));
  const tail = SCENE.slice(SCENE.indexOf("[connection signal="));
  assert.equal(out, head + tail);
  assertLosslessPreserved(out);

  const tree = service.getSceneTree(out);
  assert.deepEqual(tree.nodes.map((n) => n.path), ["."]);
  assert.ok(out.includes('[ext_resource type="Script" path="res://scripts/player.gd" id="1_player"]'));
});

test("removeNode: 路径规范化(/root 前缀与 ./ 等价)", () => {
  const a = service.removeNode(SCENE, "Player/Sprite");
  assert.equal(service.removeNode(SCENE, "/root/Player/Sprite"), a);
  assert.equal(service.removeNode(SCENE, "./Player/Sprite"), a);
});

test("removeNode: 拒绝删根节点与不存在的节点", () => {
  assert.throws(() => service.removeNode(SCENE, "."), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.removeNode(SCENE, "/root"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.removeNode(SCENE, "Ghost"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.removeNode(SCENE, "Player/Ghost"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.removeNode(SCENE, "  "), isCode("INVALID_ARGUMENT"));
});

test("removeNode: 目标名只是其他节点名的前缀时不误删(Player vs Player2)", () => {
  const scene = '[gd_scene format=3]\n\n[node name="Root" type="Node"]\n\n[node name="Player" type="Node" parent="."]\n\n[node name="Player2" type="Node" parent="."]\n';
  const out = service.removeNode(scene, "Player");
  assert.equal(out, '[gd_scene format=3]\n\n[node name="Root" type="Node"]\n\n[node name="Player2" type="Node" parent="."]\n');
  assert.deepEqual(service.getSceneTree(out).nodes.map((n) => n.path), [".", "Player2"]);
});
