// Stage 3 / T3:ScriptService(.gd GDScript 基础读取与安全更新)。
//
// 样例是手写的"代表性 .gd 文本",用于验证 extends/class_name/@export var 解析,
// 以及"只动目标行、其余字节不变"的安全更新(含 @export_range 注解与尾随 # 注释保留)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { GodotMcpError } from "../src/core/errors.js";
import { ScriptService } from "../src/services/scriptService.js";

const SCRIPT = `extends CharacterBody2D
class_name Player

@export var speed: float = 300.0
@export_range(0.0, 1000.0) var jump_velocity: float = -400.0
@export var label: String = "hi"
@export var colors: Array[Color] = [Color(1, 0, 0)]
@export var target: NodePath
@export var flag: bool = false

var health: int = 100

func _physics_process(delta: float) -> void:
\tvelocity = Vector2.ZERO
`;

const service = new ScriptService();

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

// ---------- getScriptInfo ----------

test("getScriptInfo: extends / class_name / @export var 结构", () => {
  const info = service.getScriptInfo(SCRIPT);
  assert.equal(info.extends, "CharacterBody2D");
  assert.equal(info.className, "Player");
  assert.deepEqual(info.exports, [
    { name: "speed", type: "float", default: "300.0" },
    { name: "jump_velocity", type: "float", default: "-400.0" },
    { name: "label", type: "String", default: '"hi"' },
    { name: "colors", type: "Array[Color]", default: "[Color(1, 0, 0)]" },
    { name: "target", type: "NodePath" },
    { name: "flag", type: "bool", default: "false" },
  ]);
});

test("getScriptInfo: 非 export 的普通 var 与函数不被收集", () => {
  const info = service.getScriptInfo(SCRIPT);
  assert.ok(!info.exports.some((e) => e.name === "health"));
});

test("GDScript intelligence: annotations, signals, enums, constants and method signatures", () => {
  const info = service.analyze(`@tool\nextends Node2D\nclass_name Actor\nsignal hit(target: Node, amount: int = 1)\nenum State { IDLE, RUN = 2 }\nconst SPEED: float = 3.0\nstatic func make(value: Vector2, scale: float = 1.0) -> Actor:\n\treturn null\n`);
  assert.deepEqual(info.annotations, ["@tool"]);
  assert.deepEqual(info.signals[0], { name: "hit", parameters: [{ name: "target", type: "Node" }, { name: "amount", type: "int", default: "1" }] });
  assert.deepEqual(info.enums[0], { name: "State", values: [{ name: "IDLE" }, { name: "RUN", value: "2" }] });
  assert.deepEqual(info.constants[0], { name: "SPEED", type: "float", value: "3.0" });
  assert.deepEqual(info.methods[0], { name: "make", line: 7, static: true, parameters: [{ name: "value", type: "Vector2" }, { name: "scale", type: "float", default: "1.0" }], returnType: "Actor", signature: "static func make(value: Vector2, scale: float = 1.0) -> Actor:" });
});

test("analyze: 识别函数、变量和信号", () => {
  const info = service.analyze(SCRIPT + "\nsignal health_changed(value: int)\nfunc take_damage(amount: int) -> void:\n\thealth -= amount\n");
  assert.deepEqual(info.symbols.filter((s) => ["signal", "function"].includes(s.kind)), [
    { name: "_physics_process", kind: "function", line: 13, signature: "func _physics_process(delta: float) -> void:" },
    { name: "health_changed", kind: "signal", line: 16, signature: "signal health_changed(value: int)" },
    { name: "take_damage", kind: "function", line: 17, signature: "func take_damage(amount: int) -> void:" },
  ]);
  assert.equal(info.symbols.find((s) => s.name === "health")?.kind, "variable");
});

test("findReferences: 返回定义与引用并忽略注释", () => {
  const refs = service.findReferences([{ path: "res://a.gd", text: "var speed = 1\nfunc go():\n\tprint(speed) # speed\n" }], "speed");
  assert.deepEqual(refs.map((r) => [r.line, r.kind]), [[1, "definition"], [3, "reference"]]);
});

test("updateFunction: 只替换目标函数,函数外内容不变", () => {
  const input = "extends Node\n\nfunc a():\n\treturn 1\n\nfunc b():\n\treturn 2\n\nvar tail = 3\n";
  const out = service.updateFunction(input, "a", "func a():\n\treturn 9").text;
  assert.match(out, /func a\(\):\n\treturn 9/);
  assert.match(out, /func b\(\):\n\treturn 2/);
  assert.match(out, /var tail = 3/);
  assert.throws(() => service.updateFunction(input, "missing", "func missing():\n\tpass"), isCode("INVALID_ARGUMENT"));
});

