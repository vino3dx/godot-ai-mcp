import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneGetTree: ToolDefinition<AppContext> = {
  name: "scene_get_tree",
  domain: "scene",
  description:
    "Parse a .tscn scene file and return its structured node tree (name, type, path, parent, attached script, groups, properties). " +
    "Returns the file hash so a later write can pass expectedHash for optimistic concurrency.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      projectPath: { type: "string", description: "Project root override. Defaults to GODOT_PROJECT_PATH, then cwd upward search." },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  async handler(args, ctx) {
    const read = ctx.file.read(args["projectPath"] as string | undefined, args["path"] as string);
    return { data: { resPath: read.resPath, hash: read.hash, tree: ctx.scene.getSceneTree(read.text) } };
  },
};
