#!/usr/bin/env node
// 组合根:唯一同时认识所有层的地方。
import { createLogger } from "./core/logger.js";
import { ToolRegistry, parseEnabledDomains } from "./mcp/registry/toolRegistry.js";
import { ToolHost } from "./mcp/server/toolHost.js";
import { startSdkServer } from "./mcp/server/sdkServer.js";
import { createAppContext } from "./services/context.js";
import { allTools } from "./tools/index.js";
export const SERVER_INFO = { name: "godot-ai-mcp", version: "0.1.0" };
export function buildHost(logger = createLogger()) {
    const registry = new ToolRegistry().registerAll(allTools);
    return new ToolHost(registry, createAppContext(logger), logger, parseEnabledDomains(process.env["GODOT_AI_MCP_GROUPS"]));
}
async function main() {
    const logger = createLogger();
    await startSdkServer(buildHost(logger), SERVER_INFO, logger);
}
// 仅在作为入口直接运行时启动(被测试/dev-cli import 时不启动)
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
    main().catch((e) => { process.stderr.write(`[godot-ai-mcp] fatal: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
}
