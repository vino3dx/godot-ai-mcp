import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate, truncateText } from "../src/core/output.js";

test("paginate slices with total and nextOffset", () => {
  const items = [1, 2, 3, 4, 5];
  assert.deepEqual(paginate(items, { limit: 2 }), { items: [1, 2], total: 5, nextOffset: 2 });
  assert.deepEqual(paginate(items, { limit: 2, offset: 2 }), { items: [3, 4], total: 5, nextOffset: 4 });
  assert.deepEqual(paginate(items, { limit: 2, offset: 4 }), { items: [5], total: 5, nextOffset: null });
  assert.deepEqual(paginate(items, { offset: 10 }), { items: [], total: 5, nextOffset: null });
  assert.deepEqual(paginate([], { limit: 2 }), { items: [], total: 0, nextOffset: null });
  assert.equal(paginate(items).items.length, 5); // 默认 limit
  assert.equal(paginate(items, { limit: 10_000 }).items.length, 5); // 上限内
});

test("paginate ignores nonsense limit/offset", () => {
  const items = [1, 2, 3];
  assert.deepEqual(paginate(items, { limit: -1, offset: -5 }), { items, total: 3, nextOffset: null });
  assert.deepEqual(paginate(items, { limit: Number.NaN, offset: 0.5 }), { items, total: 3, nextOffset: null });
});

test("truncateText cuts on UTF-8 boundaries", () => {
  assert.deepEqual(truncateText("hello", 10), { text: "hello", truncated: false });
  assert.deepEqual(truncateText("hello", 5), { text: "hello", truncated: false });
  assert.deepEqual(truncateText("hello", 3), { text: "hel", truncated: true });
  // "中" = 3 bytes;maxBytes=4 只能放下一个
  assert.deepEqual(truncateText("中中", 4), { text: "中", truncated: true });
  assert.deepEqual(truncateText("中文", 6), { text: "中文", truncated: false });
  assert.deepEqual(truncateText("", 0), { text: "", truncated: false });
  assert.deepEqual(truncateText("abc", 0), { text: "", truncated: true });
});
