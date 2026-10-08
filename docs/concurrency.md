# 并发与排队

代码位置:`src/core/concurrency/`(`lockManager.ts`、`taskQueue.ts`)。
**由 Service 层统一使用,Tool 不自己实现锁。**

## 1. 文件写锁 LockManager

```ts
const release = await locks.acquire(key, { tool, target }, { timeoutMs, onWait });
// 用完必须 release();异常路径用 withLocks 保证释放
await locks.withLocks([fileA, fileB], owner, async () => { /* 写多个文件 */ });
```

| 规则 | 说明 |
|---|---|
| 锁粒度 | 规范化后的文件路径。`normalizeLockKey()` = `path.resolve` → 统一 `/` → Windows 下转小写,避免大小写/相对路径导致的假并行 |
| 读写 | **读操作不加锁**;只有写操作获取锁。后到者 FIFO 排队,不插队 |
| 多文件 | `withLocks` 对 key 去重后**排序**再依次获取 → 固定顺序,不会死锁 |
| 释放 | `finally` 中逆序释放;`fn` 抛错也会释放。release 函数幂等(`released` 标志),重复调用无副作用 |
| 超时 | `timeoutMs` 到点从队列摘除自己并抛 `LOCK_TIMEOUT`,details 带 `{ key, waitedMs, heldBy, heldForMs }` |
| 事务性 | 多 key 获取途中某个超时,已持有的会被 `finally` 释放,不会泄漏 |

**锁不可重入(重要)**:同一把锁在同一调用链上再次获取会**死锁**(后到者排队等在原地)。

- Service **只在公共入口加一次锁**,拿到锁后调用的私有/内部方法**不得**再对同一 key 调 `acquire` / `withLocks`。
- 需要"我已在锁里"的能力时,把已解锁的逻辑拆成私有方法(如 `writeUnlocked()`),公共入口加锁后调用它;不要把锁传递给内部方法。
- `withLocks` 对多个 key 去重 + 排序,所以同一批 key 内重复传同一路径是安全的;不安全的是"里面再套一层"。`TaskQueue` 的 `godot-run:` key 同理。

**占用信息**(等锁的人知道"谁在跑"):

- `LockOwner = { tool, target, taskId, since }`,taskId 缺省由 `newTaskId()` 生成(`t<base36 时间>-<base36 序号>`)。
- `onWait(info)` 在真正需要排队时回调一次:`{ key, heldBy, queuePosition }`,`queuePosition` 从 1 开始。
- `snapshot()` 返回 `{ key, holder, waiting[] }[]`,供 `utility_task_status` 查询。

## 2. 项目级 Godot 运行队列 TaskQueue

同一项目同一时间只允许**一个** Godot 进程(run / validate / execute / screenshot / export / reimport)。

```ts
await runQueue.runExclusive(projectPath, owner, async (signal) => {
  // signal 会在执行超时时 abort,必须响应(例如杀掉 Godot 子进程)
}, { waitTimeoutMs, runTimeoutMs, onWait });
```

- 底层复用 `LockManager`,key 前缀 `godot-run:<规范化项目路径>` —— 不重复造轮子。
- `waitTimeoutMs` 排队上限,超时 → `LOCK_TIMEOUT`。
- `runTimeoutMs` 执行上限,超时 → `TASK_TIMEOUT`,同时 `abort(signal)`。先 reject 再 abort:否则 fn 内部的取消错误会抢先返回。
- 任何路径(成功 / 抛错 / 超时 / abort)都会释放队列位置,不会卡死后续请求。
- Stage 1 不实现真实 Godot 进程管理(见 `docs/HANDOFF.md` 的 T8)。

## 3. 查看当前占用

`utility_task_status` 工具 → `StatusService.getTaskStatus()`:

```json
{ "active": 1,
  "entries": [ { "key": "…/a.tscn", "holder": {"tool":"scene_create","target":"…","taskId":"t…","since":…},
                 "waiting": [...], "heldForMs": 1234 } ] }
```

## 4. 范围与边界

- **v1 只保证同一个 MCP 进程内有效。** 多个 agent 各自启动独立 MCP 实例时,两个进程之间互相锁不住。
- 跨进程锁需要磁盘锁文件(含 stale 锁回收),列为可选后续项,**第一版不做**。
- 与 Godot 编辑器的冲突不在锁的保护范围内:编辑器同时打开同一场景/脚本时,直接改磁盘文件可能被编辑器覆盖或触发重载。这是纯文件方案的固有边界。
- 锁等待与任务执行都**必须有超时**;`LOCK_TIMEOUT` / `TASK_TIMEOUT` 都要附带当前占用者信息,便于 agent 判断是"等一等"还是"换目标"。
