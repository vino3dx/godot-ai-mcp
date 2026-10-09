import { LockManager } from "../core/concurrency/lockManager.js";
import { TaskQueue } from "../core/concurrency/taskQueue.js";
import { ProjectResolver } from "../core/project/projectResolver.js";
import type { Logger } from "../types/index.js";
import { GodotCliService } from "./godotCli.js";
import { StatusService } from "./statusService.js";

/** 应用上下文:传给每个 Tool handler。新增 Service 在这里挂载。 */
export interface AppContext {
  logger: Logger;
  locks: LockManager;
  runQueue: TaskQueue;
  status: StatusService;
  /** 项目根解析器(工具参数 projectPath > GODOT_PROJECT_PATH > 从 cwd 向上查找)。 */
  project: ProjectResolver;
  /** Godot CLI 探测(定位可执行文件 + 一次受控 --version)。 */
  godot: GodotCliService;
}

export function createAppContext(logger: Logger, project: ProjectResolver = new ProjectResolver()): AppContext {
  const locks = new LockManager();
  return {
    logger,
    locks,
    runQueue: new TaskQueue(locks),
    status: new StatusService(locks),
    project,
    godot: new GodotCliService(),
  };
}
