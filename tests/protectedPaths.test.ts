// P1 数据保护锁:受保护目录(res://data/、res://assets/)+ 覆盖扩展名白名单。
//
// 夹具是 tests/fixture_project 的 mkdtemp 副本:仓库副本与任何真实工程都不会被操作。
// fixture 里没有 data/ 与 assets/(仓库不预置真实素材),用例在副本里自行铺出受保护内容。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { FileGuard } from "../src/core/filesystem/fileGuard.js";
import {
  PROTECTED_DIRS_ENV, assertNotProtected, protectedDirs,
} from "../src/core/filesystem/protectedPaths.js";
import { sha256Hex } from "../src/core/filesystem/safeWrite.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { createAppContext } from "../src/services/context.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";
import type { AppContext } from "../src/services/context.js";

const FIXTURE = path.join(import.meta.dirname!, "..", "..", "tests", "fixture_project");
const quiet = createLogger("error", () => {});

/** 受保护目录内的"真实素材":被覆盖即数据损失,所有拒绝用例都要复核它没被动过。 */
const KEEP_GD = 'extends Node\nclass_name DataModulePlayer\n\n@export var speed: float = 300.0\n';
const KEEP_TXT = "hero data: must survive\n";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

interface Host { dir: string; host: ToolHost<AppContext> }

function writeFile(dir: string, rel: string, data: string | Buffer): void {
  const p = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

function makeHost(t: { after: (fn: () => void) => void }): Host {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-prot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, dir, { recursive: true });

  writeFile(dir, "data/modules/player.gd", KEEP_GD);
  writeFile(dir, "data/modules/hero.txt", KEEP_TXT);
  writeFile(dir, "assets/textures/hero.png", PNG_BYTES);
  writeFile(dir, "assets/config.json", '{"a": 1}\n');
  writeFile(dir, "icon.png", PNG_BYTES); // 项目根下的非文本文件(不受保护目录覆盖)

  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: dir }));
  return { dir, host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet) };
}

function ok(r: ToolResult): Record<string, unknown> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; data: unknown }).data as Record<string, unknown>;
}

function err(r: ToolResult): { code: string; message: string; details?: Record<string, unknown> } {
  assert.equal(r.ok, false, JSON.stringify(r));
  return (r as { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }).error;
}

function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, ...rel.split("/")), "utf8");
}

function readBytes(dir: string, rel: string): Buffer {
  return fs.readFileSync(path.join(dir, ...rel.split("/")));
}

/** script_create with overwrite=true —— 覆盖既有文件的唯一入口。 */
const overwrite = (host: ToolHost<AppContext>, scriptPath: string, content = "TOOL_WROTE_THIS\n") =>
  host.callTool("script_create", { scriptPath, content, overwrite: true });

// ────────────────────── 受保护目录:覆盖既有文件 ──────────────────────

test("overwriting an existing file under res://data/ is refused with PROTECTED_PATH", async (t) => {
  const { dir, host } = makeHost(t);

  const e = err(await overwrite(host, "res://data/modules/player.gd"));
  assert.equal(e.code, "PROTECTED_PATH");
  assert.match(e.message, /protected directory "res:\/\/data\/"/);
  assert.equal(e.details?.["protectedDir"], "res://data/");
  assert.equal(e.details?.["reason"], "protected-dir");
  assert.equal(read(dir, "data/modules/player.gd"), KEEP_GD, "受保护文件必须逐字节不变");
});

test("overwriting an existing file in an res://assets/ subdirectory is refused (binary and text alike)", async (t) => {
  const { dir, host } = makeHost(t);

  const png = err(await overwrite(host, "res://assets/textures/hero.png"));
  assert.equal(png.code, "PROTECTED_PATH", "受保护目录先于扩展名规则生效");
  assert.equal(png.details?.["protectedDir"], "res://assets/");

  const json = err(await overwrite(host, "res://assets/config.json"));
  assert.equal(json.code, "PROTECTED_PATH", "文本扩展名也不能覆盖受保护目录里的既有文件");

  assert.deepEqual(readBytes(dir, "assets/textures/hero.png"), PNG_BYTES);
  assert.equal(read(dir, "assets/config.json"), '{"a": 1}\n');
});

test("creating a file inside a protected directory is still allowed", async (t) => {
  const { dir, host } = makeHost(t);

  const gd = ok(await host.callTool("script_create", {
    scriptPath: "res://data/modules/new_module.gd", content: "extends Node\n",
  }));
  assert.equal(gd["changed"], true);
  assert.equal(read(dir, "data/modules/new_module.gd"), "extends Node\n");

  // 非文本扩展名的"新建"不是覆盖:既有素材未被替换,规则只锁覆盖/删除/移动。
  const png = ok(await host.callTool("script_create", {
    scriptPath: "res://assets/textures/new_sprite.png", content: "placeholder\n",
  }));
  assert.equal(png["changed"], true);
  assert.deepEqual(readBytes(dir, "assets/textures/hero.png"), PNG_BYTES);
});

