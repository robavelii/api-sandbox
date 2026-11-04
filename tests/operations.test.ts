import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { retainOnce } from "../apps/worker/src/retention.js";

test(
  "audit records commit atomically without secrets and retention preserves active work in bounded batches",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `operations_${process.pid}_${Date.now()}`;
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    for (const file of (await readdir("migrations"))
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await pool.query(await readFile(`migrations/${file}`, "utf8"));
    const uid = randomUUID(),
      oid = randomUUID(),
      box = randomUUID(),
      session = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,'audit@example.com','private-password-hash')",
      [uid],
    );
    await pool.query(
      "INSERT INTO organizations(id,name) VALUES($1,'Audited')",
      [oid],
    );
    await pool.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
      uid,
      oid,
    ]);
    await pool.query(
      "INSERT INTO sandboxes(id,organization_id,name,contract,api_key_hash) VALUES($1,$2,'Audited','{}','old-secret')",
      [box, oid],
    );
    await pool.query(
      "INSERT INTO sandbox_versions(id,sandbox_id,number,definition) VALUES($1,$1,1,'{}')",
      [box],
    );
    await pool.query(
      "INSERT INTO simulation_sessions(id,sandbox_id,name,version_id) VALUES($1,$2,'default',$2)",
      [session, box],
    );
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "UPDATE sandboxes SET api_key_hash='rolled-back-secret' WHERE id=$1",
        [box],
      );
      await connection.query("ROLLBACK");
    } finally {
      connection.release();
    }
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM audit_events WHERE action='sandbox.key_rotated'",
        )
      ).rows[0].count,
      "0",
    );
    await pool.query(
      "UPDATE sandboxes SET api_key_hash='new-private-secret',approved=true WHERE id=$1",
      [box],
    );
    await pool.query(
      "UPDATE sandbox_versions SET approved_at=now() WHERE id=$1",
      [box],
    );
    await pool.query(
      "UPDATE simulation_sessions SET generation=generation+1 WHERE id=$1",
      [session],
    );
    const events = (await pool.query("SELECT * FROM audit_events ORDER BY id"))
      .rows;
    assert.deepEqual(
      events.map((x) => x.action),
      [
        "membership.insert",
        "scenario.version_created",
        "sandbox.key_rotated",
        "sandbox.approval_changed",
        "scenario.version_approved",
        "session.reset",
      ],
    );
    assert.ok(events.every((x) => x.organization_id === oid));
    assert.doesNotMatch(JSON.stringify(events), /private|secret|password/);
    await pool.query(
      "INSERT INTO request_logs(session_id,method,path,status,detail,created_at) SELECT $1,'GET','/test',200,'ok',now()-interval '31 days' FROM generate_series(1,3)",
      [session],
    );
    await pool.query(
      "INSERT INTO request_logs(session_id,method,path,status,detail) VALUES($1,'GET','/current',200,'keep')",
      [session],
    );
    await pool.query(
      "INSERT INTO auth_sessions VALUES('expired',$1,now()-interval '1 day'),('active',$1,now()+interval '1 day')",
      [uid],
    );
    await pool.query(
      "INSERT INTO audit_events(organization_id,action,resource_id,created_at) VALUES($1,'old.event',$2,now()-interval '91 days')",
      [oid, uid],
    );
    const endpoint = randomUUID(),
      oldEvent = randomUUID(),
      pendingEvent = randomUUID();
    await pool.query(
      "INSERT INTO webhook_endpoints(id,sandbox_id,url,secret_ciphertext) VALUES($1,$2,'https://example.com','secret-not-audited')",
      [endpoint, box],
    );
    for (const id of [oldEvent, pendingEvent])
      await pool.query(
        "INSERT INTO webhook_events(id,sandbox_id,session_id,type,payload,created_at) VALUES($1,$2,$3,'test','{}',now()-interval '31 days')",
        [id, box, session],
      );
    await pool.query("UPDATE webhook_events SET fanout_at=now() WHERE id=$1", [
      oldEvent,
    ]);
    await pool.query(
      "INSERT INTO webhook_deliveries(id,event_id,endpoint_id,status,updated_at) VALUES($1,$2,$3,'failed',now()-interval '31 days'),($4,$5,$3,'pending',now()-interval '31 days')",
      [randomUUID(), oldEvent, endpoint, randomUUID(), pendingEvent],
    );
    await assert.rejects(() => retainOnce(pool, 0), /batch size/);
    const first = await retainOnce(pool, 2);
    assert.equal(first.request_logs, 2);
    assert.equal(first.auth_sessions, 1);
    assert.equal(first.audit_events, 1);
    assert.equal(first.webhook_deliveries, 1);
    assert.equal(first.webhook_events, 1);
    assert.equal(
      (
        await pool.query("SELECT count(*) FROM webhook_events WHERE id=$1", [
          pendingEvent,
        ])
      ).rows[0].count,
      "1",
    );
    assert.equal(
      (await pool.query("SELECT token_hash FROM auth_sessions")).rows[0]
        .token_hash,
      "active",
    );
    const second = await retainOnce(pool, 2);
    assert.equal(second.request_logs, 1);
    assert.equal(
      (await pool.query("SELECT path FROM request_logs")).rows[0].path,
      "/current",
    );
    assert.equal((await retainOnce(pool, 2)).request_logs, 0);
    // Recovery migrations can land independently of the operations migration.
    await pool.query(
      "CREATE TABLE IF NOT EXISTS password_recoveries(user_id uuid PRIMARY KEY,token_hash text UNIQUE NOT NULL,expires_at timestamptz NOT NULL)",
    );
    await pool.query(
      "CREATE TABLE IF NOT EXISTS recovery_requests(email_hash text PRIMARY KEY,requested_at timestamptz NOT NULL DEFAULT now())",
    );
    await pool.query(
      "INSERT INTO password_recoveries VALUES($1,'expired-recovery',now()-interval '2 days')",
      [uid],
    );
    await pool.query(
      "INSERT INTO recovery_requests VALUES('expired-request',now()-interval '2 days'),('current-request',now())",
    );
    const recoveryRetention = await retainOnce(pool, 2);
    assert.equal(recoveryRetention.password_recoveries, 1);
    assert.equal(recoveryRetention.recovery_requests, 1);
    assert.equal(
      (await pool.query("SELECT email_hash FROM recovery_requests")).rows[0]
        .email_hash,
      "current-request",
    );
    const lease = await pool.connect();
    try {
      await lease.query("BEGIN");
      await lease.query("SELECT pg_advisory_xact_lock(58312477)");
      assert.deepEqual(await retainOnce(pool, 2), {});
      await lease.query("ROLLBACK");
    } finally {
      lease.release();
    }
  },
);
