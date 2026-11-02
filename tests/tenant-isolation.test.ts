import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/main.js";
import { digest, hashPassword } from "../apps/api/src/auth.js";

test(
  "sandbox control endpoints preserve tenant isolation and owner capabilities",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 20_000 },
  async (t) => {
    const schema = `tenant_test_${process.pid}_${Date.now()}`;
    assert.match(schema, /^tenant_test_[0-9_]+$/);
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(await readFile("migrations/001_foundation.sql", "utf8"));
    await pool.query(await readFile("migrations/002_scenarios.sql", "utf8"));
    const app = await createApp(pool);
    t.after(async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const server = app.getHttpAdapter().getInstance();
    async function request(
      path: string,
      method: any = "GET",
      data?: any,
      cookie = "",
    ) {
      const response = await server.inject({
        url: path,
        method,
        headers: cookie ? { cookie } : {},
        ...(data === undefined ? {} : { payload: data }),
      });
      return {
        status: response.statusCode,
        data: response.body ? JSON.parse(response.body) : null,
        cookie: String(response.headers["set-cookie"] || "").split(";")[0],
      };
    }

    const owner = await request("/api/auth/register", "POST", {
      email: "tenant-owner@example.com",
      password: "tenant-owner-password",
    });
    const outsider = await request("/api/auth/register", "POST", {
      email: "tenant-outsider@example.com",
      password: "tenant-outsider-password",
    });
    const spec = await readFile("apps/web/public/payments.json", "utf8");
    const sandbox = await request(
      "/api/sandboxes",
      "POST",
      { source: spec },
      owner.cookie,
    );
    assert.equal(sandbox.status, 201);
    const boxId = sandbox.data.id;
    const sessionId = sandbox.data.sessionId;
    await request(`/api/sandboxes/${boxId}/approve`, "POST", {}, owner.cookie);
    const version = await request(
      `/api/sandboxes/${boxId}/versions`,
      "POST",
      {
        version: 1,
        name: "Isolation fixture",
        seed: "tenant-test",
        clock: "2026-01-01T00:00:00.000Z",
        idempotency: "replay",
        rules: [],
      },
      owner.cookie,
    );
    assert.equal(version.status, 201);

    async function snapshot() {
      const box = (
        await pool.query(
          "SELECT approved,api_key_hash FROM sandboxes WHERE id=$1",
          [boxId],
        )
      ).rows[0];
      const session = (
        await pool.query(
          "SELECT scenario,counter,generation,version_id,clock FROM simulation_sessions WHERE id=$1",
          [sessionId],
        )
      ).rows[0];
      const counts = (
        await pool.query(
          "SELECT (SELECT count(*)::integer FROM simulation_sessions WHERE sandbox_id=$1) sessions,(SELECT count(*)::integer FROM sandbox_versions WHERE sandbox_id=$1) versions,(SELECT count(*)::integer FROM resources WHERE session_id=$2) resources,(SELECT count(*)::integer FROM request_logs WHERE session_id=$2) logs",
          [boxId, sessionId],
        )
      ).rows[0];
      return JSON.parse(JSON.stringify({ box, session, counts }));
    }

    const otherTenantCases = [
      ["approve contract", `/api/sandboxes/${boxId}/approve`, "POST", {}],
      ["rotate key", `/api/sandboxes/${boxId}/key`, "POST", {}],
      ["list sessions", `/api/sandboxes/${boxId}/sessions`, "GET", undefined],
      [
        "create session",
        `/api/sandboxes/${boxId}/sessions`,
        "POST",
        { name: "outside" },
      ],
      [
        "select preset",
        `/api/sandboxes/${boxId}/sessions/${sessionId}/scenario`,
        "POST",
        { scenario: "error" },
      ],
      [
        "reset",
        `/api/sandboxes/${boxId}/sessions/${sessionId}/reset`,
        "POST",
        {},
      ],
      [
        "read logs",
        `/api/sandboxes/${boxId}/sessions/${sessionId}/logs`,
        "GET",
        undefined,
      ],
      [
        "read resources",
        `/api/sandboxes/${boxId}/sessions/${sessionId}/resources`,
        "GET",
        undefined,
      ],
      ["list versions", `/api/sandboxes/${boxId}/versions`, "GET", undefined],
      [
        "create version",
        `/api/sandboxes/${boxId}/versions`,
        "POST",
        {
          version: 1,
          name: "Outside",
          seed: "x",
          clock: "2026-01-01T00:00:00.000Z",
          idempotency: "off",
          rules: [],
        },
      ],
      [
        "approve version",
        `/api/sandboxes/${boxId}/versions/${version.data.id}/approve`,
        "POST",
        {},
      ],
      [
        "configure",
        `/api/sandboxes/${boxId}/sessions/${sessionId}/configure`,
        "POST",
        { versionId: version.data.id },
      ],
      [
        "advance clock",
        `/api/sandboxes/${boxId}/sessions/${sessionId}/clock`,
        "POST",
        { advanceMs: 1000 },
      ],
    ] as const;
    for (const [name, path, method, body] of otherTenantCases) {
      const before = await snapshot();
      const response = await request(path, method, body, outsider.cookie);
      assert.equal(response.status, 404, name);
      assert.deepEqual(
        await snapshot(),
        before,
        `${name} changed tenant state`,
      );
    }

    const memberId = randomUUID();
    const memberSecret = "member-test-session";
    await pool.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
      [memberId, "member@example.com", await hashPassword("member-password")],
    );
    await pool.query("INSERT INTO memberships VALUES($1,$2,'member')", [
      memberId,
      owner.data.organization_id,
    ]);
    await pool.query(
      "INSERT INTO auth_sessions VALUES($1,$2,now()+interval '1 hour')",
      [digest(memberSecret), memberId],
    );
    const memberCookie = `st_session=${memberSecret}`;
    for (const [name, path, body] of [
      ["approve contract", `/api/sandboxes/${boxId}/approve`, {}],
      ["rotate key", `/api/sandboxes/${boxId}/key`, {}],
      [
        "generate AI draft",
        `/api/sandboxes/${boxId}/proposals`,
        { prompt: "test" },
      ],
      ["reset", `/api/sandboxes/${boxId}/sessions/${sessionId}/reset`, {}],
      [
        "approve version",
        `/api/sandboxes/${boxId}/versions/${version.data.id}/approve`,
        {},
      ],
      [
        "configure",
        `/api/sandboxes/${boxId}/sessions/${sessionId}/configure`,
        { versionId: boxId },
      ],
    ] as const) {
      const before = await snapshot();
      const response = await request(path, "POST", body, memberCookie);
      assert.equal(response.status, 403, name);
      assert.equal(response.data.error, "Workspace owner access required.");
      assert.deepEqual(await snapshot(), before, `${name} changed owner state`);
    }
    assert.equal(
      (
        await request(
          `/api/sandboxes/${boxId}/sessions`,
          "GET",
          undefined,
          memberCookie,
        )
      ).status,
      200,
    );

    const duplicate = await request(
      `/api/sandboxes/${boxId}/sessions`,
      "POST",
      { name: "default" },
      owner.cookie,
    );
    assert.equal(duplicate.status, 409);
    assert.deepEqual(duplicate.data, { error: "Session name already exists." });
    assert.doesNotMatch(
      JSON.stringify(duplicate.data),
      /constraint|simulation_sessions/i,
    );
  },
);
