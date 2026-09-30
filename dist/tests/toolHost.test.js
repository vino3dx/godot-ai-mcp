import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/core/logger.js";
import { GodotMcpError } from "../src/core/errors.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { ToolHost, toMcpContent } from "../src/mcp/server/toolHost.js";
import { buildHost } from "../src/index.js";
const quiet = createLogger("error", () => { });
const t = (name, handler) => ({
    name, domain: "utility", description: "d", annotations: { readOnly: true }, runtimeRequired: false, handler,
    inputSchema: { type: "object", required: ["x"], properties: { x: { type: "number" } } },
});
test("ok / invalid args / unknown tool / GodotMcpError / unexpected error", async () => {
    const reg = new ToolRegistry().registerAll([
        t("utility_ok", async (a) => ({ data: a["x"] * 2, message: "hi" })),
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
test("minimal real tools through the composition root", async () => {
    const h = buildHost(quiet);
    assert.deepEqual(h.listTools().map((x) => x.name).sort(), ["utility_ping", "utility_task_status"]);
    const ping = await h.callTool("utility_ping", { echo: "hi" });
    assert.ok(ping.ok && ping.data.pong && ping.data.echo === "hi");
    const st = await h.callTool("utility_task_status", {});
    assert.ok(st.ok && st.data.active === 0);
});
