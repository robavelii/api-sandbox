import type { Pool } from "pg";

const rules = [
  ["password_recoveries", "expires_at<now()-interval '1 day'"],
  ["recovery_requests", "requested_at<now()-interval '1 day'"],
  ["request_logs", "created_at<now()-interval '30 days'"],
  ["auth_sessions", "expires_at<now()"],
  ["auth_attempts", "window_start<now()-interval '1 day'"],
  ["email_verifications", "expires_at<now()-interval '1 day'"],
  ["workspace_invitations", "expires_at<now()-interval '1 day'"],
  ["audit_events", "created_at<now()-interval '90 days'"],
  [
    "webhook_deliveries",
    "status IN ('delivered','failed') AND updated_at<now()-interval '30 days'",
  ],
  [
    "webhook_events",
    "created_at<now()-interval '30 days' AND fanout_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.event_id=webhook_events.id)",
  ],
] as const;

/** Fixed policies; no user-provided table names or SQL. Each pass is bounded. */
export async function retainOnce(pool: Pool, batchSize = 500) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("Retention batch size must be between 1 and 1000.");
  const client = await pool.connect();
  const deleted: Record<string, number> = {};
  try {
    await client.query("BEGIN");
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(58312477) AS acquired",
    );
    if (!lock.rows[0].acquired) {
      await client.query("COMMIT");
      return deleted;
    }
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    for (const [table, condition] of rules) {
      // Recovery ships independently; do not fail older migration states.
      const exists = await client.query("SELECT to_regclass($1) AS name", [
        table,
      ]);
      if (!exists.rows[0].name) continue;
      const result = await client.query(
        `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${condition} LIMIT $1 FOR UPDATE SKIP LOCKED)`,
        [batchSize],
      );
      deleted[table] = result.rowCount || 0;
    }
    await client.query("COMMIT");
    return deleted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
