// P3:runtime_inspect_ui 的单元测试(mock 进程,不依赖真实 Godot)。
// 分层:助手解析(scriptRunner)→ 纯计算(参数构建 / payload 自检 / issues)→ 服务层(注入 runner)→ 工具层(经 ToolHost)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GodotMcpError } from "../src/core/errors.js";
import { createLogger } from "../src/core/logger.js";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import type { GodotRunRunner, RunProcessResult } from "../src/godot/runtime/run.js";
import {
  buildInspectUiArgs,
  computeUiIssues,
  isUiInspectPayload,
  summarizeUiIssues,
  type InspectedControl,
  type UiInspectPayload,
} from "../src/godot/runtime/inspectUi.js";
import {
  MCP_RESULT_PREFIX,
  parseMcpResultJson,
  TEMP_SCRIPT_DIR,
  withTempScript,
} from "../src/godot/runtime/scriptRunner.js";
import { GodotCliService } from "../src/services/godotCli.js";
import { RuntimeService } from "../src/services/runtimeService.js";
import { runtimeInspectUi } from "../src/tools/runtime/inspectUi.js";
import type { AppContext } from "../src/services/context.js";

const quiet = createLogger("error", () => {});

// ---------- 助手:临时脚本 + MCP_RESULT_JSON ----------

test("parseMcpResultJson: 忽略引擎日志,只取带前缀的行", () => {
  const stdout = [
    "Godot Engine v4.6.3.stable.official.7d41c59c4 - https://godotengine.org",
    "OpenGL API 3.3.0 NVIDIA - Compatibility",
    `${MCP_RESULT_PREFIX}{"nodeCount":7,"truncated":false}`,
    "some trailing log",
  ].join("\n");
  const r = parseMcpResultJson(stdout);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value, { nodeCount: 7, truncated: false });
});

test("parseMcpResultJson: 兼容 CRLF,且多行时取第一行", () => {
  const stdout = `${MCP_RESULT_PREFIX}{"a":1}\r\n${MCP_RESULT_PREFIX}{"a":2}\r\n`;
  const r = parseMcpResultJson(stdout);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value, { a: 1 });
});

test("parseMcpResultJson: 缺前缀 → missing", () => {
  const r = parseMcpResultJson("SCREENSHOT_RENDER_SIZE=1280x720\nERROR: boom\n");
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "missing");
});

test("parseMcpResultJson: 前缀后不是合法 JSON → invalid_json", () => {
  const r = parseMcpResultJson(`${MCP_RESULT_PREFIX}{oops}\n`);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "invalid_json");
  assert.match(!r.ok ? r.message : "", /Malformed JSON/);
});

test("withTempScript: 写入系统临时目录并在运行后删除", async () => {
  const seen: { scriptPath: string; text: string; dir: string }[] = [];
  const out = await withTempScript(
    "extends SceneTree\n",
    async (scriptPath) => {
      seen.push({ scriptPath, text: fs.readFileSync(scriptPath, "utf8"), dir: path.dirname(scriptPath) });
      return "done";
    },
    { prefix: "unit-probe" },
  );
  assert.equal(out, "done");
  assert.equal(seen[0]?.text, "extends SceneTree\n");
  assert.equal(seen[0]?.dir, TEMP_SCRIPT_DIR);
  assert.match(path.basename(seen[0]?.scriptPath ?? ""), /^unit-probe-.*\.gd$/);
  assert.equal(fs.existsSync(seen[0]?.scriptPath ?? ""), false);
});

