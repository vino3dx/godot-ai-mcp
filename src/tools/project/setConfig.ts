import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const projectSetConfig: ToolDefinition<AppContext> = {
  name: "project_set_config",
  domain: "project",
  description:
    "Set or add a project.godot config value (lossless: only the target line changes, or a new section/key is appended). " +
    "Examples: section 'application' key 'config/name'; section 'display' key 'window/size/viewport_width'; section 'application' key 'run/main_scene'. " +
    "value is a raw Godot expression (quote strings, e.g. '\"res://main.tscn\"').",
  inputSchema: {
    type: "object",
    required: ["section", "key", "value"],
    properties: {
      path: { type: "string", description: "Config file path. Defaults to res://project.godot.", default: "res://project.godot" },
      section: { type: "string", description: "Section name (e.g. 'application', 'display')." },
      key: { type: "string", description: "Config key (e.g. 'config/name', 'window/size/viewport_width')." },
      value: { type: "string", description: "Raw Godot expression value (e.g. '\"My Game\"', '1280', '\"res://main.tscn\"')." },
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
        (text) => ctx.projectConfig.setConfigValue(
          text,
          args["section"] as string,
          args["key"] as string,
          args["value"] as string,
        ),
        { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
      ),
    };
  },
};
