import { test } from "node:test";
import assert from "node:assert/strict";
import { unifiedDiff } from "../src/core/filesystem/unifiedDiff.js";

const text = (...lines: string[]) => lines.join("\n") + "\n";

test("identical text has no diff", () => {
  assert.equal(unifiedDiff("", ""), "");
  assert.equal(unifiedDiff(text("a", "b"), text("a", "b")), "");
});

test("single line change produces a one-line diff (context 3)", () => {
  const d = unifiedDiff(text("a", "b", "c", "d", "e"), text("a", "b", "X", "d", "e"), { aLabel: "a/f", bLabel: "b/f" });
  assert.equal(d, text("--- a/f", "+++ b/f", "@@ -1,5 +1,5 @@", " a", " b", "-c", "+X", " d", " e"));
});

test("empty → content and content → empty", () => {
  assert.equal(unifiedDiff("", text("x"), { aLabel: "a/f", bLabel: "b/f" }), text("--- a/f", "+++ b/f", "@@ -0,0 +1,1 @@", "+x"));
  assert.equal(unifiedDiff(text("x"), "", { aLabel: "a/f", bLabel: "b/f" }), text("--- a/f", "+++ b/f", "@@ -1,1 +0,0 @@", "-x"));
});

test("missing trailing newline is marked like git", () => {
  const d = unifiedDiff("a\nb", "a\nc", { aLabel: "a/f", bLabel: "b/f" });
  assert.equal(d, text("--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+c", "\\ No newline at end of file"));
});

test("adding only the trailing newline is still a change", () => {
  const d = unifiedDiff("x", "x\n", { aLabel: "a/f", bLabel: "b/f" });
  assert.equal(d, text("--- a/f", "+++ b/f", "@@ -1,1 +1,1 @@", "-x", "\\ No newline at end of file", "+x"));
});

test("appending lines at the end", () => {
  const d = unifiedDiff(text("a"), text("a", "b"), { aLabel: "a/f", bLabel: "b/f" });
  assert.equal(d, text("--- a/f", "+++ b/f", "@@ -1,1 +1,2 @@", " a", "+b"));
});
