import { LockManager } from "../core/concurrency/lockManager.js";
import { TaskQueue } from "../core/concurrency/taskQueue.js";
import { ProjectResolver } from "../core/project/projectResolver.js";
import type { Logger } from "../types/index.js";
import { FileService } from "./fileService.js";
import { GodotCliService } from "./godotCli.js";
import { ProjectService } from "./projectService.js";
import { ResourceService } from "./resourceService.js";
import { SceneService } from "./sceneService.js";
import { ScriptService } from "./scriptService.js";
import { ShaderService } from "./shaderService.js";
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
  /** 项目文件读写(tools 访问底层文件系统的唯一入口)。 */
  file: FileService;
  /** 场景树解析与无损修改。 */
  scene: SceneService;
  /** 资源依赖与子资源管理。 */
  resource: ResourceService;
  /** project.godot 配置读取与无损修改。 */
  projectConfig: ProjectService;
  /** .gdshader 读取与安全更新。 */
  shader: ShaderService;
  /** .gd 脚本读取与安全更新。 */
  script: ScriptService;
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
    file: new FileService(project),
    scene: new SceneService(),
    resource: new ResourceService(),
    projectConfig: new ProjectService(),
    shader: new ShaderService(),
    script: new ScriptService(),
  };
}
