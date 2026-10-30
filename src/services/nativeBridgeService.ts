import path from "node:path";
import type { NativeBridgeClient } from "../godot/bridge/client.js";

export interface ProjectCapabilities { protocolVersion: number; godotVersion: string; godotInstanceId: string; bridgeSessionId: string; projectPath: string; projectId: string; editorConnected: boolean; pluginRunning: boolean; currentScene?: { path: string; dirty: boolean }; nativeCapabilities: Record<string, boolean>; }
export class NativeBridgeService {
  constructor(private readonly factory: (projectRoot: string) => NativeBridgeClient) {}
  async getCapabilities(projectRoot: string): Promise<ProjectCapabilities> { return this.factory(projectRoot).call<ProjectCapabilities>("project_capabilities", { projectPath: path.resolve(projectRoot) }); }
}
