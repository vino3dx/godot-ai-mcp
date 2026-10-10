// 唯一的工具清单。新增工具:在对应领域目录创建文件 → 在这里加一行。
import type { ToolDefinition } from "../types/index.js";
import type { AppContext } from "../services/context.js";
import { utilityPing } from "./utility/ping.js";
import { utilityTaskStatus } from "./utility/taskStatus.js";
import { runtimeGetVersion } from "./runtime/getVersion.js";
import { sceneGetTree } from "./scene/getTree.js";
import { sceneUpdateNodeProperty } from "./scene/updateNodeProperty.js";
import { sceneRemoveNode } from "./scene/removeNode.js";
import { resourceGetInfo } from "./resource/getInfo.js";
import { resourceUpdateProperty } from "./resource/updateProperty.js";
import { resourceAddOrUpdateExternal } from "./resource/addOrUpdateExternal.js";

export const allTools: ToolDefinition<AppContext>[] = [
  utilityPing,
  utilityTaskStatus,
  runtimeGetVersion,
  sceneGetTree,
  sceneUpdateNodeProperty,
  sceneRemoveNode,
  resourceGetInfo,
  resourceUpdateProperty,
  resourceAddOrUpdateExternal,
];
