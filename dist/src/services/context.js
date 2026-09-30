import { LockManager } from "../core/concurrency/lockManager.js";
import { TaskQueue } from "../core/concurrency/taskQueue.js";
import { StatusService } from "./statusService.js";
export function createAppContext(logger) {
    const locks = new LockManager();
    return { logger, locks, runQueue: new TaskQueue(locks), status: new StatusService(locks) };
}