test("withTempScript: run 抛错时脚本同样被删除", async () => {
  let scriptPath = "";
  await assert.rejects(
    withTempScript("extends SceneTree\n", async (p) => {
      scriptPath = p;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(fs.existsSync(scriptPath), false);
});

// ---------- 纯计算 ----------

test("buildInspectUiArgs: 固定参数 + node/width/height/includeHidden", () => {
  assert.deepEqual(
    buildInspectUiArgs("/proj", {
      scriptPath: "/tmp/s.gd", scene: "res://a.tscn", nodePaths: [], frames: 3, includeHidden: false, maxNodes: 300,
    }),
    ["--path", "/proj", "--script", "/tmp/s.gd", "--", "--scene", "res://a.tscn", "--frames", "3", "--max-nodes", "300"],
  );
  assert.deepEqual(
    buildInspectUiArgs("/proj", {
      scriptPath: "/tmp/s.gd", scene: "res://a.tscn", nodePaths: [".", "VBox/Button"], frames: 5,
      width: 800, height: 450, includeHidden: true, maxNodes: 12,
    }),
    [
      "--path", "/proj", "--script", "/tmp/s.gd", "--",
      "--scene", "res://a.tscn", "--frames", "5", "--max-nodes", "12",
      "--node", ".", "--node", "VBox/Button", "--width", "800", "--height", "450", "--include-hidden",
    ],
  );
});

/** 造一个 Control 快照,默认完全"正常"(落在视口里、尺寸等于最小尺寸)。 */
function ctrl(over: Partial<InspectedControl> = {}): InspectedControl {
  return {
    path: "Node", class: "Control", visible: true, visible_in_tree: true,
    global_rect: [0, 0, 100, 100], position: [0, 0], size: [100, 100],
    rotation: 0, scale: [1, 1], pivot_offset: [0, 0], min_size: [0, 0],
    parent_path: ".", parent_is_container: false, parent_clip_contents: false,
    parent_rect: [0, 0, 640, 360],
    ...over,
  };
}
const VIEWPORT = { width: 640, height: 360 };

test("computeUiIssues: 正常节点无 issue", () => {
  assert.deepEqual(computeUiIssues(ctrl(), VIEWPORT), []);
});

test("computeUiIssues: 越出父 Control → out_of_parent;父 clip_contents → clipped_by_parent(互斥)", () => {
  // 父是 100x100、子在 (50,0) 100x100:越出父但仍在视口内 → 只有父级判定
  const base: Partial<InspectedControl> = { global_rect: [50, 0, 100, 100], parent_rect: [0, 0, 100, 100] };
  assert.deepEqual(computeUiIssues(ctrl(base), VIEWPORT), ["out_of_parent"]);
  assert.deepEqual(computeUiIssues(ctrl({ ...base, parent_clip_contents: true }), VIEWPORT), ["clipped_by_parent"]);
  // 父节点不是 Control(parent_rect = null)→ 不做父级判定
  assert.deepEqual(computeUiIssues(ctrl({ ...base, parent_rect: null }), VIEWPORT), []);
});

test("computeUiIssues: 容差 0.5px —— 0.5 内不算越界,超过才算", () => {
  const within = ctrl({ global_rect: [540, 0, 100, 100] }); // 右边界 640.5
  assert.deepEqual(computeUiIssues(within, VIEWPORT), []);
  const beyond = ctrl({ global_rect: [540.6, 0, 100, 100] });
  assert.deepEqual(computeUiIssues(beyond, VIEWPORT), ["out_of_parent", "out_of_viewport"]);
});

test("computeUiIssues: 越出视口 → out_of_viewport(与父级判定独立)", () => {
  const n = ctrl({ global_rect: [700, 0, 10, 10], parent_rect: [0, 0, 800, 400] });
  assert.deepEqual(computeUiIssues(n, VIEWPORT), ["out_of_viewport"]);
});

test("computeUiIssues: zero_size 只在 visible 时报", () => {
  assert.deepEqual(computeUiIssues(ctrl({ size: [0, 50] }), VIEWPORT), ["zero_size"]);
  assert.deepEqual(computeUiIssues(ctrl({ size: [50, 0] }), VIEWPORT), ["zero_size"]);
  assert.deepEqual(computeUiIssues(ctrl({ size: [0, 0], visible: false }), VIEWPORT), []);
});

test("computeUiIssues: size 小于 min_size → smaller_than_min", () => {
  assert.deepEqual(computeUiIssues(ctrl({ size: [10, 10], min_size: [99, 31] }), VIEWPORT), ["smaller_than_min"]);
  const ok = ctrl({ size: [99, 31], min_size: [99, 31] });
  assert.deepEqual(computeUiIssues(ok, VIEWPORT), []);
});

test("summarizeUiIssues: 按类型计数", () => {
  const summary = summarizeUiIssues([
    { issues: ["out_of_parent", "out_of_viewport"] },
    { issues: ["zero_size"] },
    { issues: ["out_of_parent"] },
    { issues: [] },
  ]);
  assert.deepEqual(summary, {
    out_of_parent: 2, out_of_viewport: 1, zero_size: 1, smaller_than_min: 0, clipped_by_parent: 0,
  });
});

test("isUiInspectPayload: 形状自检", () => {
  assert.equal(isUiInspectPayload({ scene: "a", engineVersion: "b", nodeCount: 1, truncated: false, nodes: [], missing: [], viewportSize: { width: 1, height: 2 } }), true);
  assert.equal(isUiInspectPayload(null), false);
  assert.equal(isUiInspectPayload({ scene: "a" }), false);
  assert.equal(isUiInspectPayload({ scene: "a", engineVersion: "b", nodeCount: 1, truncated: false, nodes: {}, missing: [], viewportSize: { width: 1, height: 2 } }), false);
});

// ---------- 服务层(注入 runner) ----------

function payloadOf(over: Partial<UiInspectPayload> = {}): UiInspectPayload {
  return {
    scene: "res://main.tscn",
    viewportSize: { width: 640, height: 360 },
    nodeCount: 1,
    truncated: false,
    nodes: [ctrl()],
    missing: [],
    engineVersion: "4.6.3-stable (official)",
    ...over,
  };
}

function stdoutOf(payload: UiInspectPayload): string {
  return `Godot Engine v4.6.3.stable.official\n${MCP_RESULT_PREFIX}${JSON.stringify(payload)}\n`;
}

function runner(stdout: string, over: Partial<RunProcessResult> = {}): GodotRunRunner {
  return async () => ({
    exitCode: 0, signal: null, timedOut: false, stdout, stderr: "",
    stdoutTruncated: false, stderrTruncated: false, durationMs: 7, ...over,
  });
}

function makeRuntime(
  t: { after: (fn: () => void) => void },
  r: GodotRunRunner,
): { dir: string; svc: RuntimeService } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-ui-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), "");
  const exe = path.join(dir, "godot.exe");
  fs.writeFileSync(exe, "");
  const project = new ProjectResolver({ cwd: dir });
  const godot = new GodotCliService({ env: { GODOT_PATH: exe } });
  const svc = new RuntimeService({ godot, project, runQueue: new TaskQueue(new LockManager()), runner: r });
  return { dir, svc };
}

