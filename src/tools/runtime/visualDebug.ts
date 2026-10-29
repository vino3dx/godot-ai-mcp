import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
export const runtimeVisualDebug: ToolDefinition<AppContext> = {
  name: "runtime_visual_debug", domain: "runtime",
  description: "Run a scene once and return a screenshot together with real post-layout UI diagnostics and targeted node measurements.",
  inputSchema: { type: "object", required: ["scene"], properties: { projectPath: { type: "string" }, scene: { type: "string", minLength: 1 }, nodePaths: { type: "array", items: { type: "string" } }, width: { type: "integer", minimum: 16, maximum: 4096 }, height: { type: "integer", minimum: 16, maximum: 4096 }, frames: { type: "integer", minimum: 1, maximum: 60, default: 3 }, includeHidden: { type: "boolean", default: false }, maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 300 }, includeImage: { type: "boolean", default: true }, timeoutMs: { type: "integer", minimum: 1, default: 30000 }, waitTimeoutMs: { type: "integer", minimum: 1 } } },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: true,
  async handler(args, ctx) {
    const width = args.width as number | undefined, height = args.height as number | undefined;
    const ui = await ctx.runtime.inspectUi({ projectPath: args.projectPath as string | undefined, scene: args.scene as string, nodePaths: args.nodePaths as string[] | undefined, width, height, frames: args.frames as number | undefined, includeHidden: args.includeHidden as boolean | undefined, maxNodes: args.maxNodes as number | undefined, timeoutMs: args.timeoutMs as number | undefined, waitTimeoutMs: args.waitTimeoutMs as number | undefined, tool: "runtime_visual_debug" });
    const shot = await ctx.runtime.captureScreenshot({ projectPath: args.projectPath as string | undefined, scene: args.scene as string, outputWidth: width, outputHeight: height, includeImage: args.includeImage as boolean | undefined, timeoutMs: args.timeoutMs as number | undefined, waitTimeoutMs: args.waitTimeoutMs as number | undefined, tool: "runtime_visual_debug" });
    return { data: { scene: ui.scene, viewportSize: ui.viewportSize, ui, screenshot: { filePath: shot.filePath, outputSize: shot.outputSize, fileSize: shot.fileSize, durationMs: shot.durationMs } }, ...(shot.imageBase64 ? { image: { data: shot.imageBase64, mimeType: "image/png" } } : {}) };
  },
};
