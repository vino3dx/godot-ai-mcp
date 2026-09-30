import { GodotMcpError } from "../../core/errors.js";
import { validate } from "../../core/validation/schema.js";
/**
 * 与具体 MCP SDK 无关的"工具宿主":校验入参 → 调用 handler → 统一错误。
 * SDK 适配层(sdkServer.ts)与开发 CLI 都只调用它。
 */
export class ToolHost {
    registry;
    ctx;
    logger;
    enabled;
    constructor(registry, ctx, logger, enabled) {
        this.registry = registry;
        this.ctx = ctx;
        this.logger = logger;
        this.enabled = enabled;
    }
    listTools() {
        return this.registry.list(this.enabled).map((t) => ({
            name: t.name, description: t.description, inputSchema: t.inputSchema,
            annotations: t.annotations, runtimeRequired: t.runtimeRequired,
        }));
    }
    async callTool(name, rawArgs) {
        const tool = this.registry.get(name);
        if (!tool || (this.enabled && this.enabled.size > 0 && !this.enabled.has(tool.domain))) {
            return fail("TOOL_NOT_FOUND", `Unknown tool: ${name}`);
        }
        const v = validate(tool.inputSchema, rawArgs ?? {});
        if (!v.ok)
            return fail("INVALID_ARGUMENT", `Invalid arguments for ${name}`, { errors: v.errors });
        try {
            const out = await tool.handler(v.value, this.ctx);
            return { ok: true, data: out.data, ...(out.message !== undefined ? { message: out.message } : {}) };
        }
        catch (e) {
            if (e instanceof GodotMcpError)
                return fail(e.code, e.message, e.details);
            this.logger.error(`Unhandled error in ${name}`, e instanceof Error ? e.stack : String(e));
            return fail("INTERNAL", e instanceof Error ? e.message : String(e));
        }
    }
}
function fail(code, message, details) {
    return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}
/** ToolResult → MCP 文本内容(统一 JSON)。 */
export function toMcpContent(r) {
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], ...(r.ok ? {} : { isError: true }) };
}