test("inspectUi 成功:补算 issues/summary,命令行带 --script 与 -- 分隔符,脚本被清理", async (t) => {
  const log: string[][] = [];
  let scriptPathInRun = "";
  const recording: GodotRunRunner = async (_file, args) => {
    log.push([...args]);
    scriptPathInRun = args[args.indexOf("--script") + 1] ?? "";
    // 运行期间脚本必须真实存在于系统临时目录,且不在用户工程里
    assert.equal(fs.existsSync(scriptPathInRun), true);
    assert.equal(path.dirname(scriptPathInRun), TEMP_SCRIPT_DIR);
    return {
      exitCode: 0, signal: null, timedOut: false, stdout: stdoutOf(payloadOf()), stderr: "",
      stdoutTruncated: false, stderrTruncated: false, durationMs: 7,
    };
  };
  const { dir, svc } = makeRuntime(t, recording);
  const res = await svc.inspectUi({ tool: "runtime_inspect_ui", scene: "res://main.tscn", frames: 5 });
  assert.equal(res.scene, "res://main.tscn");
  assert.deepEqual(res.viewportSize, { width: 640, height: 360 });
  assert.equal(res.engineVersion, "4.6.3-stable (official)");
  assert.equal(res.durationMs, 7);
  assert.equal(res.source, "GODOT_PATH");
  assert.equal(res.projectDir, dir);
  assert.deepEqual(res.nodes[0]?.issues, []);
  assert.equal(res.truncated, false);
  assert.match(res.command, /--script .* -- --scene res:\/\/main\.tscn --frames 5/);
  assert.equal(log[0]?.includes("--headless"), false, "布局探针必须非 headless");
  // 用完即删(只断言本次这个文件,避免与其他测试文件的临时脚本互相干扰)
  assert.equal(fs.existsSync(scriptPathInRun), false);
});

test("inspectUi: frames 上限 60、maxNodes 下限 1 由服务层兜底", async (t) => {
  const log: string[][] = [];
  const recording: GodotRunRunner = async (_file, args) => {
    log.push([...args]);
    return {
      exitCode: 0, signal: null, timedOut: false, stdout: stdoutOf(payloadOf()), stderr: "",
      stdoutTruncated: false, stderrTruncated: false, durationMs: 1,
    };
  };
  const { svc } = makeRuntime(t, recording);
  await svc.inspectUi({ tool: "runtime_inspect_ui", scene: "res://a.tscn", frames: 999, maxNodes: 0 });
  const args = log[0] ?? [];
  assert.equal(args[args.indexOf("--frames") + 1], "60");
  assert.equal(args[args.indexOf("--max-nodes") + 1], "1");
});

test("inspectUi: nodePaths 透传为重复的 --node 参数", async (t) => {
  const log: string[][] = [];
  const recording: GodotRunRunner = async (_file, args) => {
    log.push([...args]);
    return {
      exitCode: 0, signal: null, timedOut: false, stdout: stdoutOf(payloadOf()), stderr: "",
      stdoutTruncated: false, stderrTruncated: false, durationMs: 1,
    };
  };
  const { svc } = makeRuntime(t, recording);
  await svc.inspectUi({
    tool: "runtime_inspect_ui", scene: "res://a.tscn", nodePaths: [".", "VBox/Button"],
    width: 500, height: 300, includeHidden: true,
  });
  const args = log[0] ?? [];
  assert.deepEqual(args.slice(args.indexOf("--")), [
    "--", "--scene", "res://a.tscn", "--frames", "3", "--max-nodes", "300",
    "--node", ".", "--node", "VBox/Button", "--width", "500", "--height", "300", "--include-hidden",
  ]);
});

