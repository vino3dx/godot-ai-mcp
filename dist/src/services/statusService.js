/** 汇报当前正在占用/排队的任务(让 agent 知道"谁在跑、谁在等")。 */
export class StatusService {
    locks;
    constructor(locks) {
        this.locks = locks;
    }
    getTaskStatus() {
        const now = Date.now();
        const entries = this.locks.snapshot().map((e) => ({ ...e, heldForMs: now - e.holder.since }));
        return { active: entries.length, entries };
    }
}
