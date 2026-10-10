// Stage 3 / T3:ShaderService(.gdshader 基础读取与安全更新)。
//
// 样例是手写的"代表性 .gdshader 文本",用于验证 shader_type/render_mode/uniform 解析,
// 以及"只动目标行、其余字节不变"的安全更新(含缩进与尾随 // 注释保留)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { GodotMcpError } from "../src/core/errors.js";
import { ShaderService } from "../src/services/shaderService.js";

const SHADER = `shader_type spatial;
render_mode unshaded, cull_disabled, depth_draw_always;

uniform vec3 albedo : source_color = vec3(1.0);
uniform float roughness : hint_range(0.0, 1.0) = 0.5;
uniform sampler2D albedo_texture;
uniform int count = 5;

void fragment() {
\tALBEDO = texture(albedo_texture, UV).rgb * albedo;
}
`;

const service = new ShaderService();

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

// ---------- getShaderInfo ----------

test("getShaderInfo: shader_type / render_mode / uniform 结构", () => {
  const info = service.getShaderInfo(SHADER);
  assert.equal(info.shaderType, "spatial");
  assert.deepEqual(info.renderModes, ["unshaded", "cull_disabled", "depth_draw_always"]);
  assert.deepEqual(info.uniforms, [
    { name: "albedo", type: "vec3", hint: "source_color", default: "vec3(1.0)" },
    { name: "roughness", type: "float", hint: "hint_range(0.0, 1.0)", default: "0.5" },
    { name: "albedo_texture", type: "sampler2D" },
    { name: "count", type: "int", default: "5" },
  ]);
});

test("getShaderInfo: 行尾 // 注释被忽略,不影响 uniform 解析", () => {
  const info = service.getShaderInfo('shader_type canvas_item;\n\nuniform vec4 tint : source_color = vec4(1.0); // UI tint\n');
  assert.equal(info.shaderType, "canvas_item");
  assert.deepEqual(info.uniforms, [{ name: "tint", type: "vec4", hint: "source_color", default: "vec4(1.0)" }]);
});

// ---------- updateUniformDefault ----------

test("updateUniformDefault: 改已有默认值只动该行,其余字节不变", () => {
  const out = service.updateUniformDefault(SHADER, "roughness", "0.75");
  const d = lineDiff(SHADER, out);
  assert.deepEqual(d.removed, ["uniform float roughness : hint_range(0.0, 1.0) = 0.5;"]);
  assert.deepEqual(d.added, ["uniform float roughness : hint_range(0.0, 1.0) = 0.75;"]);
  assert.equal(service.getShaderInfo(out).uniforms.find((u) => u.name === "roughness")?.default, "0.75");
  assert.ok(out.includes("shader_type spatial;"));
});

test("updateUniformDefault: 无默认值的 uniform 补上默认值", () => {
  const out = service.updateUniformDefault(SHADER, "albedo_texture", "texture_unit");
  const d = lineDiff(SHADER, out);
  assert.deepEqual(d.removed, ["uniform sampler2D albedo_texture;"]);
  assert.deepEqual(d.added, ["uniform sampler2D albedo_texture = texture_unit;"]);
});

test("updateUniformDefault: 幂等(同值写回逐字节相同)", () => {
  assert.equal(service.updateUniformDefault(SHADER, "roughness", "0.5"), SHADER);
});

test("updateUniformDefault: 保留前导缩进与尾随 // 注释", () => {
  const input = "\tuniform float speed = 1.0; // meters/s\n";
  const out = service.updateUniformDefault(input, "speed", "2.0");
  assert.equal(out, "\tuniform float speed = 2.0; // meters/s\n");
});

test("updateUniformDefault: 非法入参被拒绝(uniform 不存在/空值/不平衡值/非法名)", () => {
  assert.throws(() => service.updateUniformDefault(SHADER, "nope", "1.0"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateUniformDefault(SHADER, "roughness", ""), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateUniformDefault(SHADER, "roughness", "vec3(1.0"), isCode("INVALID_ARGUMENT"));
  assert.throws(() => service.updateUniformDefault(SHADER, "bad name", "1.0"), isCode("INVALID_ARGUMENT"));
});