test("inspectUi: stdout 缺 MCP_RESULT_JSON 前缀 → RUNTIME_FAILED", async (t) => {
  const { svc } = makeRuntime(t, runner("Godot Engine v4.6.3\nno marker here\n"));
  await assert.rejects(
    svc.inspectUi({ tool: "runtime_inspect_ui", scene: "res://a.tscn" }),
    (e: unknown) => {
      assert.ok(e instanceof GodotMcpError);
      assert.equal(e.code, "RUNTIME_FAILED");
      assert.equal(e.details?.["reason"], "missing");
      return true;
    },
  );
});

test("inspectUi: 前缀后 JSON 非法 → RUNTIME_FAILED(invalid_json)", async (t) => {
  const { svc } = makeRuntime(t, runner(`${MCP_RESULT_PREFIX}{oops}\n`));
  await assert.rejects(
    svc.inspectUi({ tool: "runtime_inspect_ui", scene: "res://a.tscn" }),
    (e: unknown) => e instanceof GodotMcpError && e.code === "RUNTIME_FAILED" && e.details?.["reason"] === "invalid_json",
  );
});

test("inspectUi: 合法 JSON 但形状不符 → RUNTIME_FAILED", async (t) => {
  const { svc } = makeRuntime(t, runner(`${MCP_RESULT_PREFIX}{"scene":"res://a.tscn"}\n`));
  await assert.rejects(
    svc.inspectUi({ tool: "runtime_inspect_ui", scene: "res://a.tscn" }),
    (e: unknown) => e instanceof GodotMcpError && e.code === "RUNTIME_FAILED" && /unexpected layout result shape/.test(e.message),
  );
});

test("inspectUi: 场景 load 失败(exit 2)→ FILE_NOT_FOUND", async (t) => {
  const { svc } = makeRuntime(t, runner("", { exitCode: 2, stderr: "ERROR: INSPECT_UI_SCENE_LOAD_FAILED" }));
  await assert.rejects(
    svc.inspectUi({ tool: "runtime_inspect_ui", scene: "res://nope.tscn" }),
    (e: unknown) => {
      assert.ok(e instanceof GodotMcpError);
      assert.equal(e.code, "FILE_NOT_FOUND");
      assert.equal(e.details?.["scene"], "res://nope.tscn");
      return true;
    },
  );
});

test("inspectUi: 超时 → TASK_TIMEOUT", async (t) => {
  const { svc } = makeRuntime(t, runner("", { timedOut: true, exitCode: null }));
  await assert.rejects(
    svc.inspectUi({ tool: "runtime_inspect_ui", scene: "res://a.tscn", timeoutMs: 250 }),
    (e: unknown) => e instanceof GodotMcpError && e.code === "TASK_TIMEOUT",
  );
});

// ---------- 工具层(经 ToolHost) ----------

test("runtime_inspect_ui 经 ToolHost:宽度高度成对校验 + 成功信封", async (t) => {
  const { svc } = makeRuntime(t, runner(stdoutOf(payloadOf({
    missing: ["Nope"], nodeCount: 2,
    nodes: [ctrl(), ctrl({ path: "VBox/Button", size: [10, 10], min_size: [99, 31] })],
  }))));
  const ctx = { runtime: svc } as unknown as AppContext;
  const host = new ToolHost(new ToolRegistry<AppContext>().registerAll([runtimeInspectUi]), ctx, quiet);

  const bad = await host.callTool("runtime_inspect_ui", { scene: "res://a.tscn", width: 500 });
  assert.equal(bad.ok, false);
  assert.equal((bad as { ok: false; error: { code: string } }).error.code, "INVALID_ARGUMENT");

  const missingScene = await host.callTool("runtime_inspect_ui", {});
  assert.equal(missingScene.ok, false);
  assert.equal((missingScene as { ok: false; error: { code: string } }).error.code, "INVALID_ARGUMENT");

  const ok = await host.callTool("runtime_inspect_ui", { scene: "res://a.tscn", nodePaths: ["."] });
  assert.equal(ok.ok, true);
  const data = (ok as { ok: true; data: Record<string, unknown> }).data;
  assert.deepEqual(Object.keys(data).sort(), [
    "durationMs", "engineVersion", "missing", "nodeCount", "nodes", "scene", "summary", "truncated", "viewportSize",
  ]);
  assert.deepEqual(data["missing"], ["Nope"]);
  assert.equal(data["nodeCount"], 2);
  assert.deepEqual(data["summary"], {
    out_of_parent: 0, out_of_viewport: 0, zero_size: 0, smaller_than_min: 1, clipped_by_parent: 0,
  });
});
