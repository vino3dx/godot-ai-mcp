// runtime_get_version 的单元测试:全部通过注入(env/pathDirs/runner)完成,不执行真实 Godot 二进制。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GodotMcpError } from "../src/core/errors.js";
import { createLogger } from "../src/core/logger.js";
import {
  buildCandidatePaths,
  candidateNames,
  getGodotVersion,
  parseVersionOutput,
  resolveCandidates,
  type GodotRunner,
} from "../src/godot/cli.js";
import { GodotCliService } from "../src/services/godotCli.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import type { AppContext } from "../src/services/context.js";
import { runtimeGetVersion } from "../src/tools/runtime/getVersion.js";

const quiet = createLogger("error", () => {});

function okRunner(stdout: string): GodotRunner {
  return async () => ({ stdout, stderr: "" });
}

function failRunner(props: Record<string, unknown>): GodotRunner {
  return async () => {
    throw Object.assign(new Error("probe failed"), props);
  };
}

/** 断言 promise 以指定错误码拒绝,并返回错误对象供进一步检查。 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<GodotMcpError> {
  return promise.then(
    () => {
      throw new Error(`expected rejection with ${code}`);
    },
    (e: unknown) => {
      assert.ok(e instanceof GodotMcpError, `expected GodotMcpError, got ${String(e)}`);
      assert.equal(e.code, code);
      return e;
    },
  );
}

/** 建一个临时目录,放一个占位可执行文件,返回其绝对路径(只做 stat 检查,不真正执行)。 */
function withFakeExecutable(): { dir: string; exe: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-cli-test-"));
  const exe = path.join(dir, "mygodot");
  fs.writeFileSync(exe, "");
  return { dir, exe };
}

// ---------- parseVersionOutput(纯函数) ----------

test("parseVersionOutput extracts the leading version token and never rewrites it", () => {
  assert.deepEqual(parseVersionOutput("4.2.1.stable.official.8ba0a4f52\n", ""), { version: "4.2.1", stream: "stdout" });
  assert.deepEqual(parseVersionOutput("4.6\n", ""), { version: "4.6", stream: "stdout" });
  assert.deepEqual(parseVersionOutput("4.6", ""), { version: "4.6", stream: "stdout" });
  // 4.6 是否改走 stderr 尚未实测:stdout 为空时兜底 stderr,并标记来源
  assert.deepEqual(parseVersionOutput("", "4.6\n", 0), { version: "4.6", stream: "stderr" });
});

test("parseVersionOutput rejects output without a recognizable version token", async () => {
  const e = await expectCode(Promise.resolve().then(() => parseVersionOutput("", "", 1)), "GODOT_PROCESS_FAILED");
  assert.equal(e.details?.["exitCode"], 1);
  await expectCode(
    Promise.resolve().then(() => parseVersionOutput("Godot Engine says hi", "", 0)),
    "GODOT_PROCESS_FAILED",
  );
});

// ---------- 候选名与路径(纯函数) ----------

test("candidate names are platform-scoped; buildCandidatePaths is a pure cross product", () => {
  assert.deepEqual(candidateNames("linux"), ["godot"]);
  assert.deepEqual(candidateNames("win32"), ["godot", "godot.exe"]);
  assert.deepEqual(buildCandidatePaths(["/a", "/b"], ["godot"]), [path.join("/a", "godot"), path.join("/b", "godot")]);
  assert.deepEqual(buildCandidatePaths([], ["godot", "godot.exe"]), []);
});

// ---------- 定位 ----------

