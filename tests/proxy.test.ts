import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { createApp, trustedProxyList } from "../apps/api/src/main.js";

test("trusted proxy configuration accepts only explicit addresses", () => {
  assert.deepEqual(trustedProxyList(), []);
  assert.deepEqual(trustedProxyList(" 127.0.0.1, 172.30.40.0/24 ,::1 "), [
    "127.0.0.1",
    "172.30.40.0/24",
    "::1",
  ]);
  for (const value of [
    "true",
    "*",
    "loopback",
    "0.0.0.0/33",
    "::1/129",
    "10.0.0.0/8/1",
    "10.0.0.0/x",
  ])
    assert.throws(() => trustedProxyList(value), /TRUSTED_PROXIES/);
  assert.throws(
    () => trustedProxyList(Array(17).fill("127.0.0.1").join(",")),
    /16 entries/,
  );
});

test(
  "auth attempt limits use the forwarded client address only behind a trusted proxy",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 20_000 },
  async (t) => {
    const schema = `proxy_test_${process.pid}_${Date.now()}`;
    assert.match(schema, /^proxy_test_[0-9_]+$/);
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(await readFile("migrations/001_foundation.sql", "utf8"));
    const app = await createApp(pool, { trustedProxies: ["127.0.0.1"] });
    t.after(async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const server = app.getHttpAdapter().getInstance();
    const login = async (remoteAddress: string, forwardedFor?: string) =>
      (
        await server.inject({
          url: "/api/auth/login",
          method: "POST",
          remoteAddress,
          headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
          payload: {},
        })
      ).statusCode;

    for (let i = 0; i < 30; i++)
      assert.equal(await login("127.0.0.1", "198.51.100.7"), 400);
    assert.equal(await login("127.0.0.1", "198.51.100.7"), 429);
    // Another client behind the same proxy keeps its own budget.
    assert.equal(await login("127.0.0.1", "198.51.100.8"), 400);
    // A client prepending a spoofed address is keyed on what the proxy saw.
    assert.equal(await login("127.0.0.1", "198.51.100.99, 198.51.100.7"), 429);
    // An untrusted direct peer cannot borrow another client's address.
    for (let i = 0; i < 30; i++)
      assert.equal(await login("203.0.113.9", "198.51.100.9"), 400);
    assert.equal(await login("203.0.113.9", "198.51.100.10"), 429);
  },
);
