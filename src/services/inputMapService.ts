import { GodotMcpError } from "../core/errors.js";
import { parseGodotConfigFile } from "../core/parser/index.js";
import type { GodotLineEnding } from "../core/parser/types.js";
import { ProjectService } from "./projectService.js";

export type InputEventType = "InputEventKey" | "InputEventMouseButton" | "InputEventJoypadButton" | "InputEventJoypadMotion";
export interface InputEventInfo { index: number; type: string; known: boolean; raw: string; fields: Record<string, unknown> }
export interface InputActionInfo { name: string; deadzone: number | null; events: InputEventInfo[]; raw: string }
export interface InputEventSpec { type: InputEventType; [key: string]: unknown }
export type InputUpdate =
  | { operation: "add_action"; action: string; deadzone?: number; event?: InputEventSpec }
  | { operation: "set_deadzone"; action: string; deadzone: number }
  | { operation: "add_event"; action: string; event: InputEventSpec }
  | { operation: "remove_event"; action: string; eventIndex: number }
  | { operation: "replace_event"; action: string; eventIndex: number; event: InputEventSpec };

const EVENT_TYPES = new Set<InputEventType>(["InputEventKey", "InputEventMouseButton", "InputEventJoypadButton", "InputEventJoypadMotion"]);
const FIELD_NAMES: Record<InputEventType, Set<string>> = {
  InputEventKey: new Set(["resource_local_to_scene", "resource_name", "device", "window_id", "alt_pressed", "shift_pressed", "ctrl_pressed", "meta_pressed", "pressed", "keycode", "physical_keycode", "key_label", "unicode", "location", "echo", "script"]),
  InputEventMouseButton: new Set(["resource_local_to_scene", "resource_name", "device", "window_id", "alt_pressed", "shift_pressed", "ctrl_pressed", "meta_pressed", "pressed", "button_mask", "position", "global_position", "factor", "button_index", "canceled", "double_click", "script"]),
  InputEventJoypadButton: new Set(["resource_local_to_scene", "resource_name", "device", "button_index", "pressure", "pressed", "script"]),
  InputEventJoypadMotion: new Set(["resource_local_to_scene", "resource_name", "device", "axis", "axis_value", "script"]),
};
const CAMEL_TO_GODOT: Record<string, string> = { physicalKeycode: "physical_keycode", keycode: "keycode", keyLabel: "key_label", windowId: "window_id", altPressed: "alt_pressed", shiftPressed: "shift_pressed", ctrlPressed: "ctrl_pressed", metaPressed: "meta_pressed", buttonMask: "button_mask", buttonIndex: "button_index", globalPosition: "global_position", doubleClick: "double_click", axisValue: "axis_value", resourceLocalToScene: "resource_local_to_scene", resourceName: "resource_name" };

export class InputMapService {
  constructor(private readonly project: ProjectService) {}

  get(text: string, action?: string): InputActionInfo[] {
    const ast = parseGodotConfigFile(text);
    const section = ast.sections.find((s) => s.name === "input");
    const entries = section?.entries.filter((e) => e.kind === "key") ?? [];
    const selected = action === undefined ? entries : entries.filter((e) => e.key === action);
    if (action !== undefined && selected.length === 0) throw new GodotMcpError("INVALID_ARGUMENT", `输入动作不存在: ${action}`, { action });
    return selected.map((e) => parseAction(e.key, e.value));
  }

  update(text: string, update: InputUpdate): { text: string; action: InputActionInfo } {
    validateUpdate(update);
    if (update.operation === "add_action") {
      const exists = parseGodotConfigFile(text).sections.find((s) => s.name === "input")?.entries.some((e) => e.kind === "key" && e.key === update.action);
      if (exists) throw new GodotMcpError("INVALID_ARGUMENT", `输入动作已存在: ${update.action}`, { action: update.action });
      const raw = encodeAction(update.deadzone ?? 0.5, update.event ? [encodeEvent(update.event)] : []);
      const ast = parseGodotConfigFile(text); const input = ast.sections.find((s) => s.name === "input");
      if (!input) throw new GodotMcpError("INVALID_ARGUMENT", "project.godot 缺少 [input] 段", { action: update.action });
      input.entries.push({ kind: "key", key: update.action, value: raw, prefix: `${update.action}=`, eol: (ast.newline || "\n") as GodotLineEnding });
      return { text: serializeConfig(ast), action: parseAction(update.action, raw) };
    }
    const current = this.get(text, update.action)[0]!;
    let action: InputActionInfo = current;
    if (update.operation === "set_deadzone") action = { ...current, deadzone: update.deadzone };
    else if (update.operation === "add_event") {
      const raw = encodeEvent(update.event);
      if (current.events.some((e) => isDuplicateEvent(e.raw, raw))) throw new GodotMcpError("INVALID_ARGUMENT", "输入事件已存在,拒绝重复添加", { action: update.action });
      action = { ...current, events: [...current.events, parseEvent(raw, current.events.length)] };
    } else if (update.operation === "remove_event") {
      requireIndex(current, update.eventIndex);
      action = { ...current, events: current.events.filter((e) => e.index !== update.eventIndex).map((e, i) => ({ ...e, index: i })) };
    } else if (update.operation === "replace_event") {
      requireIndex(current, update.eventIndex);
      const raw = encodeEvent(update.event);
      if (current.events.some((e) => e.index !== update.eventIndex && isDuplicateEvent(e.raw, raw))) throw new GodotMcpError("INVALID_ARGUMENT", "替换后会产生重复输入事件", { action: update.action });
      action = { ...current, events: current.events.map((e) => e.index === update.eventIndex ? parseEvent(raw, e.index) : e) };
    }
    const raw = encodeAction(action.deadzone ?? 0.5, action.events.map((e) => e.raw));
    const result = this.project.setConfigValueResult(text, "input", update.action, raw);
    const verified = this.get(result.text, update.action)[0];
    if (!verified || JSON.stringify(verified.events.map((e) => e.raw)) !== JSON.stringify(action.events.map((e) => e.raw))) throw new GodotMcpError("VALIDATION_FAILED", "Input Map 修改后复核失败", { action: update.action });
    return { text: result.text, action: verified };
  }
}