test("updateFunction: 相邻函数和文件末尾函数边界精确", () => {
  const adjacent = "func a():\n\tpass\nfunc b():\n\tpass\n";
  const a = service.updateFunction(adjacent, "a", "func a():\n\treturn 1").text;
  assert.equal(a, "func a():\n\treturn 1\nfunc b():\n\tpass\n");
  const eof = "func only():\n\tpass";
  assert.equal(service.updateFunction(eof, "only", "func only():\n\treturn 2").text, "func only():\n\treturn 2");
});

test("updateFunction: 忽略函數注释中的 func,保留 CRLF 和尾随顶层注释", () => {
  const input = "func a():\r\n\t# func fake():\r\n\tpass\r\n# file note\r\n";
  const result = service.updateFunction(input, "a", "func a():\n\treturn 3").text;
  assert.equal(result, "func a():\r\n\treturn 3\r\n# file note\r\n");
});

test("updateFunction: 遇到嵌套类、异步函数和其他顶层声明采取安全边界", () => {
  const nested = "func a():\n\tpass\nclass Inner:\n\tfunc go():\n\t\tpass\n";
  assert.throws(() => service.updateFunction(nested, "a", "func a():\n\treturn 1"), isCode("INVALID_ARGUMENT"));
  const between = "func a():\n\tpass\nvar marker = 1\nfunc b():\n\tpass\n";
  assert.throws(() => service.updateFunction(between, "a", "func a():\n\treturn 1"), isCode("INVALID_ARGUMENT"));
  const asyncFn = "func a():\n\tpass\nfunc b():\n\tawait get_tree().process_frame\n";
  assert.equal(service.updateFunction(asyncFn, "b", "func b():\n\tawait get_tree().process_frame\n\treturn").text.includes("func a():\n\tpass"), true);
});

// ---------- updateExportDefault ----------

test("updateExportDefault: 改已有默认值只动该行,其余字节不变", () => {
  const out = service.updateExportDefault(SCRIPT, "speed", "500.0");
  const d = lineDiff(SCRIPT, out);
  assert.deepEqual(d.removed, ["@export var speed: float = 300.0"]);
  assert.deepEqual(d.added, ["@export var speed: float = 500.0"]);
  assert.equal(service.getScriptInfo(out).exports.find((e) => e.name === "speed")?.default, "500.0");
  assert.ok(out.includes("class_name Player"));
});

test("updateExportDefault: 带 @export_range(...) 注解的变量同样可更新", () => {
  const out = service.updateExportDefault(SCRIPT, "jump_velocity", "-500.0");
  assert.deepEqual(lineDiff(SCRIPT, out).removed, ["@export_range(0.0, 1000.0) var jump_velocity: float = -400.0"]);
  assert.deepEqual(lineDiff(SCRIPT, out).added, ["@export_range(0.0, 1000.0) var jump_velocity: float = -500.0"]);
});

test("updateExportDefault: 无默认值(仅类型注解)补上默认值", () => {
  const out = service.updateExportDefault(SCRIPT, "target", 'NodePath("Player")');
  const d = lineDiff(SCRIPT, out);
  assert.deepEqual(d.removed, ["@export var target: NodePath"]);
  assert.deepEqual(d.added, ['@export var target: NodePath = NodePath("Player")']);
});

test("updateExportDefault: 幂等(同值写回逐字节相同)", () => {
  assert.equal(service.updateExportDefault(SCRIPT, "speed", "300.0"), SCRIPT);
});

test("updateExportDefault: 保留前导缩进与尾随 # 注释", () => {
  const input = "\t@export var health: int = 100 # max health\n";
  const out = service.updateExportDefault(input, "health", "120");
  assert.equal(out, "\t@export var health: int = 120 # max health\n");
});

test("updateExportDefault: 非法入参被拒绝(变量不存在/空值/不平衡值/非法名)", () => {
  assert.throws(() => service.updateExportDefault(SCRIPT, "nope", "1"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateExportDefault(SCRIPT, "speed", ""), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateExportDefault(SCRIPT, "speed", "Vector2(1, 2"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateExportDefault(SCRIPT, "bad name", "1"), isCode("INVALID_ARGUMENT"));
});
