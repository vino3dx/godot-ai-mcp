import { randomUUID } from "node:crypto";

export const BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_BRIDGE_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_BRIDGE_TIMEOUT_MS = 3_000;

export interface BridgeRequest { protocolVersion: number; requestId: string; token: string; method: string; params: Record<string, unknown> }
export interface BridgeResponse { protocolVersion: number; requestId: string; success: boolean; data?: unknown; error: BridgeErrorPayload | null }
export interface BridgeErrorPayload { code: string; message: string; details?: Record<string, unknown> }

export function makeRequest(token: string, method: string, params: Record<string, unknown> = {}): BridgeRequest {
  return { protocolVersion: BRIDGE_PROTOCOL_VERSION, requestId: randomUUID(), token, method, params };
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_BRIDGE_MESSAGE_BYTES) throw new Error("Bridge message exceeds maximum size");
  const frame = Buffer.allocUnsafe(4 + body.length); frame.writeUInt32BE(body.length, 0); body.copy(frame, 4); return frame;
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]); const out: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_BRIDGE_MESSAGE_BYTES) throw new Error("Bridge message exceeds maximum size");
      if (this.buffer.length < length + 4) break;
      const body = this.buffer.subarray(4, length + 4); this.buffer = this.buffer.subarray(length + 4);
      out.push(JSON.parse(body.toString("utf8")) as unknown);
    }
    return out;
  }
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  const v = value as Partial<BridgeResponse> | null;
  return !!v && typeof v === "object" && typeof v.protocolVersion === "number" && typeof v.requestId === "string" && typeof v.success === "boolean";
}
