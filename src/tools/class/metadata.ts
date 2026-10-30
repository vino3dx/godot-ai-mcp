import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const classGetInfo: ToolDefinition<AppContext> = {
  name: "class_get_info", domain: "class", description: "Query engine ClassDB metadata for a Godot class. This is API metadata from an engine dump, not a live Editor object.",
  inputSchema: { type: "object", required: ["className"], properties: { className: { type: "string", minLength: 1 }, projectPath: { type: "string", minLength: 1 } } }, annotations: { readOnly: true, idempotent: true }, runtimeRequired: true,
  async handler(args, ctx) { return { data: await ctx.godotApi.getClassInfo(args.projectPath as string | undefined, args.className as string) }; },
};

export const classSearch: ToolDefinition<AppContext> = {
  name: "class_search", domain: "class", description: "Search the complete engine ClassDB index by class name.",
  inputSchema: { type: "object", properties: { query: { type: "string", default: "" }, projectPath: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } } }, annotations: { readOnly: true, idempotent: true }, runtimeRequired: true,
  async handler(args, ctx) { return { data: await ctx.godotApi.searchClasses(args.projectPath as string | undefined, args.query as string | undefined ?? "", args.limit as number | undefined) }; },
};

export const classValidateMember: ToolDefinition<AppContext> = {
  name: "class_validate_member", domain: "class", description: "Validate a property, method, or signal against engine ClassDB metadata.",
  inputSchema: { type: "object", required: ["className"], properties: { className: { type: "string", minLength: 1 }, property: { type: "string", minLength: 1 }, method: { type: "string", minLength: 1 }, signal: { type: "string", minLength: 1 }, projectPath: { type: "string", minLength: 1 } } }, annotations: { readOnly: true, idempotent: true }, runtimeRequired: true,
  async handler(args, ctx) { return { data: await ctx.godotApi.validateMember(args.projectPath as string | undefined, args.className as string, { ...(args.property ? { property: args.property as string } : {}), ...(args.method ? { method: args.method as string } : {}), ...(args.signal ? { signal: args.signal as string } : {}) }) }; },
};
