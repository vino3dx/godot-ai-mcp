// P2:src/core/parser/literal.ts 的单元测试(写侧工具回报的结构化静态值)。
//
// 语义边界:认得的写法解析成 JSON 友好值;认不得的**只保留 raw**,不猜结构、不套引擎默认值。
// 这些值是文件里的静态字面量,不是引擎布局后的值(Control 的真实位置见 runtime_inspect_ui)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { literalChange, parseGodotLiteral, toLiteral } from "../src/core/parser/index.js";

test("parseGodotLiteral: 整数 / 浮点 / 科学计数 / 负数 / 布尔 / null", () => {
  assert.equal(parseGodotLiteral("0"), 0);
  assert.equal(parseGodotLiteral("7"), 7);
  assert.equal(parseGodotLiteral("-7"), -7);
  assert.equal(parseGodotLiteral("1.5"), 1.5);
  assert.equal(parseGodotLiteral("-0.25"), -0.25);
  assert.equal(parseGodotLiteral(".5"), 0.5);
  assert.equal(parseGodotLiteral("1e3"), 1000);
  assert.equal(parseGodotLiteral("1E+2"), 100);
  assert.equal(parseGodotLiteral("-1.2e-3"), -0.0012);
  assert.equal(parseGodotLiteral("  42  "), 42); // 解析前 trim,raw 仍由调用方保留
  assert.equal(parseGodotLiteral("true"), true);
  assert.equal(parseGodotLiteral("false"), false);
  assert.equal(parseGodotLiteral("null"), null);
});

test("parseGodotLiteral: 字符串(含转义)", () => {
  assert.equal(parseGodotLiteral('"Hello"'), "Hello");
  assert.equal(parseGodotLiteral('""'), "");
  assert.equal(parseGodotLiteral('"a\\"b"'), 'a"b');
  assert.equal(parseGodotLiteral('"a\\\\b"'), "a\\b");
  assert.equal(parseGodotLiteral('"tab\\there"'), "tab\there");
  assert.equal(parseGodotLiteral('"unterminated'), undefined);
  assert.equal(parseGodotLiteral('"\\q"'), undefined); // JSON 不认的转义 → 不猜
});

test("parseGodotLiteral: Vector2/3/4、Color、Rect2(含 i 变体)", () => {
  assert.deepEqual(parseGodotLiteral("Vector2(1, 2)"), { type: "Vector2", v: [1, 2] });
  assert.deepEqual(parseGodotLiteral("Vector2i(1, -2)"), { type: "Vector2i", v: [1, -2] });
  assert.deepEqual(parseGodotLiteral("Vector3(1, 2, 3)"), { type: "Vector3", v: [1, 2, 3] });
  assert.deepEqual(parseGodotLiteral("Vector3i(1, 2, 3)"), { type: "Vector3i", v: [1, 2, 3] });
  assert.deepEqual(parseGodotLiteral("Vector4(1, 2, 3, 4)"), { type: "Vector4", v: [1, 2, 3, 4] });
  assert.deepEqual(parseGodotLiteral("Color(1, 0.5, 0, 1)"), { type: "Color", v: [1, 0.5, 0, 1] });
  assert.deepEqual(parseGodotLiteral("Rect2(0, 0, 32, 32)"), { type: "Rect2", v: [0, 0, 32, 32] });
  assert.deepEqual(parseGodotLiteral("Rect2i(0, 0, 32, 32)"), { type: "Rect2i", v: [0, 0, 32, 32] });
  assert.deepEqual(parseGodotLiteral("  Vector2(1, 2)  "), { type: "Vector2", v: [1, 2] });
  // 已知取舍:只按"每个参数都是有限数字"放行,**不校验参数个数**(Vector2(1) 也照数返回)
  assert.deepEqual(parseGodotLiteral("Vector2(1)"), { type: "Vector2", v: [1] });
});

test("parseGodotLiteral: 认不得的写法一律 undefined(调用方只保留 raw)", () => {
  const opaque = [
    "Vector2()",                            // 空参数
    "Vector2(1, )",                         // 缺参数
    "Vector2(1, x)",                         // 非数字参数
    "Vector2(1, 2",                          // 不完整
    "Transform2D(1, 0, 0, 1, 0, 0)",         // 未支持的构造类型
    'ExtResource("1_abc")',
    'SubResource("Shape_1")',
    "[1, 2]",                                // 数组
    '{"a": 1}',                              // Dictionary
    '&"StringName"',
    'NodePath("..")',
    "inf",
    "nan",
    "",
  ];
  for (const raw of opaque) assert.equal(parseGodotLiteral(raw), undefined, `期望 undefined: ${JSON.stringify(raw)}`);
});

test("toLiteral: null 透传;认不得的值只给 raw(不含 value 字段)", () => {
  assert.equal(toLiteral(null), null);
  assert.deepEqual(toLiteral("Vector2(1, 2)"), { raw: "Vector2(1, 2)", value: { type: "Vector2", v: [1, 2] } });
  assert.deepEqual(toLiteral("Transform2D(1, 0, 0, 1, 0, 0)"), { raw: "Transform2D(1, 0, 0, 1, 0, 0)" });
  assert.equal("value" in (toLiteral("Transform2D(1, 0, 0, 1, 0, 0)") as object), false);
});

test("literalChange: 属性已在文件中 inFile=true;原本不在则 before=null 且 inFile=false", () => {
  assert.deepEqual(literalChange("position", "Vector2(0, 0)", "Vector2(1, 2)"), {
    property: "position",
    before: { raw: "Vector2(0, 0)", value: { type: "Vector2", v: [0, 0] } },
    after: { raw: "Vector2(1, 2)", value: { type: "Vector2", v: [1, 2] } },
    inFile: true,
  });
  assert.deepEqual(literalChange("z_index", null, "3"), {
    property: "z_index",
    before: null,
    after: { raw: "3", value: 3 },
    inFile: false,
  });
});
