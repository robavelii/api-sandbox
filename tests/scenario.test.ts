import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, validate } from "../packages/engine/src/index.js";
import {
  definition,
  defaultDefinition,
  selectRule,
  generate,
  fingerprint,
} from "../packages/engine/src/scenario.js";
const contract = compile({
  openapi: "3.1.0",
  paths: {
    "/items": { post: { responses: { 201: { description: "ok" } } } },
    "/items/{id}/activate": {
      post: {
        responses: {
          200: {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { enum: ["pending", "active"] } },
                },
              },
            },
          },
        },
      },
    },
  },
});
test("scenario DSL rejects unknown operations, code, unsafe fields, invalid clocks and unbounded timers", () => {
  const value = defaultDefinition();
  for (const input of [
    { ...value, extra: "code" },
    { ...value, clock: "invalid" },
    { ...value, rules: [{ operation: "POST /invented" }] },
    { ...value, rules: [{ operation: "POST /items", delayMs: 5001 }] },
    {
      ...value,
      rules: [
        {
          operation: "POST /items/{id}/activate",
          action: { type: "transition", field: "id", from: ["a"], to: "b" },
        },
      ],
    },
    {
      ...value,
      rules: [
        {
          operation: "POST /items/{id}/activate",
          action: {
            type: "transition",
            field: "status",
            from: ["pending"],
            to: "unknown",
          },
        },
      ],
    },
  ])
    assert.throws(() => definition(input, contract));
  const valid = definition(
    {
      ...value,
      rules: [
        {
          operation: "POST /items",
          times: 3,
          failure: { phase: "before", status: 429 },
        },
      ],
    },
    contract,
  );
  assert.equal(selectRule(valid, "POST /items", { "0": 2 })?.index, 0);
  assert.equal(selectRule(valid, "POST /items", { "0": 3 }), undefined);
});
test("generation is deterministic, bounded, and resolves local refs without I/O", () => {
  const schema = {
    type: "object",
    properties: {
      status: { enum: ["pending", "active"] },
      created_at: { type: "string", format: "date-time" },
      name: { type: "string" },
      nested: { $ref: "#/components/schemas/Nested" },
    },
    components: {
      schemas: {
        Nested: {
          type: "object",
          properties: { amount: { type: "integer", minimum: 2, maximum: 20 } },
        },
      },
    },
  };
  const a = generate(schema, "seed", "2026-01-01T00:00:00Z");
  assert.deepEqual(a, generate(schema, "seed", "2026-01-01T00:00:00Z"));
  assert.notEqual(
    a.name,
    generate(schema, "other", "2026-01-01T00:00:00Z").name,
  );
  assert.equal(validate(schema, a), null);
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  assert.throws(() =>
    generate({ type: "array", minItems: 100 }, "seed", "2026-01-01T00:00:00Z"),
  );
});
