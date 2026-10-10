// T4.5:以真实 Godot 为准的复验测试(不依赖 Godot 工程)。
//   1) 读取 tests/fixtures/godot-help.txt,断言 RUNTIME_FLAGS 里每个标志都出现(清单来自 run.ts 常量,避免重复手写)。
//   2) 真实冒烟:GODOT_BIN 存在时用 --headless --version 跑一次,断言退出码 0、流分离、未超时。
// GODOT_BIN 未设置时冒烟测试 skip —— 验收只允许这一类 skip。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultRunRunner, RUNTIME_FLAGS } from "../src/godot/runtime/run.js";

const HELP_TXT = path.join(import.meta.dirname!, "..", "..", "tests", "fixtures", "godot-help.txt");
const GODOT_BIN = process.env["GODOT_BIN"];

test("RUNTIME_FLAGS 里的每个标志都出现在 godot-help.txt", () => {
  const help = fs.readFileSync(HELP_TXT, "utf8");
  for (const flag of RUNTIME_FLAGS) {
    assert.ok(help.includes(flag), `标志 ${flag} 未出现在 godot-help.txt`);
  }
});

test(
  "smoke: 真实 Godot --headless --version 退出码 0、流分离",
  { skip: GODOT_BIN ? false : "GODOT_BIN 未设置" },
  async () => {
    const res = await defaultRunRunner(GODOT_BIN!, ["--headless", "--version"], { timeoutMs: 30_000 });
    assert.equal(res.exitCode, 0);
    assert.equal(res.timedOut, false);
    assert.equal(res.signal, null);
    // 版本串落在捕获的两个流之一:证明子进程输出进了管道(stdout/stderr 分离捕获),
    // 而非继承本进程 stdout —— 这是"不污染 MCP stdout"的结构性保证。
    assert.match(res.stdout + res.stderr, /\d+\.\d+\.\d+/);
  },
);