test("environment variable adds extra protected directories; the two defaults stay protected", async (t) => {
  const { dir, host } = makeHost(t);
  const previous = process.env[PROTECTED_DIRS_ENV];
  process.env[PROTECTED_DIRS_ENV] = "res://vendor/,  res://data , ../evil";
  t.after(() => {
    if (previous === undefined) delete process.env[PROTECTED_DIRS_ENV];
    else process.env[PROTECTED_DIRS_ENV] = previous;
  });
  writeFile(dir, "vendor/keep.txt", "vendor data\n");

  const extra = err(await overwrite(host, "res://vendor/keep.txt"));
  assert.equal(extra.code, "PROTECTED_PATH");
  assert.equal(extra.details?.["protectedDir"], "res://vendor/");
  assert.equal(read(dir, "vendor/keep.txt"), "vendor data\n");

  // 默认两项不可被环境变量移除,重复项与无法解释的条目(../evil)被忽略
  assert.deepEqual(protectedDirs(process.env), ["data", "assets", "vendor"]);
  assert.equal(err(await overwrite(host, "res://data/modules/player.gd")).code, "PROTECTED_PATH");
  assert.equal(read(dir, "data/modules/player.gd"), KEEP_GD);
});

// ────────────────────── 绕过尝试 ──────────────────────

test("'..' traversal never reaches the protected check (FileGuard rejects the path first)", async (t) => {
  const { dir, host } = makeHost(t);

  for (const scriptPath of [
    "res://data/modules/../modules/player.gd",
    "res://data/../../data/modules/player.gd",
    "../data/modules/player.gd",
  ]) {
    const e = err(await overwrite(host, scriptPath));
    assert.equal(e.code, "INVALID_ARGUMENT", `expected ${scriptPath} to be rejected by FileGuard`);
    assert.equal(e.details?.["reason"], "traversal");
  }
  assert.equal(read(dir, "data/modules/player.gd"), KEEP_GD);
});

test("case variants cannot bypass the lock on a case-insensitive filesystem", async (t) => {
  const { dir, host } = makeHost(t);

  // 只有平台把变体解析到同一文件时它才构成绕过;大小写敏感的文件系统上它是另一个目录。
  const variantIsSameFile = fs.existsSync(path.join(dir, "DATA", "modules", "player.gd"));
  if (!variantIsSameFile) {
    t.diagnostic(`${process.platform}: filesystem is case-sensitive, "DATA" is a different directory — assertion not applicable`);
    return;
  }
  const e = err(await overwrite(host, "res://DATA/modules/player.gd"));
  assert.equal(e.code, "PROTECTED_PATH");
  const assets = err(await overwrite(host, "res://Assets/textures/hero.png"));
  assert.equal(assets.code, "PROTECTED_PATH");
  assert.equal(read(dir, "data/modules/player.gd"), KEEP_GD);
  assert.deepEqual(readBytes(dir, "assets/textures/hero.png"), PNG_BYTES);
});

