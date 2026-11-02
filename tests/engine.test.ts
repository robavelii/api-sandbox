import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseContract,
  compile,
  match,
  validate,
  deterministicId,
} from "../packages/engine/src/index.js";
const spec = {
  openapi: "3.1.0",
  info: { title: "Customers" },
  paths: {
    "/customers": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        responses: { 201: { description: "Created" } },
      },
    },
    "/customers/{id}": { get: { responses: { 200: { description: "OK" } } } },
    "/customers/{id}/activate": {
      post: { responses: { 200: { description: "OK" } } },
    },
  },
};
test("compilation preserves routes, provenance, schemas, and unconfigured actions", () => {
  const c = compile(spec);
  assert.equal(c.operations.length, 3);
  assert.equal(match(c, "POST", "/customers")?.behavior, "create");
  assert.equal(
    match(c, "POST", "/customers/a/activate")?.behavior,
    "unconfigured",
  );
  assert.equal(match(c, "GET", "/invented"), undefined);
  assert.ok(validate(c.operations[0].request, {}));
  assert.equal(validate(c.operations[0].request, { name: "Ada" }), null);
  assert.equal(deterministicId("customers", 1), "cus_000001");
});
test("JSON/YAML support, duplicate keys, version rejection, unresolved references", () => {
  assert.equal(parseContract(JSON.stringify(spec)).title, "Customers");
  assert.equal(
    parseContract(
      'openapi: 3.0.3\ninfo: {title: Example}\npaths:\n  /items:\n    get:\n      responses:\n        "200": {description: OK}',
    ).title,
    "Example",
  );
  assert.throws(() => parseContract("a: 1\na: 2"));
  assert.throws(() => compile({ ...spec, openapi: "2.0" }));
  assert.throws(() =>
    parseContract(
      JSON.stringify(spec).replace(
        '"type":"object"',
        '"$ref":"https://example.com/schema"',
      ),
    ),
  );
});

test("contract import rejects unsafe regular expressions and bounded-complexity violations", () => {
  const withRequestSchema = (schema: Record<string, unknown>) => ({
    openapi: "3.1.0",
    paths: {
      "/items": {
        post: {
          requestBody: {
            content: { "application/json": { schema } },
          },
          responses: { 201: { description: "Created" } },
        },
      },
    },
  });

  const started = performance.now();
  assert.throws(
    () => compile(withRequestSchema({ type: "string", pattern: "^(a+)+$" })),
    /Regular-expression schema keywords/,
  );
  assert.ok(performance.now() - started < 100);
  assert.throws(
    () =>
      compile(
        withRequestSchema({
          type: "object",
          patternProperties: { ".*": { type: "string" } },
        }),
      ),
    /Regular-expression schema keywords/,
  );
  assert.throws(
    () =>
      compile(
        withRequestSchema({
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 101 }, (_, index) => [
              `field_${index}`,
              { type: "string" },
            ]),
          ),
        }),
      ),
    /at most 100 properties/,
  );
  assert.throws(
    () =>
      compile(
        withRequestSchema({
          type: "array",
          minItems: 21,
          items: { type: "string" },
        }),
      ),
    /minItems cannot exceed 20/,
  );
});

test("schema safety rejects recursive references, excessive depth, and prototype keys", () => {
  const response = (schema: Record<string, unknown>) => ({
    openapi: "3.1.0",
    components: { schemas: { Root: schema } },
    paths: {
      "/items": {
        get: {
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Root" },
                },
              },
            },
          },
        },
      },
    },
  });
  assert.throws(
    () =>
      compile(
        response({
          type: "object",
          properties: { child: { $ref: "#/components/schemas/Root" } },
        }),
      ),
    /Recursive schema references/,
  );

  let nested: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < 22; index++)
    nested = { type: "object", properties: { child: nested } };
  assert.throws(() => compile(response(nested)), /maximum depth/);

  const polluted = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
  );
  assert.throws(() => compile(response(polluted)), /reserved property name/);
});
