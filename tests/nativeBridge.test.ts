import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameDecoder, encodeFrame, MAX_BRIDGE_MESSAGE_BYTES, makeRequest } from "../src/godot/bridge/protocol.js";

test("bridge frames survive TCP-style partial and coalesced reads", () => {
  const a = encodeFrame({ id: 1, text: "first" }); const b = encodeFrame({ id: 2, text: "second" });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(a.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(Buffer.concat([a.subarray(2), b])), [{ id: 1, text: "first" }, { id: 2, text: "second" }]);
});

test("bridge protocol rejects oversized frames and creates authenticated requests", () => {
  assert.throws(() => encodeFrame("x".repeat(MAX_BRIDGE_MESSAGE_BYTES)), /maximum size/);
  const request = makeRequest("secret", "project_capabilities");
  assert.equal(request.protocolVersion, 1); assert.equal(request.token, "secret"); assert.equal(request.method, "project_capabilities"); assert.ok(request.requestId);
});
