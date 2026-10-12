// T6.5:用真实 Godot 4.6.3 验证 T6 写侧工具产出的 .tscn 文本是否被引擎接受。
//
// 流程:把 tests/fixture_project 拷到临时目录 → 用 T6 工具把综合场景一个个构造出来
// → 拷入 tests/fixtures/t6_verify.gd → 引擎 `--headless --script` 加载并断言(节点树 /
// groups / 实例是否解析 / 连接 flags / 脚本挂载)→ 引擎自己 pack+save 出 .tscn,
// 与本测试写出的文本做归一化 diff。
//
// 约定:真实测试只读环境变量 GODOT_BIN,未设置则整组 skip(与 runtime.real.test.ts 同)。
// 调试用逃生口:T65_KEEP=1 时不删临时目录,便于人工查看引擎 save 出来的文件。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { defaultRunRunner } from "../src/godot/runtime/run.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { createAppContext } from "../src/services/context.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";
import type { AppContext } from "../src/services/context.js";

const FIXTURE = path.join(import.meta.dirname!, "..", "..", "tests", "fixture_project");
const VERIFY_GD = path.join(import.meta.dirname!, "..", "..", "tests", "fixtures", "t6_verify.gd");
const GODOT_BIN = process.env["GODOT_BIN"];
const TIMEOUT_MS = 60_000;
const SCENE = "res://scenes/main.tscn";
const ENGINE_SAVED = "t6_engine_saved.tscn";

const quiet = createLogger("error", () => {});

interface Host { dir: string; host: ToolHost<AppContext> }

function makeHost(t: { after: (fn: () => void) => void }): Host {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-t65-"));
  t.after(() => {
    if (process.env["T65_KEEP"] === "1") {
      console.log(`T6_5 temp dir kept: ${dir}`);
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: dir }));
  return { dir, host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet) };
}

function ok(r: ToolResult): Record<string, unknown> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; data: unknown }).data as Record<string, unknown>;
}

/** 归一化后用于 diff:去掉引擎自造的空格/uid/unique_id/id 差异,只比"写法骨架"。 */
function shape(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) =>
      l
        .replace(/\s*unique_id=\d+/g, "")
        .replace(/\suid="[^"]*"/g, "")
        .replace(/\sid="[^"]*"/g, " id=ID")
        .replace(/ExtResource\("[^"]*"\)/g, 'ExtResource("ID")')
        .replace(/SubResource\("[^"]*"\)/g, 'SubResource("ID")'),
    );
}

