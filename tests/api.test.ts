import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { createApp } from "../apps/api/src/main.js";
import { hashPassword, verifyPassword } from "../apps/api/src/auth.js";
import { deliverOne, fanoutOne } from "../apps/worker/src/worker.js";
import { signWebhook } from "../packages/engine/src/webhook-crypto.js";
test("password hashing uses distinct salts and rejects incorrect passwords", async () => {
  const a = await hashPassword("long-test-password");
  const b = await hashPassword("long-test-password");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("long-test-password", a), true);
  assert.equal(await verifyPassword("wrong", a), false);
});
test(
  "PostgreSQL API integration",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await pool.query(await readFile("migrations/001_foundation.sql", "utf8"));
    await pool.query(await readFile("migrations/002_scenarios.sql", "utf8"));
    await pool.query(await readFile("migrations/003_webhooks.sql", "utf8"));
    await pool.query(
      await readFile("migrations/004_proposal_usage.sql", "utf8"),
    );
    await pool.query(
      await readFile("migrations/005_email_verification.sql", "utf8"),
    );
    await pool.query(
      await readFile("migrations/006_workspace_invitations.sql", "utf8"),
    );
    await pool.query(
      await readFile("migrations/007_account_recovery.sql", "utf8"),
    );
    await pool.query(await readFile("migrations/008_audit_events.sql", "utf8"));
    let verificationCode = "";
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];
    const app = await createApp(pool, {
      sendVerification: async (_email, code) => {
        verificationCode = code;
      },
      proposalProvider: async () => ({
        version: 1,
        name: "AI draft",
        seed: "test",
        clock: "2026-01-01T00:00:00.000Z",
        idempotency: "replay",
        rules: [],
      }),
      webhookEncryptionKey: encryptionKey,
      webhookResolver: publicResolver,
    });
    t.after(async () => {
      await app.close();
      await pool.end();
    });
    const f = app.getHttpAdapter().getInstance();
    async function request(
      path: string,
      method: any = "GET",
      data?: any,
      cookie = "",
      key = "",
    ) {
      const r = await f.inject({
        url: path,
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        ...(data === undefined ? {} : { payload: data }),
      });
      return {
        status: r.statusCode,
        data: r.body ? JSON.parse(r.body) : null,
        cookie: String(r.headers["set-cookie"] || "").split(";")[0],
      };
    }
    assert.equal((await request("/api/sandboxes")).status, 401);
    const first = await request("/api/auth/register", "POST", {
      email: "one@example.com",
      password: "long-test-password",
    });
    assert.equal(first.status, 201);
    const auth = first.cookie;
    assert.ok(auth.includes("st_session="));
    const second = await request("/api/auth/register", "POST", {
      email: "two@example.com",
      password: "long-test-password",
    });
    const other = second.cookie;
    assert.equal(
      (await request("/api/auth/email-verification", "POST", {}, other)).status,
      200,
    );
    const expiredCode = verificationCode;
    await pool.query(
      "UPDATE email_verifications SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [second.data.id],
    );
    assert.equal(
      (
        await request(
          "/api/auth/email-verification/confirm",
          "POST",
          { code: expiredCode },
          other,
        )
      ).status,
      400,
    );
    assert.equal(
      (await request("/api/auth/email-status", "GET", undefined, auth)).data
        .verified,
      false,
    );
    assert.equal(
      (await request("/api/auth/email-verification", "POST", {}, auth)).status,
      200,
    );
    assert.match(verificationCode, /^[a-f0-9]{64}$/);
    assert.notEqual(
      (
        await pool.query(
          "SELECT token_hash FROM email_verifications WHERE user_id=$1",
          [first.data.id],
        )
      ).rows[0].token_hash,
      verificationCode,
    );
    assert.equal(
      (await request("/api/auth/email-verification", "POST", {}, auth)).status,
      429,
    );
    assert.equal(
      (
        await request(
          "/api/auth/email-verification/confirm",
          "POST",
          { code: verificationCode },
          other,
        )
      ).status,
      400,
    );
    const confirmations = await Promise.all(
      Array.from({ length: 2 }, () =>
        request(
          "/api/auth/email-verification/confirm",
          "POST",
          { code: verificationCode },
          auth,
        ),
      ),
    );
    assert.deepEqual(confirmations.map((r) => r.status).sort(), [200, 400]);
    assert.equal(
      (await request("/api/auth/email-status", "GET", undefined, auth)).data
        .verified,
      true,
    );
    assert.equal(
      (await request("/api/auth/email-verification", "POST", {}, auth)).status,
      409,
    );
    const spec = JSON.parse(
      await readFile("apps/web/public/payments.json", "utf8"),
    );
    const responseSchema = {
      type: "object",
      required: ["id", "amount", "currency", "status", "created_at"],
      properties: {
        id: { type: "string" },
        amount: { type: "integer" },
        currency: { type: "string" },
        status: {
          type: "string",
          enum: ["processing", "succeeded"],
          default: "processing",
        },
        created_at: { type: "string", format: "date-time" },
        label: { type: "string" },
      },
    };
    spec.paths["/payments"].post.responses["201"].content = {
      "application/json": { schema: responseSchema },
    };
    spec.paths["/payments/{id}/capture"].post.responses["200"].content = {
      "application/json": { schema: responseSchema },
    };
    const created = await request(
      "/api/sandboxes",
      "POST",
      { source: JSON.stringify(spec) },
      auth,
    );
    assert.equal(created.status, 201);
    const { id, apiKey, sessionId } = created.data;
    assert.equal(
      (await request("/api/workspaces", "GET", undefined, auth)).data.length,
      1,
    );
    assert.equal(
      (
        await request(
          "/api/workspaces/select",
          "POST",
          { workspaceId: second.data.organization_id },
          auth,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          "/api/workspaces/select",
          "POST",
          { workspaceId: "invalid" },
          auth,
        )
      ).status,
      400,
    );
    await pool.query("INSERT INTO memberships VALUES($1,$2,'member')", [
      first.data.id,
      second.data.organization_id,
    ]);
    const picked = await request(
      "/api/workspaces/select",
      "POST",
      { workspaceId: second.data.organization_id },
      auth,
    );
    assert.equal(picked.status, 200);
    const inOtherWorkspace = `${auth}; ${picked.cookie}`;
    assert.equal(
      (await request("/api/me", "GET", undefined, inOtherWorkspace)).data.role,
      "member",
    );
    assert.equal(
      (
        await request(
          `/api/sandboxes/${id}/sessions`,
          "GET",
          undefined,
          inOtherWorkspace,
        )
      ).status,
      404,
    );
    await pool.query(
      "DELETE FROM memberships WHERE user_id=$1 AND organization_id=$2",
      [first.data.id, second.data.organization_id],
    );
    assert.equal(
      (await request("/api/me", "GET", undefined, inOtherWorkspace)).status,
      401,
    );
    assert.equal(
      (await request("/api/workspaces", "GET", undefined, inOtherWorkspace))
        .status,
      200,
    );
    assert.equal(
      (
        await request(
          "/api/workspaces/select",
          "POST",
          { workspaceId: first.data.organization_id },
          inOtherWorkspace,
        )
      ).status,
      200,
    );
    const aiDraft = await request(
      `/api/sandboxes/${id}/proposals`,
      "POST",
      { prompt: "Retry payments" },
      auth,
    );
    assert.equal(aiDraft.status, 200);
    assert.equal(aiDraft.data.provenance, "ai-inferred");
    assert.equal(aiDraft.data.requiresApproval, true);
    assert.equal(
      (
        await request(
          `/api/sandboxes/${id}/proposals`,
          "POST",
          { prompt: "" },
          auth,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          `/api/sandboxes/${id}/proposals`,
          "POST",
          { prompt: "test" },
          other,
        )
      ).status,
      404,
    );
    await pool.query(
      "UPDATE proposal_usage SET requests=99 WHERE organization_id=$1",
      [first.data.organization_id],
    );
    const competing = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(
          `/api/sandboxes/${id}/proposals`,
          "POST",
          { prompt: "test" },
          auth,
        ),
      ),
    );
    assert.equal(competing.filter((r) => r.status === 200).length, 1);
    assert.equal(competing.filter((r) => r.status === 429).length, 3);
    assert.equal(
      (
        await pool.query(
          "SELECT requests FROM proposal_usage WHERE organization_id=$1",
          [first.data.organization_id],
        )
      ).rows[0].requests,
      100,
    );
    const proposals = await request(
      `/api/sandboxes/${id}/proposals`,
      "GET",
      undefined,
      auth,
    );
    assert.equal(proposals.status, 200);
    assert.ok(proposals.data.length > 0);
    assert.equal(proposals.data[0].requiresApproval, true);
    assert.equal(proposals.data[0].provenance, "template");
    assert.equal(
      (await request(`/api/sandboxes/${id}/proposals`, "GET", undefined, other))
        .status,
      404,
    );
    assert.equal((await request(`/api/sandboxes/${id}/proposals`)).status, 401);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM sandbox_versions WHERE sandbox_id=$1",
          [id],
        )
      ).rows[0].count,
      "1",
    );
    const p = `/sandbox/${id}`;
    assert.equal(
      (await request("/api/sandboxes", "GET", undefined, other)).data.length,
      0,
    );
    assert.equal(
      (await request(`/api/sandboxes/${id}/sessions`, "GET", undefined, other))
        .status,
      404,
    );
    assert.equal(
      (
        await request(
          p + "/payments",
          "POST",
          { amount: 1, currency: "USD" },
          "",
          apiKey,
        )
      ).status,
      409,
    );
    await request(`/api/sandboxes/${id}/approve`, "POST", {}, auth);
    assert.equal(
      (
        await request(
          p + "/payments",
          "POST",
          { amount: 1, currency: "USD" },
          "",
          "wrong",
        )
      ).status,
      401,
    );
    assert.equal(
      (await request(p + "/payments", "POST", { currency: "USD" }, "", apiKey))
        .status,
      400,
    );
    const one = await request(
      p + "/payments",
      "POST",
      { amount: 1, currency: "USD" },
      "",
      apiKey,
    );
    assert.equal(one.status, 201);
    assert.equal(one.data.id, "pay_000001");
    assert.equal(
      (await request(p + "/payments/pay_000001", "GET", undefined, "", apiKey))
        .data.amount,
      1,
    );
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(
          p + "/payments",
          "POST",
          { amount: 2, currency: "USD" },
          "",
          apiKey,
        ),
      ),
    );
    assert.equal(new Set(concurrent.map((x) => x.data.id)).size, 5);
    const isolated = await request(
      `/api/sandboxes/${id}/sessions`,
      "POST",
      { name: "ci" },
      auth,
    );
    assert.equal(isolated.status, 201);
    const empty = await f.inject({
      method: "GET",
      url: p + "/payments",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-spectwin-session": "ci",
      },
    });
    assert.deepEqual(JSON.parse(empty.body), []);
    await request(
      `/api/sandboxes/${id}/sessions/${sessionId}/scenario`,
      "POST",
      { scenario: "error" },
      auth,
    );
    assert.equal(
      (
        await request(
          p + "/payments",
          "POST",
          { amount: 5, currency: "USD" },
          "",
          apiKey,
        )
      ).status,
      500,
    );
    await request(
      `/api/sandboxes/${id}/sessions/${sessionId}/scenario`,
      "POST",
      { scenario: "success" },
      auth,
    );
    assert.equal(
      (await request(p + "/payments", "GET", undefined, "", apiKey)).data
        .length,
      6,
    );
    await request(
      `/api/sandboxes/${id}/sessions/${sessionId}/reset`,
      "POST",
      {},
      auth,
    );
    const replay = await request(
      p + "/payments",
      "POST",
      { amount: 1, currency: "USD" },
      "",
      apiKey,
    );
    assert.deepEqual(replay.data, one.data);
    assert.equal(
      (
        await request(
          p + "/payments/pay_000001/capture",
          "POST",
          {},
          "",
          apiKey,
        )
      ).status,
      501,
    );
    const configuration = {
      version: 1,
      name: "Retry and capture",
      seed: "integration-test",
      clock: "2026-06-01T12:00:00.000Z",
      idempotency: "replay",
      rules: [
        {
          operation: "POST /payments",
          times: 3,
          failure: { phase: "before", status: 429 },
        },
        {
          operation: "POST /payments/{id}/capture",
          action: {
            type: "transition",
            field: "status",
            from: ["processing"],
            to: "succeeded",
          },
          failure: { phase: "after", status: 503 },
        },
      ],
    };
    const draft = await request(
      `/api/sandboxes/${id}/versions`,
      "POST",
      configuration,
      auth,
    );
    assert.equal(draft.status, 201);
    assert.equal(
      (await request(`/api/sandboxes/${id}/versions`, "GET", undefined, other))
        .status,
      404,
    );
    assert.equal(
      (
        await request(
          `/api/sandboxes/${id}/sessions/${sessionId}/configure`,
          "POST",
          { versionId: draft.data.id },
          auth,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          `/api/sandboxes/${id}/versions`,
          "POST",
          { ...configuration, rules: [{ operation: "POST /invented" }] },
          auth,
        )
      ).status,
      400,
    );
    await request(
      `/api/sandboxes/${id}/versions/${draft.data.id}/approve`,
      "POST",
      {},
      auth,
    );
    assert.equal(
      (
        await request(
          `/api/sandboxes/${id}/sessions/${sessionId}/configure`,
          "POST",
          { versionId: draft.data.id },
          auth,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/api/sandboxes/${id}/sessions`, "GET", undefined, auth)
      ).data.find((s: any) => s.name === "ci").version_id,
      id,
    );
    await assert.rejects(
      () =>
        pool.query(
          'UPDATE sandbox_versions SET definition=definition || \'{"name":"mutated"}\'::jsonb WHERE id=$1',
          [draft.data.id],
        ),
      /immutable/,
    );
    async function send(
      url: string,
      method: any = "GET",
      body?: any,
      key?: string,
    ) {
      const result = await f.inject({
        url: p + url,
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(key ? { "idempotency-key": key } : {}),
        },
        ...(body === undefined ? {} : { payload: body }),
      });
      return {
        status: result.statusCode,
        data: result.body ? JSON.parse(result.body) : null,
      };
    }
    for (let i = 0; i < 3; i++)
      assert.equal(
        (
          await send(
            "/payments",
            "POST",
            { amount: 1, currency: "USD" },
            "create",
          )
        ).status,
        429,
      );
    const generated = await send(
      "/payments",
      "POST",
      { amount: 1, currency: "USD" },
      "create",
    );
    assert.equal(generated.status, 201);
    assert.equal(generated.data.created_at, configuration.clock);
    assert.equal(generated.data.status, "processing");
    const duplicates = await Promise.all(
      Array.from({ length: 4 }, () =>
        send("/payments", "POST", { currency: "USD", amount: 1 }, "create"),
      ),
    );
    assert.ok(
      duplicates.every(
        (d) =>
          d.status === 201 &&
          JSON.stringify(d.data) === JSON.stringify(generated.data),
      ),
    );
    assert.equal((await send("/payments")).data.length, 1);
    assert.equal(
      (
        await send(
          "/payments",
          "POST",
          { amount: 2, currency: "USD" },
          "create",
        )
      ).status,
      409,
    );
    assert.equal(
      (await send("/payments/pay_000001/capture", "POST", {}, "capture"))
        .status,
      503,
    );
    assert.equal((await send("/payments/pay_000001")).data.status, "succeeded");
    assert.equal(
      (await send("/payments/pay_000001/capture", "POST", {}, "capture"))
        .status,
      503,
    );
    assert.equal(
      (await send("/payments/pay_000001/capture", "POST", {})).status,
      409,
    );
    await request(
      `/api/sandboxes/${id}/sessions/${sessionId}/clock`,
      "POST",
      { advanceMs: 1000 },
      auth,
    );
    const later = await send("/payments", "POST", {
      amount: 2,
      currency: "USD",
    });
    assert.equal(later.data.created_at, "2026-06-01T12:00:01.000Z");
    assert.equal(
      (
        await request(
          `/api/sandboxes/${id}/sessions/${sessionId}/clock`,
          "POST",
          { advanceMs: -1 },
          auth,
        )
      ).status,
      400,
    );
    await request(
      `/api/sandboxes/${id}/sessions/${sessionId}/reset`,
      "POST",
      {},
      auth,
    );
    for (let i = 0; i < 3; i++)
      assert.equal(
        (
          await send(
            "/payments",
            "POST",
            { amount: 1, currency: "USD" },
            "create",
          )
        ).status,
        429,
      );
    assert.deepEqual(
      (
        await send(
          "/payments",
          "POST",
          { amount: 1, currency: "USD" },
          "create",
        )
      ).data,
      generated.data,
    );
    const conflict = await request(
      `/api/sandboxes/${id}/versions`,
      "POST",
      {
        ...configuration,
        name: "Conflict policy",
        idempotency: "conflict",
        rules: [],
      },
      auth,
    );
    await request(
      `/api/sandboxes/${id}/versions/${conflict.data.id}/approve`,
      "POST",
      {},
      auth,
    );
    await request(
      `/api/sandboxes/${id}/sessions/${sessionId}/configure`,
      "POST",
      { versionId: conflict.data.id },
      auth,
    );
    assert.equal(
      (await send("/payments", "POST", { amount: 1, currency: "USD" }, "same"))
        .status,
      201,
    );
    assert.equal(
      (await send("/payments", "POST", { amount: 1, currency: "USD" }, "same"))
        .status,
      409,
    );
    const trace = await request(
      `/api/sandboxes/${id}/sessions/${sessionId}/logs`,
      "GET",
      undefined,
      auth,
    );
    assert.equal(trace.data[0].version_id, conflict.data.id);
    assert.ok(trace.data[0].simulated_at);
    const endpoint = await request(
      `/api/sandboxes/${id}/webhooks`,
      "POST",
      { url: "https://hooks.example.test/events", description: "CI receiver" },
      auth,
    );
    assert.equal(endpoint.status, 201);
    assert.match(endpoint.data.signingSecret, /^whsec_/);
    assert.equal(
      (await request(`/api/sandboxes/${id}/webhooks`, "GET", undefined, other))
        .status,
      404,
    );
    const listedEndpoints = await request(
      `/api/sandboxes/${id}/webhooks`,
      "GET",
      undefined,
      auth,
    );
    assert.equal(listedEndpoints.data.length, 1);
    assert.equal(listedEndpoints.data[0].signingSecret, undefined);
    const webhookDefinition = {
      version: 1,
      name: "Capture webhook",
      seed: "webhook-test",
      clock: "2026-07-01T00:00:00.000Z",
      idempotency: "replay",
      rules: [
        {
          operation: "POST /payments/{id}/capture",
          action: {
            type: "transition",
            field: "status",
            from: ["processing"],
            to: "succeeded",
            emit: "payment.succeeded",
            deliverAfterMs: 5000,
          },
        },
      ],
    };
    const webhookVersion = await request(
      `/api/sandboxes/${id}/versions`,
      "POST",
      webhookDefinition,
      auth,
    );
    assert.equal(webhookVersion.status, 201);
    await request(
      `/api/sandboxes/${id}/versions/${webhookVersion.data.id}/approve`,
      "POST",
      {},
      auth,
    );
    await request(
      `/api/sandboxes/${id}/sessions/${sessionId}/configure`,
      "POST",
      { versionId: webhookVersion.data.id },
      auth,
    );
    const webhookPayment = await send("/payments", "POST", {
      amount: 9,
      currency: "USD",
    });
    assert.equal(webhookPayment.status, 201);
    assert.equal(
      (await send(`/payments/${webhookPayment.data.id}/capture`, "POST", {}))
        .status,
      200,
    );
    assert.equal(await fanoutOne(pool), false);
    await pool.query("UPDATE webhook_events SET available_at=now()");
    assert.equal(await fanoutOne(pool), true);
    assert.equal(await fanoutOne(pool), false);
    assert.equal(
      Number(
        (await pool.query("SELECT count(*) FROM webhook_deliveries")).rows[0]
          .count,
      ),
      1,
    );
    const sent: { headers: Record<string, string>; body: string }[] = [];
    const attemptAt = new Date(Date.now() + 1000);
    let response = 500;
    const sender = async (
      _url: URL,
      _address: { address: string; family: number },
      body: string,
      headers: Record<string, string>,
    ) => {
      sent.push({ headers, body });
      return { status: response, body: response === 500 ? "retry" : "ok" };
    };
    assert.equal(
      await deliverOne(pool, {
        encryptionKey,
        resolver: publicResolver,
        sender,
        now: () => attemptAt,
      }),
      true,
    );
    let delivery = (await pool.query("SELECT * FROM webhook_deliveries"))
      .rows[0];
    assert.equal(delivery.status, "pending");
    assert.equal(delivery.attempts, 1);
    assert.match(sent[0].headers["x-spectwin-signature"], /^v1=[a-f0-9]{64}$/);
    assert.equal(
      sent[0].headers["x-spectwin-timestamp"],
      attemptAt.toISOString(),
    );
    assert.equal(
      sent[0].headers["x-spectwin-signature"],
      `v1=${signWebhook(endpoint.data.signingSecret, attemptAt.toISOString(), sent[0].body)}`,
    );
    assert.equal(JSON.parse(sent[0].body).type, "payment.succeeded");
    await pool.query(
      "UPDATE webhook_deliveries SET next_attempt_at=now()-interval '1 second'",
    );
    response = 200;
    await deliverOne(pool, {
      encryptionKey,
      resolver: publicResolver,
      sender,
    });
    delivery = (await pool.query("SELECT * FROM webhook_deliveries")).rows[0];
    assert.equal(delivery.status, "delivered");
    assert.equal(delivery.attempts, 2);
    await request(
      `/api/sandboxes/${id}/webhook-deliveries/${delivery.id}/replay`,
      "POST",
      {},
      auth,
    );
    await pool.query(
      "UPDATE webhook_deliveries SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
      [delivery.id],
    );
    await deliverOne(pool, {
      encryptionKey,
      resolver: publicResolver,
      sender,
    });
    assert.equal(
      (
        await pool.query(
          "SELECT attempts FROM webhook_deliveries WHERE id=$1",
          [delivery.id],
        )
      ).rows[0].attempts,
      1,
    );
    await pool.query(
      "UPDATE webhook_deliveries SET status='delivering',locked_until=now()-interval '1 second',worker_token=gen_random_uuid(),next_attempt_at=now()-interval '1 second' WHERE id=$1",
      [delivery.id],
    );
    assert.equal(
      await deliverOne(pool, {
        encryptionKey,
        resolver: publicResolver,
        sender,
      }),
      true,
    );
    assert.equal(
      (
        await pool.query("SELECT status FROM webhook_deliveries WHERE id=$1", [
          delivery.id,
        ])
      ).rows[0].status,
      "delivered",
    );
    await pool.query(
      "UPDATE webhook_deliveries SET status='delivering',locked_until=now()+interval '1 minute',worker_token=gen_random_uuid() WHERE id=$1",
      [delivery.id],
    );
    const replayInProgress = await request(
      `/api/sandboxes/${id}/webhook-deliveries/${delivery.id}/replay`,
      "POST",
      {},
      auth,
    );
    assert.equal(replayInProgress.status, 409);
    assert.equal(
      replayInProgress.data.error,
      "Delivery is currently in progress.",
    );
    await pool.query(
      "UPDATE webhook_deliveries SET status='delivered',locked_until=NULL,worker_token=NULL WHERE id=$1",
      [delivery.id],
    );
    assert.equal(
      (
        await request(
          `/api/sandboxes/${id}/webhook-deliveries/${delivery.id}/replay`,
          "POST",
          {},
          auth,
        )
      ).status,
      200,
    );
    response = 500;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await pool.query(
        "UPDATE webhook_deliveries SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
        [delivery.id],
      );
      assert.equal(
        await deliverOne(pool, {
          encryptionKey,
          resolver: publicResolver,
          sender,
        }),
        true,
      );
    }
    const exhausted = (
      await pool.query(
        "SELECT status,attempts FROM webhook_deliveries WHERE id=$1",
        [delivery.id],
      )
    ).rows[0];
    assert.equal(exhausted.status, "failed");
    assert.equal(exhausted.attempts, 5);
    for (const action of ["reset", "configure"]) {
      await pool.query(
        "UPDATE webhook_events SET fanout_at=NULL,available_at=now()-interval '1 second'",
      );
      await pool.query(
        "UPDATE webhook_deliveries SET status='pending',next_attempt_at=now()-interval '1 second'",
      );
      const cancelled = await request(
        `/api/sandboxes/${id}/sessions/${sessionId}/${action}`,
        "POST",
        action === "configure" ? { versionId: webhookVersion.data.id } : {},
        auth,
      );
      assert.equal(cancelled.status, 200);
      assert.equal(await fanoutOne(pool), false);
      assert.equal(
        await deliverOne(pool, {
          encryptionKey,
          resolver: publicResolver,
          sender,
        }),
        false,
      );
      const cancelledDelivery = (
        await pool.query("SELECT status,last_error FROM webhook_deliveries")
      ).rows[0];
      assert.equal(cancelledDelivery.status, "failed");
      assert.equal(
        cancelledDelivery.last_error,
        "Session reset or reconfigured",
      );
    }
    assert.equal(
      (
        await request(
          `/api/sandboxes/${id}/webhooks/${endpoint.data.id}/disable`,
          "POST",
          {},
          auth,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request(`/api/sandboxes/${id}/webhooks`, "GET", undefined, auth))
        .data[0].active,
      false,
    );
    const rotated = await request(`/api/sandboxes/${id}/key`, "POST", {}, auth);
    assert.equal(
      (await request(p + "/payments", "GET", undefined, "", apiKey)).status,
      401,
    );
    assert.equal(
      (
        await request(
          p + "/payments",
          "GET",
          undefined,
          "",
          rotated.data.apiKey,
        )
      ).status,
      200,
    );
    await pool.query("UPDATE organizations SET request_limit=0 WHERE id=$1", [
      first.data.organization_id,
    ]);
    const beforeDenials = (
      await pool.query(
        "SELECT (SELECT requests FROM monthly_usage WHERE organization_id=$1) AS usage,(SELECT count(*) FROM request_logs WHERE session_id=$2) AS logs",
        [first.data.organization_id, sessionId],
      )
    ).rows[0];
    const denials = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(p + "/payments", "GET", undefined, "", rotated.data.apiKey),
      ),
    );
    assert.ok(denials.every((result) => result.status === 429));
    assert.deepEqual(
      (
        await pool.query(
          "SELECT (SELECT requests FROM monthly_usage WHERE organization_id=$1) AS usage,(SELECT count(*) FROM request_logs WHERE session_id=$2) AS logs",
          [first.data.organization_id, sessionId],
        )
      ).rows[0],
      beforeDenials,
    );
    assert.equal(
      (
        await request(
          p + "/payments",
          "GET",
          undefined,
          "",
          rotated.data.apiKey,
        )
      ).status,
      429,
    );
    const workspaceAuth = `${auth}; st_workspace=${first.data.organization_id}`;
    const audit = await request(
      "/api/workspaces/audit",
      "GET",
      undefined,
      workspaceAuth,
    );
    assert.equal(audit.status, 200);
    assert.ok(
      audit.data.some((event: any) => event.action === "sandbox.key_rotated"),
    );
    const outsiderAudit = await request(
      "/api/workspaces/audit",
      "GET",
      undefined,
      other,
    );
    assert.equal(outsiderAudit.status, 200);
    assert.ok(
      outsiderAudit.data.every((event: any) => event.resource_id !== id),
    );
    assert.doesNotMatch(
      JSON.stringify(audit.data),
      new RegExp(rotated.data.apiKey),
    );
    assert.equal(
      (
        await request(
          "/api/workspaces/audit?before=invalid",
          "GET",
          undefined,
          workspaceAuth,
        )
      ).status,
      400,
    );
    const auditPage = await request(
      `/api/workspaces/audit?before=${audit.data[0].id}`,
      "GET",
      undefined,
      workspaceAuth,
    );
    assert.ok(
      auditPage.data.every(
        (event: any) => BigInt(event.id) < BigInt(audit.data[0].id),
      ),
    );
    const invitation = await request(
      "/api/workspaces/invitations",
      "POST",
      { email: second.data.email },
      workspaceAuth,
    );
    assert.equal(invitation.status, 200);
    assert.match(invitation.data.code, /^[a-f0-9]{64}$/);
    const pendingInvites = await request(
      "/api/workspaces/invitations",
      "GET",
      undefined,
      workspaceAuth,
    );
    assert.equal(pendingInvites.data.length, 1);
    assert.equal(pendingInvites.data[0].code, undefined);
    assert.equal(
      (
        await request(
          "/api/workspaces/invitations/accept",
          "POST",
          { code: invitation.data.code },
          auth,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          "/api/workspaces/invitations/accept",
          "POST",
          { code: invitation.data.code },
          other,
        )
      ).status,
      403,
    );
    await pool.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [
      second.data.id,
    ]);
    const acceptances = await Promise.all(
      Array.from({ length: 2 }, () =>
        request(
          "/api/workspaces/invitations/accept",
          "POST",
          { code: invitation.data.code },
          other,
        ),
      ),
    );
    assert.deepEqual(acceptances.map((r) => r.status).sort(), [200, 404]);
    const revocable = await request(
      "/api/workspaces/invitations",
      "POST",
      { email: "future@example.com" },
      workspaceAuth,
    );
    assert.equal(
      (
        await request(
          `/api/workspaces/invitations/${revocable.data.id}/revoke`,
          "POST",
          {},
          workspaceAuth,
        )
      ).status,
      200,
    );
    await pool.query(
      "DELETE FROM memberships WHERE user_id=$1 AND organization_id=$2",
      [second.data.id, first.data.organization_id],
    );
    const memberAuth = `${other}; st_workspace=${first.data.organization_id}`;
    const selfInvite = await request(
      "/api/workspaces/invitations",
      "POST",
      { email: first.data.email },
      workspaceAuth,
    );
    await pool.query(
      "UPDATE workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
      [selfInvite.data.id],
    );
    assert.equal(
      (
        await request(
          "/api/workspaces/invitations/accept",
          "POST",
          { code: selfInvite.data.code },
          auth,
        )
      ).status,
      404,
    );
    const replacement = await request(
      "/api/workspaces/invitations",
      "POST",
      { email: first.data.email },
      workspaceAuth,
    );
    assert.equal(
      (
        await request(
          "/api/workspaces/invitations/accept",
          "POST",
          { code: replacement.data.code },
          auth,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request("/api/me", "GET", undefined, workspaceAuth)).data.role,
      "owner",
    );
    assert.equal(
      (
        await request(
          `/api/workspaces/members/${first.data.id}/role`,
          "POST",
          { role: "member" },
          workspaceAuth,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          `/api/workspaces/members/${second.data.id}/remove`,
          "POST",
          {},
          workspaceAuth,
        )
      ).status,
      404,
    );
    await pool.query("INSERT INTO memberships VALUES($1,$2,'member')", [
      second.data.id,
      first.data.organization_id,
    ]);
    assert.equal(
      (
        await request(
          "/api/workspaces/members",
          "GET",
          undefined,
          workspaceAuth,
        )
      ).data.length,
      2,
    );
    assert.equal(
      (await request("/api/workspaces/members", "GET", undefined, memberAuth))
        .status,
      403,
    );
    assert.equal(
      (await request("/api/workspaces/audit", "GET", undefined, memberAuth))
        .status,
      403,
    );
    assert.equal(
      (
        await request(
          `/api/workspaces/members/${first.data.id}/remove`,
          "POST",
          {},
          memberAuth,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          `/api/workspaces/members/${second.data.id}/role`,
          "POST",
          { role: "admin" },
          workspaceAuth,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          `/api/workspaces/members/${second.data.id}/role`,
          "POST",
          { role: "owner" },
          workspaceAuth,
        )
      ).status,
      200,
    );
    const demotions = await Promise.all([
      request(
        `/api/workspaces/members/${first.data.id}/role`,
        "POST",
        { role: "member" },
        workspaceAuth,
      ),
      request(
        `/api/workspaces/members/${second.data.id}/role`,
        "POST",
        { role: "member" },
        memberAuth,
      ),
    ]);
    assert.deepEqual(demotions.map((r) => r.status).sort(), [200, 409]);
    const ownerCount = await pool.query(
      "SELECT count(*) FROM memberships WHERE organization_id=$1 AND role='owner'",
      [first.data.organization_id],
    );
    assert.equal(ownerCount.rows[0].count, "1");
    const remainingOwnerAuth =
      demotions[0].status === 200 ? memberAuth : workspaceAuth;
    assert.equal(
      (
        await request(
          `/api/workspaces/members/${first.data.id}/role`,
          "POST",
          { role: "owner" },
          remainingOwnerAuth,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          `/api/workspaces/members/${second.data.id}/remove`,
          "POST",
          {},
          workspaceAuth,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request("/api/me", "GET", undefined, memberAuth)).status,
      401,
    );
    const device = await request("/api/auth/login", "POST", {
      email: "one@example.com",
      password: "long-test-password",
    });
    assert.equal(device.status, 200);
    assert.equal(
      (await request("/api/auth/logout-others", "POST", {}, auth)).status,
      200,
    );
    assert.equal(
      (await request("/api/me", "GET", undefined, device.cookie)).status,
      401,
    );
    assert.equal(
      (await request("/api/me", "GET", undefined, other)).status,
      200,
    );
    const wrongPassword = await request(
      "/api/auth/password",
      "POST",
      { currentPassword: "incorrect", newPassword: "new-long-test-password" },
      auth,
    );
    assert.equal(wrongPassword.status, 401);
    assert.equal(
      (await request("/api/me", "GET", undefined, auth)).status,
      200,
    );
    const competingChanges = await Promise.all(
      Array.from({ length: 2 }, () =>
        request(
          "/api/auth/password",
          "POST",
          {
            currentPassword: "long-test-password",
            newPassword: "new-long-test-password",
          },
          auth,
        ),
      ),
    );
    assert.deepEqual(competingChanges.map((r) => r.status).sort(), [200, 401]);
    const change = competingChanges.find((r) => r.status === 200)!;
    assert.equal(change.status, 200);
    assert.ok(change.cookie.startsWith("st_session="));
    assert.notEqual(change.cookie, auth);
    assert.equal(
      (await request("/api/me", "GET", undefined, auth)).status,
      401,
    );
    assert.equal(
      (
        await request("/api/auth/login", "POST", {
          email: "one@example.com",
          password: "long-test-password",
        })
      ).status,
      401,
    );
    assert.equal(
      (await request("/api/me", "GET", undefined, change.cookie)).status,
      200,
    );
    const freshLogin = await request("/api/auth/login", "POST", {
      email: "one@example.com",
      password: "new-long-test-password",
    });
    assert.equal(freshLogin.status, 200);
    assert.equal(
      (await request("/api/auth/logout-all", "POST", {}, change.cookie)).status,
      200,
    );
    assert.equal(
      (await request("/api/me", "GET", undefined, freshLogin.cookie)).status,
      401,
    );
    assert.equal(
      (await request("/api/me", "GET", undefined, change.cookie)).status,
      401,
    );
    assert.equal(
      (await request("/api/me", "GET", undefined, other)).status,
      200,
    );
    await request("/api/auth/logout", "POST", {}, auth);
    assert.equal(
      (await request("/api/me", "GET", undefined, auth)).status,
      401,
    );
  },
);
