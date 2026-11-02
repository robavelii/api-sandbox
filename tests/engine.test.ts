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
