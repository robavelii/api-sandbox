import { Pool } from "pg";
import { workOnce } from "./worker.js";
import { retainOnce } from "./retention.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
if (!process.env.WEBHOOK_ENCRYPTION_KEY)
  throw new Error("WEBHOOK_ENCRYPTION_KEY is required.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
let stopping = false;
let nextRetentionAt = 0;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
  });
while (!stopping) {
  try {
    if (Date.now() >= nextRetentionAt) {
      nextRetentionAt = Date.now() + 60_000;
      try {
        await retainOnce(pool);
      } catch {
        // Housekeeping failure must not starve webhook deliveries.
        console.error("Retention pass failed; retrying in one minute.");
      }
    }
    const worked = await workOnce(pool);
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (error) {
    console.error(
      "Webhook worker iteration failed:",
      error instanceof Error ? error.message : "Unknown error.",
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
await pool.end();
