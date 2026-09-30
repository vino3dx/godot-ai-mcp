#!/usr/bin/env node
// 开发用 CLI:不经过任何 MCP 客户端/SDK,直接列出或调用工具。
//   node dist/src/dev-cli.js list
//   node dist/src/dev-cli.js call utility_ping '{"echo":"hi"}'
import { buildHost } from "./index.js";

const [cmd, name, json] = process.argv.slice(2);
const host = buildHost();
if (cmd === "list") {
  for (const t of host.listTools()) console.log(`${t.name}${t.runtimeRequired ? " [runtime]" : ""} - ${t.description}`);
} else if (cmd === "call" && name) {
  console.log(JSON.stringify(await host.callTool(name, json ? JSON.parse(json) : {}), null, 2));
} else {
  console.error("usage: dev-cli list | dev-cli call <tool> [jsonArgs]");
  process.exit(2);
}
