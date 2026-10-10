import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const scriptUpdateExportDefault: ToolDefinition<AppContext> = {
  name: "script_update_export_default",
  domain: "script",
  description:
    "Set or add the default value of an @export var in a .gd file (lossless: only the target line changes). " +
    "value is a raw GDScript expression (e.g. '300.0', '\"Hello\"', 'Vector2(1, 2)', '[1, 2]').",
  inputSchema: {
    type: "object",
    required: ["path", "name", "value"],
    properties: {
      path: { type: "string", description: "Script file path (res://... or project-relative)." },
      name: { type: "string", description: "Exported variable name to update (e.g. 'speed')." },
      value: { type: "string", description: "Raw GDScript expression value (e.g. '300.0', '\"Hello\"')." },
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
        (text) => ctx.script.updateExportDefault(text, args["name"] as string, args["value"] as string),
        { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
      ),
    };
  },
};
