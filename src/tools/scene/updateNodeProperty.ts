import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneUpdateNodeProperty: ToolDefinition<AppContext> = {
  name: "scene_update_node_property",
  domain: "scene",
  description:
    "Set or add a property on a node in a .tscn scene (lossless: only the target line changes). " +
    "nodePath: '.' or '/root' for the root, otherwise a slash path relative to the root (e.g. 'Player/Sprite').",
  inputSchema: {
    type: "object",
    required: ["path", "nodePath", "key", "value"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      nodePath: { type: "string", description: "Target node path ('.' = root, 'Player', 'Player/Sprite', '/root/...')." },
      key: { type: "string", description: "Property name to set or add." },
      value: { type: "string", description: "Raw Godot expression value (e.g. 'Vector2(1, 2)', '\"Hello\"')." },
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
        (text) => ctx.scene.updateNodeProperty(text, args["nodePath"] as string, args["key"] as string, args["value"] as string),
        { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
      ),
    };
  },
};