test(
  "real: T6 写侧工具构造的场景被 Godot 4.6.3 加载、断言并按引擎写法回写",
  { skip: GODOT_BIN ? false : "GODOT_BIN 未设置" },
  async (t) => {
    const { dir, host } = makeHost(t);

    // ── 1) 用 T6 工具把综合场景构造出来 ──────────────────────────────────────
    ok(await host.callTool("scene_add_node", {
      path: SCENE, parentPath: ".", nodeType: "Node2D", nodeName: "Level",
      properties: [{ name: "position", value: "Vector2(16, 32)" }],
    }));
    ok(await host.callTool("scene_add_node", { path: SCENE, parentPath: "Level", nodeType: "Node2D", nodeName: "Holder" }));
    ok(await host.callTool("scene_add_node", {
      path: SCENE, parentPath: "Level/Holder", nodeType: "Marker2D", nodeName: "Mark",
      properties: [{ name: "position", value: "Vector2(1, 2)" }],
    }));
    // 挂脚本:用已存在的 ext_resource("1_player" = res://scripts/player.gd, extends CharacterBody2D)
    ok(await host.callTool("scene_add_node", {
      path: SCENE, parentPath: ".", nodeType: "CharacterBody2D", nodeName: "Scripted",
      properties: [{ name: "script", value: 'ExtResource("1_player")' }],
    }));
    ok(await host.callTool("scene_reparent_node", { path: SCENE, nodePath: "Level/Holder", newParentPath: "Player" }));
    ok(await host.callTool("scene_add_to_group", { path: SCENE, nodePath: "Player", group: "t6_a" }));
    ok(await host.callTool("scene_add_to_group", { path: SCENE, nodePath: "Player", group: "t6_b" }));
    ok(await host.callTool("scene_add_to_group", { path: SCENE, nodePath: "Level", group: "t6_a" }));
    const inst = ok(await host.callTool("scene_instantiate_scene", { path: SCENE, parentPath: "Level", instanceScenePath: "res://scenes/child.tscn" }));
    assert.equal(inst["instanceId"], "3_mcp");
    ok(await host.callTool("script_create", {
      scriptPath: "res://scripts/t6_generated.gd", content: 'extends Node\n\nvar created_by := "T6"\n',
    }));
    ok(await host.callTool("scene_connect_signal", { path: SCENE, sourcePath: "Player", signal: "tree_exited", targetPath: ".", method: "_on_ready" }));
    ok(await host.callTool("scene_connect_signal", { path: SCENE, sourcePath: "Player", signal: "visibility_changed", targetPath: ".", method: "_on_ready", flags: 1 }));
    ok(await host.callTool("scene_connect_signal", { path: SCENE, sourcePath: "Player", signal: "tree_exiting", targetPath: ".", method: "_on_ready", flags: 3 }));
    ok(await host.callTool("scene_connect_signal", { path: SCENE, sourcePath: "Level", signal: "tree_exited", targetPath: ".", method: "_on_ready", flags: 4 }));
    ok(await host.callTool("scene_connect_signal", { path: SCENE, sourcePath: "Level", signal: "visibility_changed", targetPath: ".", method: "_on_ready", flags: 7 }));

    const ourText = fs.readFileSync(path.join(dir, "scenes", "main.tscn"), "utf8");
    assert.ok(!ourText.includes('name="Marker"'), "子场景内部的 Marker 不得被展开进本文件");

    // ── 2) 引擎加载 + 断言,并按引擎写法 pack+save ──────────────────────────
    fs.copyFileSync(VERIFY_GD, path.join(dir, "t6_verify.gd"));
    const res = await defaultRunRunner(
      GODOT_BIN!,
      ["--headless", "--path", dir, "--script", path.join(dir, "t6_verify.gd"), "--", "--scene", SCENE, "--out", `res://${ENGINE_SAVED}`],
      { timeoutMs: TIMEOUT_MS },
    );
    const output = `${res.stdout}\n${res.stderr}`;
    const results = res.stdout.split(/\r?\n/).filter((l) => l.startsWith("T6RESULT ")).map((l) => l.slice("T6RESULT ".length));
    console.log(`--- T6.5 引擎断言原始输出 ---\n${results.join("\n")}`);

    // 引擎的报错/警告一律算失败项
    const noisy = output.split(/\r?\n/).filter((l) => /\bERROR\b|\bWARNING\b|SCRIPT ERROR/.test(l));
    assert.deepEqual(noisy, [], `Godot 报错/警告:\n${noisy.join("\n")}`);
    assert.equal(res.exitCode, 0, `Godot 退出码非 0\n${output}`);
    assert.equal(res.timedOut, false, `Godot 超时\n${output}`);
    assert.ok(results.includes("ok"), `验证脚本未跑完:\n${res.stdout}\n${res.stderr}`);

    // ── 3) 逐条核对引擎读到的事实 ──────────────────────────────────────────
    const tree = results.filter((r) => r.startsWith("tree|")).map((r) => {
      const [, nodePath, type, groups] = r.split("|");
      return { path: nodePath!, type: type!, groups: (groups ?? "").split(",").filter((g) => g !== "") };
    });
    assert.deepEqual(
      tree.map((n) => `${n.path}:${n.type}`),
      [
        ".:Node2D",
        "Player:CharacterBody2D",
        "Player/Sprite:Sprite2D",
        "Player/Holder:Node2D",
        "Player/Holder/Mark:Marker2D",
        "Level:Node2D",
        "Level/Child:Node2D",
        "Level/Child/Marker:Marker2D", // 来自被实例化的子场景(运行时存在,文本里没有)
        "Scripted:CharacterBody2D",
      ],
    );
    assert.deepEqual(tree.find((n) => n.path === "Player")?.groups.slice().sort(), ["t6_a", "t6_b"]);
    assert.deepEqual(tree.find((n) => n.path === "Level")?.groups, ["t6_a"]);
    assert.equal(results.find((r) => r.startsWith("group_is_in|")), "group_is_in|true");

    // 连接:实测(4.6.3)引擎加载 .tscn 的 [connection] 时会把
    // CONNECT_PERSIST(2) | CONNECT_INHERITED(32) 并进 flags,所以我们写的位掩码
    // 在引擎侧读回 = 请求值 | 34;DEFERRED(1)/ONE_SHOT(4) 位原样保留。
    const LOADER_BASE_FLAGS = 34;
    const conns = results.filter((r) => r.startsWith("conn|")).map((r) => {
      const [, from, signal, to, method, flags] = r.split("|");
      return { from: from!, signal: signal!, to: to!, method: method!, flags: Number(flags) };
    });
    const requested: Array<{ from: string; signal: string; flags: number }> = [
      { from: "Player", signal: "ready", flags: 0 }, // 夹具里已有的连接(无 flags=)
      { from: "Player", signal: "tree_exited", flags: 0 },
      { from: "Player", signal: "visibility_changed", flags: 1 },
      { from: "Player", signal: "tree_exiting", flags: 3 },
      { from: "Level", signal: "tree_exited", flags: 4 },
      { from: "Level", signal: "visibility_changed", flags: 7 },
    ];
    assert.equal(conns.length, requested.length);
    for (const want of requested) {
      const got = conns.find((c) => c.from === want.from && c.signal === want.signal);
      assert.ok(got, `缺少连接 ${want.from}.${want.signal}`);
      assert.equal(got.flags, want.flags | LOADER_BASE_FLAGS, `${want.from}.${want.signal} flags`);
      assert.equal(got.to, ".", `${want.from}.${want.signal} 目标节点`);
      assert.equal(got.method, "_on_ready", `${want.from}.${want.signal} 方法名`);
    }

    // 持久化的 [connection] 真的会触发(root.gd 的 ready_calls):
    // 入树前为 0(证明上面的读取发生在任何信号触发之前);入树后一帧内实测 3 次
    // = Player.ready(1) + Player.visibility_changed(1) + Level.visibility_changed(1)。
    assert.equal(results.find((r) => r.startsWith("ready_calls_now|")), "ready_calls_now|0");
    assert.equal(results.find((r) => r.startsWith("ready_calls|")), "ready_calls|3");
    assert.ok(results.some((r) => r === "root_on_ready|called"), "持久化连接未触发回调");

    // 实例:引擎认得出这是个子场景实例,且内部节点来自子场景。
    // (场景根自身也会带 scene_file_path,故这里按行精确匹配 Level/Child。)
    assert.ok(
      results.includes("instance|Level/Child|res://scenes/child.tscn|yes"),
      `实例未被引擎识别为子场景引用:\n${results.filter((r) => r.startsWith("instance|")).join("\n")}`,
    );

    // 脚本挂载与 script_create 生成的文件
    assert.deepEqual(
      results.filter((r) => r.startsWith("script|")).sort(),
      ["script|Player|res://scripts/player.gd", "script|Scripted|res://scripts/player.gd", "script|.|res://scripts/root.gd"].sort(),
    );
    assert.equal(results.find((r) => r.startsWith("load_script|")), "load_script|res://scripts/t6_generated.gd|ok");
    assert.equal(results.find((r) => r.startsWith("pack|")), "pack|0");
    assert.equal(results.find((r) => r.startsWith("save|")), "save|0");

    // ── 4) 引擎 save 出来的文本 vs 我们写出的文本 ──────────────────────────
    const enginePath = path.join(dir, ENGINE_SAVED);
    assert.ok(fs.existsSync(enginePath), `引擎未写出 ${ENGINE_SAVED}\n${output}`);
    const engineText = fs.readFileSync(enginePath, "utf8");
    const ours = shape(ourText);
    const theirs = shape(engineText);
    const onlyOurs = ours.filter((l) => !theirs.includes(l));
    const onlyEngine = theirs.filter((l) => !ours.includes(l));
    console.log(`--- T6.5 diff summary (normalized; uid/unique_id/id-value ignored) ---\nonly-ours:\n${onlyOurs.join("\n")}\nonly-engine:\n${onlyEngine.join("\n")}`);
    console.log(`--- T6.5 engine-written scene (${ENGINE_SAVED}) ---\n${engineText}`);
  },
);
