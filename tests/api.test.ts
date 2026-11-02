import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { createApp } from "../apps/api/src/main.js";
import { hashPassword, verifyPassword } from "../apps/api/src/auth.js";
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
    const app = await createApp(pool);
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
    const spec = JSON.parse(
      await readFile("apps/web/public/payments.json", "utf8"),
    );
    const created = await request(
      "/api/sandboxes",
      "POST",
      { source: JSON.stringify(spec) },
      auth,
    );
    assert.equal(created.status, 201);
    const { id, apiKey, sessionId } = created.data;
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
    await request("/api/auth/logout", "POST", {}, auth);
    assert.equal(
      (await request("/api/me", "GET", undefined, auth)).status,
      401,
    );
  },
);
