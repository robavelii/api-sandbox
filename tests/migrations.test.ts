import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { applyMigrations } from "../scripts/migrate.js";

test(
  "migrations preserve populated state, serialize concurrent runs, rerun safely, and roll back as a unit",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await db.query(
        await (
          await import("node:fs/promises")
        ).readFile("migrations/001_foundation.sql", "utf8"),
      );
      await db.query(
        "CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now()); INSERT INTO schema_migrations(name) VALUES('001_foundation.sql')",
      );
      const user = "00000000-0000-4000-8000-000000000001";
      const organization = "00000000-0000-4000-8000-000000000002";
      const sandbox = "00000000-0000-4000-8000-000000000003";
      const session = "00000000-0000-4000-8000-000000000004";
      await db.query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'migration@example.com','hash')",
        [user],
      );
      await db.query(
        "INSERT INTO organizations(id,name) VALUES($1,'Migration')",
        [organization],
      );
      await db.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
        user,
        organization,
      ]);
      await db.query(
        "INSERT INTO sandboxes(id,organization_id,name,contract,approved,api_key_hash) VALUES($1,$2,'Existing','{}',true,'hash')",
        [sandbox, organization],
      );
      await db.query(
        "INSERT INTO simulation_sessions(id,sandbox_id,name) VALUES($1,$2,'default')",
        [session, sandbox],
      );
      await db.query(
        "INSERT INTO resources VALUES($1,'payments','pay_1','{\"id\":\"pay_1\"}')",
        [session],
      );

      await Promise.all([applyMigrations(db), applyMigrations(db)]);
      assert.equal(
        Number(
          (await db.query("SELECT count(*) FROM schema_migrations")).rows[0]
            .count,
        ),
        2,
      );
      assert.equal(
        (
          await db.query(
            "SELECT version_id FROM simulation_sessions WHERE id=$1",
            [session],
          )
        ).rows[0].version_id,
        sandbox,
      );
      assert.equal(
        (
          await db.query(
            "SELECT approved_at IS NOT NULL AS approved FROM sandbox_versions WHERE id=$1",
            [sandbox],
          )
        ).rows[0].approved,
        true,
      );
      assert.equal(
        (
          await db.query("SELECT data FROM resources WHERE session_id=$1", [
            session,
          ])
        ).rows[0].data.id,
        "pay_1",
      );
      await applyMigrations(db);
      assert.equal(
        Number(
          (await db.query("SELECT count(*) FROM schema_migrations")).rows[0]
            .count,
        ),
        2,
      );

      await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      const directory = await mkdtemp(join(tmpdir(), "spectwin-migrations-"));
      try {
        await writeFile(
          join(directory, "001_probe.sql"),
          "CREATE TABLE rollback_probe(id integer);",
        );
        await writeFile(join(directory, "002_invalid.sql"), "THIS IS NOT SQL;");
        await assert.rejects(() => applyMigrations(db, directory));
        assert.equal(
          (
            await db.query(
              "SELECT to_regclass('public.rollback_probe') AS name",
            )
          ).rows[0].name,
          null,
        );
        assert.equal(
          (
            await db.query(
              "SELECT to_regclass('public.schema_migrations') AS name",
            )
          ).rows[0].name,
          null,
        );
      } finally {
        await rm(directory, { recursive: true });
      }
    } finally {
      await db.end();
    }
  },
);
