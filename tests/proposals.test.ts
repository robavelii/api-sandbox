import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../packages/engine/src/index.js";
import { defaultDefinition } from "../packages/engine/src/scenario.js";
import {
  proposeScenario,
  suggestedFailures,
} from "../packages/engine/src/proposals.js";

const contract = compile({
  openapi: "3.1.0",
  paths: {
    "/items": { post: { responses: { 201: { description: "created" } } } },
  },
});

test("offline drafts cite declared operations and are repeatable", () => {
  const drafts = suggestedFailures(contract);
  assert.deepEqual(drafts, suggestedFailures(contract));
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].requiresApproval, true);
  assert.equal(drafts[0].provenance, "template");
  assert.deepEqual(drafts[0].evidence, ["POST /items"]);
  assert.equal(drafts[0].definition.rules[0].times, 3);
});

test("provider proposals are validated, isolated and repaired at most once", async () => {
  let calls = 0;
  const original = structuredClone(contract);
  const result = await proposeScenario(
    contract,
    " retry payment ",
    async (request) => {
      assert.equal(request.prompt, "retry payment");
      request.contract.operations.length = 0;
      calls++;
      if (calls === 1)
        return {
          ...defaultDefinition(),
          rules: [{ operation: "POST /invented" }],
        };
      assert.match(request.validationError!, /Unknown operation/);
      return suggestedFailures(contract)[0].definition;
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.provenance, "ai-inferred");
  assert.equal(result.requiresApproval, true);
  assert.deepEqual(result.evidence, ["POST /items"]);
  assert.deepEqual(contract, original);
  let invalidCalls = 0;
  await assert.rejects(
    () =>
      proposeScenario(contract, "test", async () => {
        invalidCalls++;
        return {};
      }),
    /one repair/,
  );
  assert.equal(invalidCalls, 2);
});

test("provider failures propagate and inputs are bounded", async () => {
  const provider = async () => {
    throw new Error("Unavailable");
  };
  await assert.rejects(
    () => proposeScenario(contract, "test", provider),
    /Unavailable/,
  );
  for (const prompt of ["", " ", "a".repeat(2001)])
    await assert.rejects(
      () => proposeScenario(contract, prompt, provider),
      /1–2000/,
    );
  for (const timeout of [0, 30001, 1.5])
    await assert.rejects(
      () => proposeScenario(contract, "test", provider, timeout),
      /timeout must/,
    );
});

test("deadline aborts provider and prevents late repair calls", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  await assert.rejects(
    () =>
      proposeScenario(
        contract,
        "test",
        async (request) => {
          calls++;
          signal = request.signal;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {};
        },
        1,
      ),
    /timed out/,
  );
  assert.equal(signal?.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
});
