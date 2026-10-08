import { GodotMcpError } from "../../core/errors.js";
import { validate } from "../../core/validation/schema.js";
import type { JsonSchema, Logger, ToolAnnotations, ToolDomain, ToolResult } from "../../types/index.js";
import type { ToolRegistry } from "../registry/toolRegistry.js";

export interface ToolListing { name: string; description: string; inputSchema: JsonSchema; annotations: ToolAnnotations; runtimeRequired: boolean }

/**
 * 与具体 MCP SDK 无关的"工具宿主":校验入参 → 调用 handler → 统一错误。
 * SDK 适配层(sdkServer.ts)与开发 CLI 都只调用它。
 */
export class ToolHost<Ctx> {
  constructor(
    private readonly registry: ToolRegistry<Ctx>,
    private readonly ctx: Ctx,
    private readonly logger: Logger,
    private readonly enabled?: ReadonlySet<ToolDomain>,
  ) {}

  listTools(): ToolListing[] {
    return this.registry.list(this.enabled).map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
      annotations: t.annotations, runtimeRequired: t.runtimeRequired,
    }));
  }

  async callTool(name: string, rawArgs: unknown): Promise<ToolResult> {
    const tool = this.registry.get(name);
    if (!tool || (this.enabled && this.enabled.size > 0 && !this.enabled.has(tool.domain))) {
      return fail("TOOL_NOT_FOUND", `Unknown tool: ${name}`);
    }
    const v = validate(tool.inputSchema, rawArgs ?? {});
    if (!v.ok) return fail("INVALID_ARGUMENT", `Invalid arguments for ${name}`, { errors: v.errors });
    try {
      const out = await tool.handler(v.value as Record<string, unknown>, this.ctx);
      return {
        ok: true, data: out.data,
        ...(out.message !== undefined ? { message: out.message } : {}),
        // warnings 是非致命提示(如 EDITOR_CONFLICT_WARNING),与错误信封分开;空数组不出现
        ...(out.warnings && out.warnings.length > 0 ? { warnings: out.warnings } : {}),
      };
    } catch (e) {
      if (e instanceof GodotMcpError) return fail(e.code, e.message, e.details);
      this.logger.error(`Unhandled error in ${name}`, e instanceof Error ? e.stack : String(e));
      return fail("INTERNAL", e instanceof Error ? e.message : String(e));
    }
  }
}

function fail(code: Extract<ToolResult, { ok: false }>["error"]["code"], message: string, details?: Record<string, unknown>): ToolResult {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

/** ToolResult → MCP 文本内容(统一 JSON)。warnings 随信封整体序列化,无需额外处理。 */
export function toMcpContent(r: ToolResult): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], ...(r.ok ? {} : { isError: true }) };
}
