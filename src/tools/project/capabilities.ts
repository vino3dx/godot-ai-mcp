import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const projectCapabilities: ToolDefinition<AppContext> = {
  name: "project_capabilities", domain: "project", description: "Read capabilities and identity from the connected Godot Editor Bridge.",
  inputSchema: { type: "object", properties: { projectPath: { type: "string", minLength: 1 } } },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: false,
  async handler(args, ctx) { const root = ctx.project.resolve(args.projectPath as string | undefined); return { data: await ctx.nativeBridge.getCapabilities(root) }; },
};
