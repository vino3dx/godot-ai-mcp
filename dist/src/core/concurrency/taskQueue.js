import { GodotMcpError } from "../errors.js";
import { normalizeLockKey, newTaskId } from "./lockManager.js";
/**
 * 项目级 Godot 运行队列:同一项目同一时间只允许一个 Godot 进程。
 * 底层复用 LockManager(key 前缀 godot-run:),不重复造轮子。
 * fn 必须响应 signal(例如超时时杀掉 Godot 子进程)。
 */
export class TaskQueue {
    locks;
    constructor(locks) {
        this.locks = locks;
    }
    async runExclusive(projectPath, input, fn, opts = {}) {
        const key = `godot-run:${normalizeLockKey(projectPath)}`;
        const acquireOpts = {
            ...(opts.waitTimeoutMs !== undefined ? { timeoutMs: opts.waitTimeoutMs } : {}),
            ...(opts.onWait ? { onWait: opts.onWait } : {}),
        };
        const release = await this.locks.acquire(key, { ...input, taskId: input.taskId ?? newTaskId() }, acquireOpts);
        const ctrl = new AbortController();
        let timer;
        try {
            if (opts.runTimeoutMs === undefined)
                return await fn(ctrl.signal);
            return await Promise.race([
                fn(ctrl.signal),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        // 先 reject 再 abort:abort 会同步触发 fn 内部的取消逻辑,否则它的错误会抢先返回
                        reject(new GodotMcpError("TASK_TIMEOUT", `Task ${input.tool} exceeded ${opts.runTimeoutMs}ms and was aborted`, { key, runTimeoutMs: opts.runTimeoutMs }));
                        ctrl.abort();
                    }, opts.runTimeoutMs);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            release();
        }
    }
}