test("locator finds existing candidates in PATH dirs and none when missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-locator-"));
  const name = candidateNames(process.platform)[0]!;
  fs.writeFileSync(path.join(dir, name), "");
  assert.deepEqual(resolveCandidates({ pathDirs: [dir], env: {} }), [{ path: path.join(dir, name), source: "PATH" }]);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "godot-empty-"));
  assert.deepEqual(resolveCandidates({ pathDirs: [empty], env: {} }), []);
  fs.rmSync(empty, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("GODOT_PATH wins over PATH; a missing explicit path fails without PATH fallback", async () => {
  const { dir, exe } = withFakeExecutable();
  assert.deepEqual(resolveCandidates({ pathDirs: [dir], env: { GODOT_PATH: exe } }), [
    { path: exe, source: "GODOT_PATH" },
  ]);
  const e = await expectCode(
    Promise.resolve().then(() => resolveCandidates({ pathDirs: [dir], env: { GODOT_PATH: path.join(dir, "nope.exe") } })),
    "GODOT_NOT_FOUND",
  );
  assert.equal(e.details?.["resolved"], path.resolve(path.join(dir, "nope.exe")));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- getGodotVersion(注入 runner) ----------

test("getGodotVersion returns the real output unchanged, with locator provenance", async () => {
  const { dir, exe } = withFakeExecutable();
  const raw = "4.6.stable.official.deadbeef\n";
  const viaEnv = await getGodotVersion({ env: { GODOT_PATH: exe }, runner: okRunner(raw) });
  assert.deepEqual(viaEnv, { version: "4.6", raw, resolvedPath: exe, source: "GODOT_PATH" });

  const name = candidateNames(process.platform)[0]!;
  fs.writeFileSync(path.join(dir, name), "");
  const viaPath = await getGodotVersion({ pathDirs: [dir], env: {}, runner: okRunner(raw) });
  assert.equal(viaPath.source, "PATH");
  assert.equal(viaPath.resolvedPath, path.join(dir, name));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("probe failures map to GODOT_NOT_FOUND / GODOT_PROCESS_FAILED with per-candidate reasons", async () => {
  const { dir, exe } = withFakeExecutable();
  const opts = { env: { GODOT_PATH: exe } };

  const enoent = await expectCode(getGodotVersion({ ...opts, runner: failRunner({ code: "ENOENT" }) }), "GODOT_NOT_FOUND");
  assert.deepEqual((enoent.details?.["tried"] as Array<{ reason: string }>)[0]?.reason, "ENOENT");

  const exited = await expectCode(getGodotVersion({ ...opts, runner: failRunner({ exitCode: 1 }) }), "GODOT_PROCESS_FAILED");
  assert.deepEqual((exited.details?.["tried"] as Array<{ reason: string }>)[0]?.reason, "exit=1");

  const timedOut = await expectCode(getGodotVersion({ ...opts, runner: failRunner({ killed: true }) }), "GODOT_PROCESS_FAILED");
  assert.deepEqual((timedOut.details?.["tried"] as Array<{ reason: string }>)[0]?.reason, "timeout");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("arbitration: the first successful candidate wins, failures are recorded", async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "godot-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "godot-b-"));
  const name = candidateNames(process.platform)[0]!;
  const exeA = path.join(dirA, name);
  const exeB = path.join(dirB, name);
  fs.writeFileSync(exeA, "");
  fs.writeFileSync(exeB, "");
  const runner: GodotRunner = async (file) => {
    if (file === exeA) throw Object.assign(new Error("boom"), { exitCode: 1 });
    return { stdout: "4.6\n", stderr: "" };
  };
  const info = await getGodotVersion({ pathDirs: [dirA, dirB], env: {}, runner });
  assert.equal(info.resolvedPath, exeB);
  assert.equal(info.version, "4.6");
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test("no candidates at all -> GODOT_NOT_FOUND with the searched candidate list", async () => {
  const e = await expectCode(getGodotVersion({ env: {}, pathDirs: [], runner: okRunner("4.6\n") }), "GODOT_NOT_FOUND");
  assert.deepEqual(e.details?.["tried"], []);
  assert.deepEqual(e.details?.["candidates"], []);
});

// ---------- Service 与工具层 ----------

test("GodotCliService proxies runner and error mapping", async () => {
  const { dir, exe } = withFakeExecutable();
  const svc = new GodotCliService({ env: { GODOT_PATH: exe }, runner: okRunner("4.6\n") });
  assert.equal((await svc.getVersion()).version, "4.6");
  await expectCode(
    new GodotCliService({ env: { GODOT_PATH: exe }, runner: failRunner({ killed: true }) }).getVersion(),
    "GODOT_PROCESS_FAILED",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runtime_get_version through ToolHost: ok path, provenance, and zero-arg schema", async () => {
  const { dir, exe } = withFakeExecutable();
  const ctx = {
    godot: new GodotCliService({ env: { GODOT_PATH: exe }, runner: okRunner("4.6.stable.official.deadbeef\n") }),
  } as unknown as AppContext;
  const host = new ToolHost(new ToolRegistry().registerAll([runtimeGetVersion]), ctx, quiet);

  const ok = await host.callTool("runtime_get_version", {});
  assert.deepEqual(ok, {
    ok: true,
    data: { version: "4.6", raw: "4.6.stable.official.deadbeef\n", resolvedPath: exe, source: "GODOT_PATH" },
  });

  // 空参 schema:多余参数由校验器拒绝
  const bad = await host.callTool("runtime_get_version", { extra: 1 });
  assert.ok(!bad.ok && bad.error.code === "INVALID_ARGUMENT");
  fs.rmSync(dir, { recursive: true, force: true });
});
