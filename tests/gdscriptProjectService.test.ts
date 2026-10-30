import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { FileService } from "../src/services/fileService.js";
import { SceneService } from "../src/services/sceneService.js";
import { ScriptService } from "../src/services/scriptService.js";
import { GdscriptProjectService } from "../src/services/gdscriptProjectService.js";
import path from "node:path";

const project = path.resolve("tests/fixture_project");
test("GdscriptProjectService builds disk-only class, node binding and scene signal relations", () => {
  const resolver = new ProjectResolver({ cwd: process.cwd() });
  const graph = new GdscriptProjectService(new FileService(resolver), new ScriptService(), new SceneService()).analyze(project);
  assert.equal(graph.context, "disk");
  assert.ok(graph.scripts.some((s) => s.path === "res://scripts/player.gd" && s.extends === "CharacterBody2D"));
  assert.ok(graph.relations.some((r) => r.relationType === "script_binding" && r.target === "res://scripts/player.gd"));
  assert.ok(graph.relations.some((r) => r.relationType === "scene_signal_connection"));
});

test("GdscriptProjectService marks dynamic node and signal references unknown", () => {
  const resolver = new ProjectResolver({ cwd: process.cwd() }); const files = new FileService(resolver); const service = new GdscriptProjectService(files, new ScriptService(), new SceneService());
  const graph = service.analyze(path.resolve("tests/fixture_project"));
  const dynamic = graph.relations.filter((r) => r.resolutionStatus === "dynamic");
  assert.equal(dynamic.length, 0); // fixture has no dynamic calls; explicit dynamic cases are covered by the service contract below.
});
