import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/main.js";
import { digest } from "../apps/api/src/auth.js";

test(
  "platform keys remain read-only, scoped, revocable and creator-bound",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `platform_keys_${process.pid}_${Date.now()}`;
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    for (const name of (await readdir("migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(`migrations/${name}`, "utf8"));
    const app = await createApp(pool);
    t.after(async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const f = app.getHttpAdapter().getInstance();
    async function request(
      path: string,
      method: any = "GET",
      body?: any,
      cookie = "",
      key = "",
    ) {
      const response = await f.inject({
        url: path,
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        ...(body === undefined ? {} : { payload: body }),
      });
      return {
        status: response.statusCode,
        data: JSON.parse(response.body),
        cookie: String(response.headers["set-cookie"] || "").split(";")[0],
      };
    }
    const owner = await request("/api/auth/register", "POST", {
      email: "key-owner@example.com",
      password: "long-test-password",
    });
    const outsider = await request("/api/auth/register", "POST", {
      email: "key-outsider@example.com",
      password: "long-test-password",
    });
    const created = await request(
      "/api/platform-keys",
      "POST",
      { name: "CI reader", expiresInDays: 7 },
      owner.cookie,
    );
    assert.equal(created.status, 201);
    assert.match(created.data.token, /^stp_[a-f0-9]{64}$/);
    const secret = created.data.token;
    assert.equal(
      (
        await pool.query(
          "SELECT token_hash FROM platform_api_keys WHERE id=$1",
          [created.data.id],
        )
      ).rows[0].token_hash,
      digest(secret),
    );
    const keys = await request(
      "/api/platform-keys",
      "GET",
      undefined,
      owner.cookie,
    );
    assert.equal(keys.data.length, 1);
    assert.equal(keys.data[0].token, undefined);
    assert.equal(keys.data[0].token_hash, undefined);
    assert.equal(
      (await request("/api/platform-keys", "GET", undefined, outsider.cookie))
        .data.length,
      0,
    );
    assert.equal(
      (
        await request(
          `/api/platform-keys/${created.data.id}/revoke`,
          "POST",
          {},
          outsider.cookie,
        )
      ).status,
      404,
    );
    assert.equal(
      (await request("/api/sandboxes", "GET", undefined, "", secret)).status,
      200,
    );
    const spoofedWorkspace = `st_workspace=${outsider.data.organization_id}`;
    assert.equal(
      (await request("/api/me", "GET", undefined, spoofedWorkspace, secret))
        .data.organization_id,
      owner.data.organization_id,
    );
    for (const [path, method] of [
      ["/api/platform-keys", "GET"],
      ["/api/workspaces", "GET"],
      ["/api/auth/logout-all", "POST"],
      ["/api/sandboxes", "POST"],
    ])
      assert.equal(
        (
          await request(
            path,
            method,
            method === "POST" ? {} : undefined,
            owner.cookie,
            secret,
          )
        ).status,
        403,
      );
    assert.equal(
      (await request("/api/sandboxes", "GET", undefined, "", "stp_invalid"))
        .status,
      401,
    );
    const spec = await readFile("apps/web/public/payments.json", "utf8");
    const box = await request(
      "/api/sandboxes",
      "POST",
      { source: spec },
      outsider.cookie,
    );
    assert.equal(
      (
        await request(
          `/api/sandboxes/${box.data.id}/sessions`,
          "GET",
          undefined,
          "",
          secret,
        )
      ).status,
      404,
    );
    await pool.query("UPDATE memberships SET role='member' WHERE user_id=$1", [
      owner.data.id,
    ]);
    assert.equal(
      (await request("/api/sandboxes", "GET", undefined, "", secret)).status,
      401,
    );
    assert.equal(
      (
        await request(
          "/api/platform-keys",
          "POST",
          { name: "Forbidden" },
          owner.cookie,
        )
      ).status,
      403,
    );
    await pool.query("DELETE FROM memberships WHERE user_id=$1", [
      owner.data.id,
    ]);
    assert.equal(
      (await request("/api/sandboxes", "GET", undefined, "", secret)).status,
      401,
    );
    await pool.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
      owner.data.id,
      owner.data.organization_id,
    ]);
    await pool.query(
      "UPDATE platform_api_keys SET expires_at=now()-interval '1 second' WHERE id=$1",
      [created.data.id],
    );
    assert.equal(
      (await request("/api/sandboxes", "GET", undefined, "", secret)).status,
      401,
    );
    await pool.query(
      "UPDATE platform_api_keys SET expires_at=now()+interval '7 days' WHERE id=$1",
      [created.data.id],
    );
    assert.equal(
      (
        await request(
          `/api/platform-keys/${created.data.id}/revoke`,
          "POST",
          {},
          owner.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request("/api/sandboxes", "GET", undefined, "", secret)).status,
      401,
    );
    for (let index = 0; index < 19; index++)
      await pool.query(
        "INSERT INTO platform_api_keys(id,organization_id,created_by,name,token_hash,expires_at) VALUES($1,$2,$3,'fixture',$4,now()+interval '7 days')",
        [
          randomUUID(),
          owner.data.organization_id,
          owner.data.id,
          digest(`fixture-${index}`),
        ],
      );
    const race = await Promise.all([
      request(
        "/api/platform-keys",
        "POST",
        { name: "Final one" },
        owner.cookie,
      ),
      request(
        "/api/platform-keys",
        "POST",
        { name: "Final two" },
        owner.cookie,
      ),
    ]);
    assert.deepEqual(race.map((result) => result.status).sort(), [201, 429]);
    assert.equal(
      (
        await request(
          "/api/platform-keys",
          "POST",
          { name: "x", expiresInDays: 366 },
          owner.cookie,
        )
      ).status,
      400,
    );
  },
);
