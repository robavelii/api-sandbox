import { execFileSync } from "node:child_process";
import { Pool } from "pg";

export default async function globalSetup() {
  const connectionString =
    process.env.E2E_DATABASE_URL ??
    "postgresql://spectwin:local-test-only@127.0.0.1:55432/spectwin_e2e";
  const target = new URL(connectionString);
  const database = target.pathname.slice(1);
  if (!database.endsWith("_e2e")) {
    throw new Error(
      `Refusing to reset database ${database}; E2E database names must end in _e2e.`,
    );
  }

  const pool = new Pool({ connectionString });
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  } finally {
    await pool.end();
  }

  execFileSync("npm", ["run", "migrate"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: connectionString },
  });
}
