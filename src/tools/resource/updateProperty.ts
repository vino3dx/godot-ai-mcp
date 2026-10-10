import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const resourceUpdateProperty: ToolDefinition<AppContext> = {
  name: "resource_update_property",
  domain: "resource",
  description:
    "Set or add a property in a .tres section (lossless: only the target line changes). " +
    "sectionHeader: 'resource' for the main resource, or a sub_resource id (e.g. 'GDScript_1').",
  inputSchema: {
    type: "object",
    required: ["path", "sectionHeader", "key", "value"],
    properties: {
      path: { type: "string", description: "Resource file path (res://... or project-relative)." },
      sectionHeader: { type: "string", description: "'resource' or a sub_resource id." },
      key: { type: "string", description: "Property name to set or add." },
      value: { type: "string", description: "Raw Godot expression value." },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: false, idempotent: true },
  runtimeRequired: false,
  async handler(args, ctx) {
    return {
      data: await ctx.file.editText(
        args["projectPath"] as string | undefined,
        args["path"] as string,
        (text) => ctx.resource.updateResourceProperty(text, args["sectionHeader"] as string, args["key"] as string, args["value"] as string),
        { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
      ),
    };
  },
};
