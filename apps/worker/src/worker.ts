import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  decryptSecret,
  signWebhook,
} from "../../../packages/engine/src/webhook-crypto.js";
import {
  safePost,
  type Resolver,
  type Sender,
  systemResolver,
  pinnedHttpsSender,
} from "./network.js";

export interface WorkerOptions {
  resolver?: Resolver;
  sender?: Sender;
  encryptionKey?: string;
  now?: () => Date;
}

export async function fanoutOne(pool: Pool): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const event = (
      await client.query(
        "SELECT * FROM webhook_events WHERE fanout_at IS NULL AND available_at<=now() ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!event) {
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      "INSERT INTO webhook_deliveries(id,event_id,endpoint_id) SELECT gen_random_uuid(),$1,id FROM webhook_endpoints WHERE sandbox_id=$2 AND active=true ON CONFLICT(event_id,endpoint_id) DO NOTHING",
      [event.id, event.sandbox_id],
    );
    await client.query(
      "UPDATE webhook_events SET fanout_at=now() WHERE id=$1",
      [event.id],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deliverOne(
  pool: Pool,
  options: WorkerOptions = {},
): Promise<boolean> {
  const token = randomUUID();
  const now = options.now?.() || new Date();
  const claimed = (
    await pool.query(
      "UPDATE webhook_deliveries SET status='delivering',worker_token=$1,locked_until=$2::timestamptz+interval '90 seconds',updated_at=now() WHERE id=(SELECT id FROM webhook_deliveries WHERE (status='pending' OR (status='delivering' AND locked_until<=$2)) AND next_attempt_at<=$2 ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",
      [token, now.toISOString()],
    )
  ).rows[0];
  if (!claimed) return false;
  const row = (
    await pool.query(
      "SELECT d.*,e.type,e.payload,e.created_at AS event_created_at,p.url,p.secret_ciphertext,p.active FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id JOIN webhook_endpoints p ON p.id=d.endpoint_id WHERE d.id=$1",
      [claimed.id],
    )
  ).rows[0];
  const attempts = row.attempts + 1;
  if (!row.active) {
    await finish(
      pool,
      row.id,
      token,
      attempts,
      false,
      0,
      "",
      "Endpoint disabled",
    );
    return true;
  }
  const body = JSON.stringify(row.payload);
  const timestamp = new Date(row.event_created_at).toISOString();
  try {
    const secret = decryptSecret(row.secret_ciphertext, options.encryptionKey);
    const result = await safePost(
      row.url,
      body,
      {
        "content-type": "application/json",
        "user-agent": "SpecTwin-Webhooks/1.0",
        "x-spectwin-event": row.type,
        "x-spectwin-timestamp": timestamp,
        "x-spectwin-signature": `v1=${signWebhook(secret, timestamp, body)}`,
      },
      options.resolver || systemResolver,
      options.sender || pinnedHttpsSender,
    );
    const success = result.status >= 200 && result.status < 300;
    await finish(
      pool,
      row.id,
      token,
      attempts,
      success,
      result.status,
      result.body.slice(0, 4096),
      success ? null : `HTTP ${result.status}`,
    );
  } catch (error: any) {
    await finish(
      pool,
      row.id,
      token,
      attempts,
      false,
      0,
      "",
      String(error?.message || "Webhook delivery failed.").slice(0, 1000),
    );
  }
  return true;
}

async function finish(
  pool: Pool,
  id: string,
  token: string,
  attempts: number,
  success: boolean,
  status: number,
  excerpt: string,
  error: string | null,
) {
  const terminal = attempts >= 5;
  const delaySeconds = Math.min(3600, 5 * 2 ** Math.max(0, attempts - 1));
  await pool.query(
    "UPDATE webhook_deliveries SET status=$1,attempts=$2,response_status=$3,response_excerpt=$4,last_error=$5,delivered_at=CASE WHEN $6 THEN now() ELSE delivered_at END,next_attempt_at=CASE WHEN $6 THEN next_attempt_at ELSE now()+($7*interval '1 second') END,locked_until=NULL,worker_token=NULL,updated_at=now() WHERE id=$8 AND worker_token=$9",
    [
      success ? "delivered" : terminal ? "failed" : "pending",
      attempts,
      status || null,
      excerpt.slice(0, 4096) || null,
      error,
      success,
      delaySeconds,
      id,
      token,
    ],
  );
}

export async function workOnce(pool: Pool, options: WorkerOptions = {}) {
  const fannedOut = await fanoutOne(pool);
  const delivered = await deliverOne(pool, options);
  return fannedOut || delivered;
}
