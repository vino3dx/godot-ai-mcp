import type { ErrorCode } from "../types/index.js";

/** 所有可预期错误都抛 GodotMcpError,带稳定错误码。 */
export class GodotMcpError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "GodotMcpError";
    this.code = code;
    this.details = details;
  }
}
