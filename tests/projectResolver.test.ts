import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GodotMcpError } from "../src/core/errors.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gaim-proj-"));

/** 造一个含 project.godot 的目录;deep 为可选的深层子目录。 */
function makeProject(deep?: string): { root: string; cwd: string } {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "project.godot"), "config_version=5\n");
  const cwd = deep ? path.join(root, deep) : root;
  if (deep) fs.mkdirSync(cwd, { recursive: true });
  return { root, cwd };
}

test("explicit projectPath wins", () => {
  const { root } = makeProject();
  const other = tmpdir();
  const r = new ProjectResolver({ cwd: other, env: {} });
  assert.equal(r.resolve(root), path.resolve(root));
});

test("GODOT_PROJECT_PATH is used when no explicit path is given", () => {
  const { root } = makeProject();
  const r = new ProjectResolver({ cwd: os.tmpdir(), env: { GODOT_PROJECT_PATH: root } });
  assert.equal(r.resolve(), path.resolve(root));
  assert.equal(r.resolve(root), path.resolve(root)); // 两者一致时也正常
});

test("walks up from cwd to find project.godot", () => {
  const { root, cwd } = makeProject(path.join("a", "b", "c"));
  const r = new ProjectResolver({ cwd, env: {} });
  assert.equal(r.resolve(), path.resolve(root));
  assert.equal(r.tryResolve(), path.resolve(root));
});

test("explicit path beats env, and env beats cwd walk-up", () => {
  const a = makeProject();
  const b = makeProject();
  const c = makeProject(path.join("deep", "er"));
  const env = { GODOT_PROJECT_PATH: b.root };

  assert.equal(new ProjectResolver({ cwd: c.cwd, env }).resolve(a.root), path.resolve(a.root));
  assert.equal(new ProjectResolver({ cwd: c.cwd, env }).resolve(), path.resolve(b.root));
  assert.equal(new ProjectResolver({ cwd: c.cwd, env: {} }).resolve(), path.resolve(c.root));
});

test("PROJECT_NOT_FOUND when nothing matches, with diagnostic details", () => {
  const dir = tmpdir();
  const r = new ProjectResolver({ cwd: dir, env: {} });
  assert.equal(r.tryResolve(), undefined);
  assert.throws(
    () => r.resolve(),
    (e: unknown) => e instanceof GodotMcpError && e.code === "PROJECT_NOT_FOUND" && Array.isArray(e.details?.["searched"]),
  );
  assert.throws(
    () => new ProjectResolver({ cwd: dir, env: {} }).resolve(tmpdir()),
    (e: unknown) => e instanceof GodotMcpError && e.code === "PROJECT_NOT_FOUND" && e.details?.["projectPath"] !== null,
  );
});
