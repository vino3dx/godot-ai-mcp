// 全局共享类型。此文件不得 import 任何其他 src 模块(最底层,零依赖)。

/** 稳定错误码。只追加,不改名。 */
export type ErrorCode =
  | "INVALID_ARGUMENT" | "TOOL_NOT_FOUND" | "FILE_NOT_FOUND" | "PARSE_ERROR"
  | "LOCK_TIMEOUT" | "TASK_TIMEOUT" | "RUNTIME_REQUIRED" | "RUNTIME_FAILED" | "INTERNAL"
  | "PROJECT_NOT_FOUND" | "RESOURCE_NOT_FOUND" | "GODOT_NOT_FOUND" | "GODOT_PROCESS_FAILED"
  | "VALIDATION_FAILED" | "FILE_CHANGED";

/** 最小 JSON Schema 子集(工具入参),校验器只支持这些字段,见 core/validation。 */
export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean; // object 默认 false(拒绝未知参数)
  enum?: ReadonlyArray<string | number>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  default?: unknown;
}

/** 工具领域,与 src/tools/<domain> 目录一一对应。 */
export type ToolDomain =
  | "project" | "scene" | "node" | "resource" | "script" | "shader" | "material"
  | "animation" | "filesystem" | "asset" | "debug" | "runtime" | "utility"
  | "ui" | "tilemap" | "particles" | "navigation" | "audio"; // 后五个属于第二版领域

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/**
 * 工具处理函数的返回(成功时)。失败一律 throw GodotMcpError。
 * warnings:非致命提示(例如 EDITOR_CONFLICT_WARNING),走这里而不是错误。
 */
export interface ToolOutput { data: unknown; message?: string; warnings?: string[] }

/** 统一的工具执行结果(ToolHost 产出)。 */
export type ToolResult =
  | { ok: true; data: unknown; message?: string; warnings?: string[] }
  | { ok: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> } };

export interface ToolAnnotations { readOnly: boolean; destructive?: boolean; idempotent?: boolean }

/**
 * 工具定义。Ctx 由组合根(src/index.ts)决定,mcp 层不知道它的具体类型。
 * 命名规则:`<domain>_<action>`,name 必须以 domain 开头(注册时强制)。
 */
export interface ToolDefinition<Ctx = unknown> {
  name: string;
  domain: ToolDomain;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations: ToolAnnotations;
  /** 是否需要启动 Godot(Runtime Adapter)。普通文件级工具必须为 false。 */
  runtimeRequired: boolean;
  handler(args: Record<string, unknown>, ctx: Ctx): Promise<ToolOutput>;
}