test("links pointing into a protected directory cannot bypass the lock", async (t) => {
  const { dir, host } = makeHost(t);
  const guard = new FileGuard(dir);

  // 目录链接:res://link → res://data(名义路径不在受保护目录内)
  const dirLink = path.join(dir, "link");
  try {
    fs.symlinkSync(path.join(dir, "data"), dirLink, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("this environment cannot create directory links");
    return;
  }
  assert.equal(guard.contains(path.join(dirLink, "modules", "player.gd")), true, "sanity: 链接仍在项目内");

  const viaDirLink = err(await overwrite(host, "res://link/modules/player.gd"));
  assert.equal(viaDirLink.code, "PROTECTED_PATH");
  assert.equal(viaDirLink.details?.["protectedDir"], "res://data/");

  // 文件链接:res://scripts/alias.txt → res://data/modules/hero.txt(扩展名本身合法)
  const fileLink = path.join(dir, "scripts", "alias.txt");
  try {
    fs.symlinkSync(path.join(dir, "data", "modules", "hero.txt"), fileLink, "file");
  } catch {
    t.diagnostic("cannot create file links here; only the directory-link case was checked");
  }
  if (fs.existsSync(fileLink)) {
    const viaFileLink = err(await overwrite(host, "res://scripts/alias.txt"));
    assert.equal(viaFileLink.code, "PROTECTED_PATH");
    assert.equal(read(dir, "data/modules/hero.txt"), KEEP_TXT);
  }
});

// ────────────────────── 扩展名白名单(与目录无关) ──────────────────────

test("outside protected directories: .gd may be overwritten, non-text extensions may not", async (t) => {
  const { dir, host } = makeHost(t);

  const gd = ok(await overwrite(host, "res://scripts/player.gd", "extends Node\n"));
  assert.equal(gd["changed"], true);
  assert.equal(read(dir, "scripts/player.gd"), "extends Node\n");

  const png = err(await overwrite(host, "res://icon.png"));
  assert.equal(png.code, "INVALID_ARGUMENT");
  assert.equal(png.details?.["reason"], "non-text-extension");
  assert.equal(png.details?.["extension"], ".png");
  assert.match(png.message, /Allowed extensions: \.gd, \.gdshader, \.gdshaderinc, \.tres, \.tscn, \.cfg, \.json, \.md, \.txt/);
  assert.deepEqual(readBytes(dir, "icon.png"), PNG_BYTES, "非文本文件必须逐字节不变");

  // 扩展名大小写不敏感(Windows/macOS 上 .GD 与 .gd 是同一类文件)
  ok(await host.callTool("script_create", { scriptPath: "res://scripts/upper.GD", content: "extends Node\n" }));
  assert.equal(ok(await overwrite(host, "res://scripts/upper.GD"))["changed"], true);

  // 其他文本扩展名(.json/.gdshader)覆盖允许
  writeFile(dir, "scripts/notes.json", "{}\n");
  assert.equal(ok(await overwrite(host, "res://scripts/notes.json", '{"b": 2}\n'))["changed"], true);
  assert.equal(read(dir, "scripts/notes.json"), '{"b": 2}\n');
});

// ────────────────────── 定点编辑(expectedHash 路径)不受影响 ──────────────────────

test("hash-guarded point edits keep working, including inside protected directories", async (t) => {
  const { dir, host } = makeHost(t);

  // script_update_export_default 走 FileService.editText,不受保护锁影响
  const edited = ok(await host.callTool("script_update_export_default", {
    path: "res://data/modules/player.gd", name: "speed", value: "500.0", expectedHash: sha256Hex(KEEP_GD),
  }));
  assert.equal(edited["changed"], true);
  assert.ok(read(dir, "data/modules/player.gd").includes("@export var speed: float = 500.0"));

  // 乐观并发仍然生效:hash 不匹配 → FILE_CHANGED,且不落盘
  const stale = err(await host.callTool("script_update_export_default", {
    path: "res://data/modules/player.gd", name: "speed", value: "999.0", expectedHash: sha256Hex(KEEP_GD),
  }));
  assert.equal(stale.code, "FILE_CHANGED");
  assert.ok(read(dir, "data/modules/player.gd").includes("500.0"), "FILE_CHANGED 不得覆盖磁盘内容");

  // createText 的 expectedHash 分支同样保留
  const mismatch = err(await host.callTool("script_create", {
    scriptPath: "res://scripts/player.gd", content: "extends Node\n", overwrite: true, expectedHash: "deadbeef",
  }));
  assert.equal(mismatch.code, "FILE_CHANGED");
});

// ────────────────────── 可复用守卫(供删除/移动类工具) ──────────────────────

test("assertNotProtected is reusable for future delete/move tools", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-prot-unit-"));
  try {
    fs.mkdirSync(path.join(dir, "data", "modules"), { recursive: true });
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    const guard = new FileGuard(dir);

    for (const op of ["delete", "move", "rename"] as const) {
      assert.throws(
        () => assertNotProtected(guard, path.join(dir, "data", "modules", "player.gd"), op),
        (e: unknown) => (e as { code?: string }).code === "PROTECTED_PATH"
          && (e as { details?: Record<string, unknown> }).details?.["op"] === op,
      );
      assert.throws(
        () => assertNotProtected(guard, path.join(dir, "assets"), op),
        (e: unknown) => (e as { code?: string }).code === "PROTECTED_PATH",
        "受保护目录自身也是受保护的",
      );
    }
    assert.doesNotThrow(() => assertNotProtected(guard, path.join(dir, "scripts", "player.gd"), "delete"));
    assert.doesNotThrow(() => assertNotProtected(guard, path.join(dir, "data_extra", "x.txt"), "delete"), "同前缀的兄弟目录不受影响");

    if (process.platform === "win32") {
      assert.throws(
        () => assertNotProtected(guard, path.join(dir, "DATA", "Modules", "player.gd"), "overwrite"),
        (e: unknown) => (e as { code?: string }).code === "PROTECTED_PATH",
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
