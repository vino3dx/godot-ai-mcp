// 唯一的工具清单。新增工具:在对应领域目录创建文件 → 在这里加一行。
import type { ToolDefinition } from "../types/index.js";
import type { AppContext } from "../services/context.js";
import { utilityPing } from "./utility/ping.js";
import { utilityTaskStatus } from "./utility/taskStatus.js";

export const allTools: ToolDefinition<AppContext>[] = [utilityPing, utilityTaskStatus];
