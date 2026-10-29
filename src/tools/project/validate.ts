import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const projectValidate: ToolDefinition<AppContext> = {
  name: "project_validate", domain: "project",
  description: "Validate a Godot 4.6.x project without modifying it: check GDScript syntax, external scene/resource references, and headless runtime startup. Results distinguish syntax, resources and runtime; expected validation failures are returned as structured issues.",
  inputSchema: { type: "object", properties: { projectPath: { type: "string" }, scene: { type: "string", description: "Optional scene to run instead of the project main scene." }, timeoutMs: { type: "integer", minimum: 1, default: 30000 }, waitTimeoutMs: { type: "integer", minimum: 1 } } },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: true,
  async handler(args, ctx) {
    return { data: await ctx.validation.validate({ projectPath: args.projectPath as string | undefined, scene: args.scene as string | undefined, timeoutMs: args.timeoutMs as number | undefined, waitTimeoutMs: args.waitTimeoutMs as number | undefined, tool: "project_validate" }) };
  },
};
