import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GodotMcpError } from "../src/core/errors.js";
import { FileGuard } from "../src/core/filesystem/fileGuard.js";

const tmpdir = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `gaim-${tag}-`));
const isInvalid = (e: unknown) => e instanceof GodotMcpError && e.code === "INVALID_ARGUMENT";

test("res:// ↔ absolute round trip; relative and in-project absolute accepted", () => {
  const root = tmpdir("guard");
  fs.mkdirSync(path.join(root, "scenes"));
  fs.writeFileSync(path.join(root, "scenes", "main.tscn"), "[gd_scene]\n");
  const g = new FileGuard(root);
  const abs = path.join(root, "scenes", "main.tscn");

  assert.equal(g.toAbsolute("res://scenes/main.tscn"), abs);
  assert.equal(g.toAbsolute("scenes/main.tscn"), abs);
  assert.equal(g.toAbsolute(abs), abs);
  assert.equal(g.toAbsolute("res://scenes/missing.tscn"), path.join(root, "scenes", "missing.tscn")); // 允许尚不存在的路径
  assert.equal(g.toRes(abs), "res://scenes/main.tscn");
  assert.equal(g.toRes(root), "res://");
  assert.equal(g.contains(abs), true);
});

test("traversal / user:// / outside-project / NUL are rejected", () => {
  const root = tmpdir("guard");
  const outside = tmpdir("guard-out");
  const g = new FileGuard(root);

  for (const bad of ["res://../x", "../x", "a/../../x", "res://a/./../b", "res://.."]) {
    assert.throws(() => g.toAbsolute(bad), isInvalid, `expected ${bad} to be rejected`);
  }
  assert.throws(
    () => g.toAbsolute("user://logs/godot.log"),
    (e: unknown) => isInvalid(e) && /user:\/\//.test((e as Error).message),
  );
  assert.throws(() => g.toAbsolute(path.join(outside, "secret.txt")), isInvalid);
  assert.throws(() => g.toAbsolute("res://a\0b"), isInvalid);
  assert.throws(() => g.toRes(path.join(outside, "secret.txt")), isInvalid);
  assert.equal(g.contains(path.join(outside, "secret.txt")), false);
});

test("Windows backslashes and case are handled", () => {
  const root = tmpdir("guard");
  fs.mkdirSync(path.join(root, "scenes"));
  const g = new FileGuard(root);
  assert.equal(g.toAbsolute("res://scenes\\main.tscn"), path.join(root, "scenes", "main.tscn"));
  if (process.platform === "win32") {
    // Windows 大小写不敏感:不同大小写视为同一路径(路径字符串保留原始大小写)
    assert.equal(
      g.toAbsolute("res://SCENES\\MAIN.tscn").toLowerCase(),
      path.join(root, "scenes", "main.tscn").toLowerCase(),
    );
  }
});

test("a directory link pointing outside the project is rejected (symlink escape)", (t) => {
  const root = tmpdir("guard");
  const outside = tmpdir("guard-out");
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret\n");
  const link = path.join(root, "link");
  try {
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("this environment cannot create directory links");
    return;
  }
  const g = new FileGuard(root);
  assert.throws(() => g.toAbsolute("res://link/secret.txt"), (e: unknown) => isInvalid(e) && (e as GodotMcpError).details?.["reason"] === "symlink-escape");
  // 同一路径若经真实目录访问则正常
  fs.mkdirSync(path.join(root, "real"));
  assert.equal(g.toAbsolute("res://real/x.txt"), path.join(root, "real", "x.txt"));
});
