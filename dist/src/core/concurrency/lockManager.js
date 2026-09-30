import path from "node:path";
import { GodotMcpError } from "../errors.js";
let seq = 0;
export const newTaskId = () => `t${Date.now().toString(36)}-${(seq++).toString(36)}`;
/** 规范化锁 key:路径统一为绝对路径,Windows 下大小写不敏感。 */
export function normalizeLockKey(p) {
    const abs = path.resolve(p).replace(/\\/g, "/");
    return process.platform === "win32" ? abs.toLowerCase() : abs;
}
/**
 * 进程内的 FIFO 互斥锁,按 key 独立排队。
 * 范围:仅同一 MCP 进程有效;跨进程需要磁盘锁文件(后续可选项,见 docs/architecture.md)。
 */
export class LockManager {
    slots = new Map();
    async acquire(key, input, opts = {}) {
        const owner = { ...input, taskId: input.taskId ?? newTaskId(), since: Date.now() };
        const slot = this.slots.get(key);
        if (!slot) {
            this.slots.set(key, { holder: owner, queue: [] });
            return this.releaser(key, owner);
        }
        opts.onWait?.({ key, heldBy: slot.holder, queuePosition: slot.queue.length + 1 });
        return new Promise((resolve, reject) => {
            let timer;
            const waiter = {
                owner,
                grant: () => { if (timer)
                    clearTimeout(timer); owner.since = Date.now(); resolve(this.releaser(key, owner)); },
                reject,
            };
            slot.queue.push(waiter);
            if (opts.timeoutMs !== undefined) {
                timer = setTimeout(() => {
                    const i = slot.queue.indexOf(waiter);
                    if (i >= 0)
                        slot.queue.splice(i, 1);
                    reject(new GodotMcpError("LOCK_TIMEOUT", `Timed out after ${opts.timeoutMs}ms waiting for lock "${key}"`, {
                        key, waitedMs: opts.timeoutMs, heldBy: slot.holder, heldForMs: Date.now() - slot.holder.since,
                    }));
                }, opts.timeoutMs);
            }
        });
    }
    /** 按 key 排序依次加锁(固定顺序,防死锁),fn 结束或抛错都会释放。 */
    async withLocks(keys, input, fn, opts = {}) {
        const sorted = [...new Set(keys)].sort();
        const taskId = input.taskId ?? newTaskId();
        const releases = [];
        try {
            for (const k of sorted)
                releases.push(await this.acquire(k, { ...input, taskId }, opts));
            return await fn();
        }
        finally {
            for (const r of releases.reverse())
                r();
        }
    }
    snapshot() {
        return [...this.slots.entries()].map(([key, s]) => ({ key, holder: { ...s.holder }, waiting: s.queue.map((w) => ({ ...w.owner })) }));
    }
    releaser(key, owner) {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            const slot = this.slots.get(key);
            if (!slot || slot.holder !== owner)
                return;
            const next = slot.queue.shift();
            if (!next) {
                this.slots.delete(key);
                return;
            }
            slot.holder = next.owner;
            next.grant();
        };
    }
}
