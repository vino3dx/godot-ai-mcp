import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneRemoveNode: ToolDefinition<AppContext> = {
  name: "scene_remove_node",
  domain: "scene",
  description:
    "Remove a node and all its descendants from a .tscn scene (lossless: other sections stay byte-identical). " +
    "Rejects removing the scene root ('.' or '/root').",
  inputSchema: {
    type: "object",
    required: ["path", "nodePath"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      nodePath: { type: "string", description: "Node to remove ('.' root is rejected; use 'Player' or 'Player/Sprite')." },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: false, destructive: true },
  runtimeRequired: false,
  async handler(args, ctx) {
    return {
      data: await ctx.file.editText(
        args["projectPath"] as string | undefined,
        args["path"] as string,
        (text) => ctx.scene.removeNode(text, args["nodePath"] as string),
        { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
      ),
    };
  },
};
