import type { FileService, ReadResult } from "./fileService.js";
import type { SceneService } from "./sceneService.js";
import type { ScriptAnalysis, ScriptService } from "./scriptService.js";

export type GdscriptRelationType = "inherits" | "preload" | "load" | "node_path" | "script_binding" | "signal_define" | "signal_emit" | "signal_connect" | "signal_disconnect" | "scene_signal_connection";
export interface GdscriptRelation { source: string; target: string; relationType: GdscriptRelationType; sourceLocation?: { line: number; text: string }; confidence: "high" | "medium" | "unknown"; context: "disk"; resolutionStatus: "resolved" | "unresolved" | "dynamic" }
export interface GdscriptClassEntry { path: string; className?: string; extends?: string; analysis: ScriptAnalysis }
export interface GdscriptProjectGraph { context: "disk"; scripts: GdscriptClassEntry[]; relations: GdscriptRelation[]; unresolved: string[] }

export class GdscriptProjectService {
  constructor(private readonly files: FileService, private readonly scripts: ScriptService, private readonly scenes: SceneService) {}
  analyze(projectPath?: string): GdscriptProjectGraph {
    const scriptFiles = this.files.listTextFiles(projectPath, ".gd"); const sceneFiles = this.files.listTextFiles(projectPath, ".tscn");
    const analyses = scriptFiles.map((file) => ({ file, analysis: this.scripts.analyze(file.text) })); const classNames = new Map(analyses.filter((x) => x.analysis.className).map((x) => [x.analysis.className!, x.file.resPath])); const knownScripts = new Set(scriptFiles.map((x) => x.resPath));
    const relations: GdscriptRelation[] = []; const unresolved: string[] = [];
    for (const { file, analysis } of analyses) {
      if (analysis.extends) { const target = classNames.get(analysis.extends) ?? analysis.extends; const resolved = classNames.has(analysis.extends) || isNativeClass(analysis.extends); relations.push({ source: file.resPath, target, relationType: "inherits", confidence: resolved ? "high" : "unknown", context: "disk", resolutionStatus: resolved ? "resolved" : "unresolved" }); if (!resolved) unresolved.push(analysis.extends); }
      file.text.split(/\r?\n/).forEach((line, index) => this.extractScriptRelations(file, line, index + 1, relations, unresolved));
      for (const signal of analysis.signals) relations.push({ source: file.resPath, target: `${file.resPath}#${signal.name}`, relationType: "signal_define", confidence: "high", context: "disk", resolutionStatus: "resolved" });
    }
    for (const scene of sceneFiles) { const tree = this.scenes.getSceneTree(scene.text); for (const node of tree.nodes) if (node.script?.startsWith("res://")) relations.push({ source: scene.resPath, target: node.script, relationType: "script_binding", sourceLocation: { line: 0, text: node.path }, confidence: "high", context: "disk", resolutionStatus: knownScripts.has(node.script) ? "resolved" : "unresolved" }); for (const c of tree.connections) relations.push({ source: `${scene.resPath}#${c.source}`, target: `${scene.resPath}#${c.target}.${c.method}`, relationType: "scene_signal_connection", sourceLocation: { line: 0, text: c.signal }, confidence: "high", context: "disk", resolutionStatus: "resolved" }); }
    return { context: "disk", scripts: analyses.map(({ file, analysis }) => ({ path: file.resPath, ...(analysis.className ? { className: analysis.className } : {}), ...(analysis.extends ? { extends: analysis.extends } : {}), analysis })), relations, unresolved: [...new Set(unresolved)] };
  }
  private extractScriptRelations(file: ReadResult, raw: string, line: number, relations: GdscriptRelation[], unresolved: string[]): void {
    const code = raw.replace(/#.*$/, ""); const location = { line, text: raw }; const add = (target: string, relationType: GdscriptRelationType, confidence: GdscriptRelation["confidence"] = "high", resolutionStatus: GdscriptRelation["resolutionStatus"] = "resolved") => { relations.push({ source: file.resPath, target, relationType, sourceLocation: location, confidence, context: "disk", resolutionStatus }); if (resolutionStatus !== "resolved") unresolved.push(target); };
    for (const m of code.matchAll(/\b(preload|load)\s*\(\s*["']([^"']+)["']\s*\)/g)) add(m[2]!, m[1] as "preload" | "load", "high", m[2]!.startsWith("res://") ? "resolved" : "unresolved");
    for (const m of code.matchAll(/@onready\s+var\s+\w+[^=]*=\s*([^\n]+)/g)) extractNodeExpr(m[1]!, add);
    for (const m of code.matchAll(/(?<![A-Za-z0-9_])([$%][A-Za-z0-9_./]+|get_node(?:_or_null)?\s*\([^\n]+\))/g)) extractNodeExpr(m[1]!, add);
    for (const m of code.matchAll(/\b(?:emit_signal|emit)\s*\(\s*["']?([A-Za-z_]\w*)/g)) add(`${file.resPath}#${m[1]}`, "signal_emit");
    for (const m of code.matchAll(/\b(connect|disconnect)\s*\(([^\n]*)\)/g)) { const dynamic = !/["']/.test(m[2]!); add(m[2]!.trim(), m[1] === "connect" ? "signal_connect" : "signal_disconnect", dynamic ? "unknown" : "medium", dynamic ? "dynamic" : "resolved"); }
  }
}

function extractNodeExpr(expr: string, add: (target: string, type: GdscriptRelationType, confidence?: "high" | "medium" | "unknown", status?: "resolved" | "unresolved" | "dynamic") => void): void { const value = expr.trim(); if (value.startsWith("$")) add(value.slice(1), "node_path"); else if (value.startsWith("%")) add(value, "node_path"); else { const quoted = /["']([^"']+)["']/.exec(value); quoted ? add(quoted[1]!, "node_path") : add(value, "node_path", "unknown", "dynamic"); } }
function isNativeClass(value: string): boolean { return /^(Object|RefCounted|Resource|Node|Node2D|Node3D|Control|CanvasItem|CharacterBody2D|CharacterBody3D|Button|Label|Sprite2D|Camera2D|Area2D|StaticBody2D|RigidBody2D|CollisionShape2D)$/.test(value); }
