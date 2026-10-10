import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/core/logger.js";
import { GodotMcpError } from "../src/core/errors.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { ToolHost, toMcpContent } from "../src/mcp/server/toolHost.js";
import { buildHost } from "../src/index.js";
import type { ToolDefinition } from "../src/types/index.js";

const quiet = createLogger("error", () => {});
const t = (name: string, handler: ToolDefinition["handler"]): ToolDefinition => ({
  name, domain: "utility", description: "d", annotations: { readOnly: true }, runtimeRequired: false, handler,
  inputSchema: { type: "object", required: ["x"], properties: { x: { type: "number" } } },
});

test("ok / invalid args / unknown tool / GodotMcpError / unexpected error", async () => {
  const reg = new ToolRegistry().registerAll([
    t("utility_ok", async (a) => ({ data: (a["x"] as number) * 2, message: "hi" })),
    t("utility_known", async () => { throw new GodotMcpError("FILE_NOT_FOUND", "nope", { path: "p" }); }),
    t("utility_bug", async () => { throw new TypeError("oops"); }),
  ]);
  const h = new ToolHost(reg, {}, quiet);
  assert.deepEqual(await h.callTool("utility_ok", { x: 2 }), { ok: true, data: 4, message: "hi" });
  const bad = await h.callTool("utility_ok", {});
  assert.ok(!bad.ok && bad.error.code === "INVALID_ARGUMENT");
  const nf = await h.callTool("nope_tool", {});
  assert.ok(!nf.ok && nf.error.code === "TOOL_NOT_FOUND");
  const k = await h.callTool("utility_known", { x: 1 });
  assert.ok(!k.ok && k.error.code === "FILE_NOT_FOUND" && k.error.details?.["path"] === "p");
  const b = await h.callTool("utility_bug", { x: 1 });
  assert.ok(!b.ok && b.error.code === "INTERNAL");
  assert.equal(toMcpContent(b).isError, true);
});

test("warnings are non-fatal hints, passed through to the result and the MCP content", async () => {
  const reg = new ToolRegistry().registerAll([
    t("utility_warn", async () => ({ data: { n: 1 }, warnings: ["EDITOR_CONFLICT_WARNING: scene is open in the editor"] })),
    t("utility_nowarn", async () => ({ data: { n: 1 }, warnings: [] })),
  ]);
  const h = new ToolHost(reg, {}, quiet);

  const w = await h.callTool("utility_warn", { x: 1 });
  assert.deepEqual(w, { ok: true, data: { n: 1 }, warnings: ["EDITOR_CONFLICT_WARNING: scene is open in the editor"] });
  const block = toMcpContent(w).content[0];
  assert.ok(block);
  assert.equal(JSON.parse(block.text).warnings[0].startsWith("EDITOR_CONFLICT_WARNING"), true);
  assert.equal(toMcpContent(w).isError, undefined);

  // 空数组不制造噪音
  assert.deepEqual(await h.callTool("utility_nowarn", { x: 1 }), { ok: true, data: { n: 1 } });
});

test("minimal real tools through the composition root", async () => {
  const h = buildHost(quiet);
  assert.deepEqual(h.listTools().map((x) => x.name).sort(), [
    "resource_add_or_update_external", "resource_get_info", "resource_update_property",
    "runtime_get_version",
    "scene_get_tree", "scene_remove_node", "scene_update_node_property",
    "utility_ping", "utility_task_status",
  ]);
  const ping = await h.callTool("utility_ping", { echo: "hi" });
  assert.ok(ping.ok && (ping.data as { pong: boolean; echo: string }).pong && (ping.data as { echo: string }).echo === "hi");
  const st = await h.callTool("utility_task_status", {});
  assert.ok(st.ok && (st.data as { active: number }).active === 0);
});
