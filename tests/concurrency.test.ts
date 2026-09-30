import { test } from "node:test";
import assert from "node:assert/strict";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { GodotMcpError } from "../src/core/errors.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const who = (tool: string, target = "a.tscn") => ({ tool, target });

test("same key runs FIFO, never overlapping", async () => {
  const lm = new LockManager(); const log: string[] = []; let running = 0;
  const job = (id: string) => lm.withLocks(["k"], who(id), async () => {
    running++; assert.equal(running, 1); log.push("start " + id); await sleep(15); log.push("end " + id); running--;
  });
  await Promise.all([job("1"), job("2"), job("3")]);
  assert.deepEqual(log, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  assert.equal(lm.snapshot().length, 0);
});
test("different keys run in parallel", async () => {
  const lm = new LockManager(); let both = 0, running = 0;
  const job = (k: string) => lm.withLocks([k], who("t", k), async () => { running++; both = Math.max(both, running); await sleep(20); running--; });
  await Promise.all([job("a"), job("b")]);
  assert.equal(both, 2);
});
test("waiter is told who holds the lock and its queue position", async () => {
  const lm = new LockManager(); const seen: Array<{ tool: string; pos: number }> = [];
  const r1 = await lm.acquire("k", who("scene_add_node"));
  const p2 = lm.acquire("k", who("shader_edit"), { onWait: (i) => seen.push({ tool: i.heldBy.tool, pos: i.queuePosition }) });
  const p3 = lm.acquire("k", who("material_edit"), { onWait: (i) => seen.push({ tool: i.heldBy.tool, pos: i.queuePosition }) });
  assert.deepEqual(seen, [{ tool: "scene_add_node", pos: 1 }, { tool: "scene_add_node", pos: 2 }]);
  assert.equal(lm.snapshot()[0]?.waiting.length, 2);
  r1(); (await p2)(); (await p3)();
  assert.equal(lm.snapshot().length, 0);
});
test("wait timeout -> LOCK_TIMEOUT with holder info; queue stays healthy", async () => {
  const lm = new LockManager();
  const r1 = await lm.acquire("k", who("holder"));
  await assert.rejects(lm.acquire("k", who("late"), { timeoutMs: 20 }), (e: unknown) => {
    assert.ok(e instanceof GodotMcpError); assert.equal(e.code, "LOCK_TIMEOUT");
    assert.equal((e.details?.["heldBy"] as { tool: string }).tool, "holder"); return true;
  });
  r1();
  const r2 = await lm.acquire("k", who("next")); r2();
  assert.equal(lm.snapshot().length, 0);
});
test("lock released when fn throws; multi-key uses fixed order (no deadlock)", async () => {
  const lm = new LockManager();
  await assert.rejects(lm.withLocks(["k"], who("t"), async () => { throw new Error("boom"); }), /boom/);
  assert.equal(lm.snapshot().length, 0);
  await Promise.all([lm.withLocks(["a", "b"], who("x"), () => sleep(10)), lm.withLocks(["b", "a"], who("y"), () => sleep(10))]);
  assert.equal(lm.snapshot().length, 0);
});
test("TaskQueue: one Godot run per project, run timeout aborts and frees the slot", async () => {
  const lm = new LockManager(); const q = new TaskQueue(lm); let aborted = false;
  await assert.rejects(q.runExclusive("/p", who("runtime_run_project"), (signal) => new Promise((_, rej) => { signal.addEventListener("abort", () => { aborted = true; rej(new Error("killed")); }); }), { runTimeoutMs: 20 }), (e: unknown) => e instanceof GodotMcpError && e.code === "TASK_TIMEOUT");
  assert.ok(aborted); assert.equal(lm.snapshot().length, 0);
  const order: string[] = [];
  await Promise.all(["1", "2"].map((id) => q.runExclusive("/p", who("t" + id), async () => { order.push("s" + id); await sleep(10); order.push("e" + id); })));
  assert.deepEqual(order, ["s1", "e1", "s2", "e2"]);
});
