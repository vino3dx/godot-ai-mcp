import { test } from "node:test";
import assert from "node:assert/strict";
import { allTools } from "../src/tools/index.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import type { AppContext } from "../src/services/context.js";

test("persistent runtime session tools are registered with strict schemas", () => {
  const registry = new ToolRegistry<AppContext>().registerAll(allTools);
  for (const name of ["runtime_start_session", "runtime_get_session", "runtime_read_session_logs", "runtime_stop_session"]) {
    const tool = registry.get(name);
    assert.ok(tool, `${name} must be registered`);
    assert.equal(tool.domain, "runtime");
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.inputSchema.properties);
  }
  assert.deepEqual(registry.get("runtime_start_session")?.inputSchema.required, ["projectPath"]);
  assert.deepEqual(registry.get("runtime_get_session")?.inputSchema.required, ["sessionId"]);
  assert.deepEqual(registry.get("runtime_read_session_logs")?.inputSchema.required, ["sessionId"]);
  assert.deepEqual(registry.get("runtime_stop_session")?.inputSchema.required, ["sessionId"]);
});