function parseAction(name: string, raw: string): InputActionInfo { const fields = parseFields(raw.trim().replace(/^\{|\}$/g, "")); const deadzone = numberValue(fields.deadzone); const eventValues = splitTop(String(fields.events ?? "").replace(/^\[|\]$/g, "")); return { name, deadzone, events: eventValues.filter(Boolean).map((e, i) => parseEvent(e, i)), raw }; }
function parseEvent(raw: string, index: number): InputEventInfo { const match = /^Object\(\s*([A-Za-z0-9_]+)\s*,?([\s\S]*)\)$/.exec(raw.trim()); if (!match) return { index, type: "Unknown", known: false, raw, fields: {} }; const type = match[1]!; const fields = parseFields(match[2]!.trim()); return { index, type, known: EVENT_TYPES.has(type as InputEventType), raw, fields }; }
function parseFields(text: string): Record<string, unknown> { const out: Record<string, unknown> = {}; for (const part of splitTop(text)) { const i = findColon(part); if (i < 0) continue; const key = part.slice(0, i).trim().replace(/^"|"$/g, ""); out[key] = parseScalar(part.slice(i + 1).trim()); } return out; }
function splitTop(text: string): string[] { const out: string[] = []; let start = 0, depth = 0, quote = false, escape = false; for (let i = 0; i < text.length; i++) { const c = text[i]!; if (quote) { if (escape) escape = false; else if (c === "\\") escape = true; else if (c === '"') quote = false; continue; } if (c === '"') { quote = true; continue; } if ("([{".includes(c)) depth++; else if (")] }".replace(/ /g, "").includes(c)) depth--; else if (c === "," && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; } } if (text.slice(start).trim()) out.push(text.slice(start).trim()); return out; }
function findColon(text: string): number { let quote = false; for (let i = 0; i < text.length; i++) { if (text[i] === '"') quote = !quote; if (!quote && text[i] === ":") return i; } return -1; }
function numberValue(raw: unknown): number | null { if (typeof raw !== "number" && typeof raw !== "string") return null; const n = Number(raw); return Number.isFinite(n) ? n : null; }
function parseScalar(raw: string): unknown { if (raw === "true") return true; if (raw === "false") return false; if (raw === "null") return null; if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return Number(raw); if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/\\(.)/g, "$1"); return raw; }
function encodeEvent(event: InputEventSpec): string { const type = event.type; if (!EVENT_TYPES.has(type)) throw new GodotMcpError("INVALID_ARGUMENT", `不支持的输入事件类型: ${type}`, { type }); const allowed = FIELD_NAMES[type]; const fields: string[] = []; for (const [inputName, value] of Object.entries(event)) { if (inputName === "type") continue; const name = CAMEL_TO_GODOT[inputName] ?? inputName; if (!allowed.has(name)) throw new GodotMcpError("INVALID_ARGUMENT", `事件属性不支持: ${inputName}`, { type, property: inputName }); fields.push(`${name}:${encodeValue(value)}`); } return `Object(${type}${fields.length ? `,${fields.join(",")}` : ""})`; }
function encodeValue(value: unknown): string { if (typeof value === "boolean" || typeof value === "number") return String(value); if (typeof value === "string") return value.startsWith("res://") ? `\"${value}\"` : /^-?\d+(\.\d+)?$/.test(value) ? value : `\"${value.replaceAll('"', '\\\"')}\"`; if (Array.isArray(value)) return `[${value.map(encodeValue).join(",")}]`; throw new GodotMcpError("INVALID_ARGUMENT", "输入事件属性值类型不支持", { value }); }
function encodeAction(deadzone: number, events: string[]): string { return `{\n"deadzone": ${deadzone},\n"events": [${events.join(",")} ]\n}`; }
function canonicalEvent(raw: string): string { return raw.replace(/\s+/g, ""); }
function isDuplicateEvent(existing: string, candidate: string): boolean { const a = parseEvent(existing, 0); const b = parseEvent(candidate, 0); if (a.type !== b.type) return false; return Object.entries(b.fields).every(([key, value]) => a.fields[key] === value); }
function requireIndex(action: InputActionInfo, index: number): void { if (!Number.isInteger(index) || index < 0 || index >= action.events.length) throw new GodotMcpError("INVALID_ARGUMENT", `输入事件索引不存在: ${index}`, { index, action: action.name }); }
function validateUpdate(update: InputUpdate): void { if (!update.action || /[\r\n=]/.test(update.action)) throw new GodotMcpError("INVALID_ARGUMENT", "输入动作名称非法", { action: update.action }); if ("deadzone" in update && (update.deadzone === undefined || !Number.isFinite(update.deadzone) || update.deadzone < 0 || update.deadzone > 1)) throw new GodotMcpError("INVALID_ARGUMENT", "deadzone 必须在 0 到 1 之间", { deadzone: update.deadzone }); }
function serializeConfig(ast: ReturnType<typeof parseGodotConfigFile>): string { let out = ""; for (const e of ast.preamble) out += e.kind === "key" ? e.prefix + e.value + e.eol : e.raw + e.eol; for (const s of ast.sections) { out += s.headerRaw + s.headerEol; for (const e of s.entries) out += e.kind === "key" ? e.prefix + e.value + e.eol : e.raw + e.eol; } return out; }
