#!/usr/bin/env node
// 组合根:唯一同时认识所有层的地方。
import { createLogger } from "./core/logger.js";
import { ToolRegistry, parseEnabledDomains } from "./mcp/registry/toolRegistry.js";
import { ToolHost } from "./mcp/server/toolHost.js";
import { startSdkServer } from "./mcp/server/sdkServer.js";
import { createAppContext, type AppContext } from "./services/context.js";
import { allTools } from "./tools/index.js";

export const SERVER_INFO = { name: "godot-ai-mcp", version: "1.2.0" } as const;

export function buildHost(logger = createLogger()): ToolHost<AppContext> {
  const registry = new ToolRegistry<AppContext>().registerAll(allTools);
  return new ToolHost(registry, createAppContext(logger), logger, parseEnabledDomains(process.env["GODOT_AI_MCP_GROUPS"]));
}

async function main(): Promise<void> {
  const logger = createLogger();
  await startSdkServer(buildHost(logger), SERVER_INFO, logger);
}

// 仅在作为入口直接运行时启动(被测试/dev-cli import 时不启动)
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((e) => { process.stderr.write(`[godot-ai-mcp] fatal: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
}
