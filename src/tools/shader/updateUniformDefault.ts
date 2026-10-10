import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const shaderUpdateUniformDefault: ToolDefinition<AppContext> = {
  name: "shader_update_uniform_default",
  domain: "shader",
  description:
    "Set or add the default value of a uniform in a .gdshader file (lossless: only the target line changes). " +
    "value is a raw shader expression (e.g. 'vec3(1.0, 0.0, 0.0)', '0.5', 'true').",
  inputSchema: {
    type: "object",
    required: ["path", "name", "value"],
    properties: {
      path: { type: "string", description: "Shader file path (res://... or project-relative)." },
      name: { type: "string", description: "Uniform name to update (e.g. 'albedo', 'roughness')." },
      value: { type: "string", description: "Raw shader default expression (e.g. 'vec3(1.0)', '0.5')." },
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
        (text) => ctx.shader.updateUniformDefault(text, args["name"] as string, args["value"] as string),
        { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
      ),
    };
  },
};
