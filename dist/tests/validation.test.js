import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/core/validation/schema.js";
const schema = {
    type: "object",
    required: ["path"],
    properties: {
        path: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["a", "b"], default: "a" },
        n: { type: "integer", minimum: 1, maximum: 5 },
        tags: { type: "array", items: { type: "string" } },
    },
};
test("valid input applies defaults", () => {
    const r = validate(schema, { path: "res://a.tscn" });
    assert.equal(r.ok, true);
    if (r.ok)
        assert.deepEqual(r.value, { path: "res://a.tscn", mode: "a" });
});
test("missing required / wrong type / unknown param / range / enum / array item", () => {
    const r = validate(schema, { n: 9, mode: "z", tags: [1], extra: true });
    assert.equal(r.ok, false);
    if (!r.ok) {
        const text = r.errors.join("\n");
        for (const s of ["$.path: required", "$.n: must be <= 5", "$.mode: must be one of", "$.tags[0]: expected string", "$.extra: unknown parameter"])
            assert.ok(text.includes(s), s);
    }
});
test("non-object input is rejected", () => {
    assert.equal(validate(schema, "x").ok, false);
});
