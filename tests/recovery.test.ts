import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { createApp } from "../apps/api/src/main.js";
import { recoveryMailer } from "../apps/api/src/recovery.js";

test("recovery transport uses fixed HTTPS and hides provider failures", async () => {
  assert.equal(recoveryMailer("", ""), undefined);
  let status = 200;
  const send = recoveryMailer("secret", "sender@example.com", (async (
    url,
    options,
  ) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options?.redirect, "error");
    assert.match(JSON.parse(options?.body as string).text, /30 minutes/);
    return new Response("private provider details", { status });
  }) as typeof fetch)!;
  await send("user@example.com", "code");
  status = 500;
  await assert.rejects(
    () => send("user@example.com", "code"),
    /^Error: Recovery mail delivery failed\.$/,
  );
});

test(
  "recovery is verified-only, single-use, expiring, bounded and revokes sessions atomically",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `recovery_${process.pid}_${Date.now()}`;
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
    let code = "",
      deliveries = 0,
      fail = false;
    const app = await createApp(pool, {
      sendRecovery: async (_email, value) => {
        deliveries++;
        code = value;
        if (fail) throw new Error("private");
      },
    });
    t.after(async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const server = app.getHttpAdapter().getInstance();
    const request = async (path: string, payload: any = {}, cookie = "") => {
      const response = await server.inject({
        url: path,
        method: "POST",
        payload,
        headers: { cookie },
      });
      return {
        status: response.statusCode,
        body: response.json(),
        cookie: String(response.headers["set-cookie"] || "").split(";")[0],
      };
    };
    const user = await request("/api/auth/register", {
      email: "recover@example.com",
      password: "original-password",
    });
    const other = await request("/api/auth/register", {
      email: "other@example.com",
      password: "other-long-password",
    });
    const unknown = await request("/api/auth/recovery/request", {
      email: "missing@example.com",
    });
    const unverified = await request("/api/auth/recovery/request", {
      email: "recover@example.com",
    });
    assert.deepEqual(unknown.body, unverified.body);
    assert.equal(deliveries, 0);
    await pool.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [
      user.body.id,
    ]);
    await pool.query("DELETE FROM recovery_requests");
    const sent = await request("/api/auth/recovery/request", {
      email: "recover@example.com",
    });
    assert.deepEqual(sent.body, unknown.body);
    assert.equal(deliveries, 1);
    assert.match(code, /^[a-f0-9]{64}$/);
    assert.notEqual(
      (await pool.query("SELECT token_hash FROM password_recoveries")).rows[0]
        .token_hash,
      code,
    );
    await request("/api/auth/recovery/request", {
      email: "recover@example.com",
    });
    assert.equal(deliveries, 1);
    const originalCode = code;
    await pool.query(
      "UPDATE recovery_requests SET requested_at=now()-interval '2 minutes'",
    );
    await request("/api/auth/recovery/request", {
      email: "recover@example.com",
    });
    assert.notEqual(code, originalCode);
    assert.equal(
      (
        await request("/api/auth/recovery/confirm", {
          code: originalCode,
          newPassword: "replacement-password",
        })
      ).status,
      400,
    );
    await pool.query(
      "UPDATE password_recoveries SET expires_at=now()-interval '1 second'",
    );
    assert.equal(
      (
        await request("/api/auth/recovery/confirm", {
          code,
          newPassword: "replacement-password",
        })
      ).status,
      400,
    );
    await pool.query(
      "UPDATE recovery_requests SET requested_at=now()-interval '2 minutes'",
    );
    fail = true;
    assert.deepEqual(
      (
        await request("/api/auth/recovery/request", {
          email: "recover@example.com",
        })
      ).body,
      unknown.body,
    );
    assert.equal(
      (await pool.query("SELECT count(*) FROM password_recoveries")).rows[0]
        .count,
      "0",
    );
    fail = false;
    await pool.query(
      "UPDATE recovery_requests SET requested_at=now()-interval '2 minutes'",
    );
    await request("/api/auth/recovery/request", {
      email: "recover@example.com",
    });
    const outcomes = await Promise.all(
      Array.from({ length: 2 }, () =>
        request("/api/auth/recovery/confirm", {
          code,
          newPassword: "replacement-password",
        }),
      ),
    );
    assert.deepEqual(
      outcomes.map((result) => result.status).sort(),
      [200, 400],
    );
    assert.equal(outcomes.find((result) => result.status === 200)!.cookie, "");
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM auth_sessions WHERE user_id=$1",
          [user.body.id],
        )
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM auth_sessions WHERE user_id=$1",
          [other.body.id],
        )
      ).rows[0].count,
      "1",
    );
    assert.equal(
      (
        await request("/api/auth/login", {
          email: "recover@example.com",
          password: "original-password",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request("/api/auth/login", {
          email: "recover@example.com",
          password: "replacement-password",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/auth/recovery/confirm", {
          code: "bad",
          newPassword: "short",
        })
      ).status,
      400,
    );
    const signedIn = await request("/api/auth/login", {
      email: "recover@example.com",
      password: "replacement-password",
    });
    await pool.query(
      "UPDATE recovery_requests SET requested_at=now()-interval '2 minutes'",
    );
    await request("/api/auth/recovery/request", {
      email: "recover@example.com",
    });
    assert.equal(
      (
        await request(
          "/api/auth/password",
          {
            currentPassword: "replacement-password",
            newPassword: "signed-in-password",
          },
          signedIn.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/auth/recovery/confirm", {
          code,
          newPassword: "must-not-be-applied",
        })
      ).status,
      400,
    );
  },
);
