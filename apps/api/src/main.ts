import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  parseContract,
  scenarios,
  type Contract,
} from "../../../packages/engine/src/index.js";
import {
  defaultDefinition,
  definition,
} from "../../../packages/engine/src/scenario.js";
import { execute } from "./runtime.js";
import {
  suggestedFailures,
  proposeScenario,
  type ProposalProvider,
} from "../../../packages/engine/src/proposals.js";
import { openAIProposalProvider } from "./proposal-provider.js";
import { hashPassword, verifyPassword, token, digest } from "./auth.js";
import { encryptSecret } from "../../../packages/engine/src/webhook-crypto.js";
import {
  systemResolver,
  validateWebhookUrl,
  type Resolver,
} from "../../worker/src/network.js";
@Module({})
class ApiModule {}
class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const required = (value: any, type = "string") => {
  if (typeof value !== type) throw new Problem(400, `Expected ${type}.`);
  return value;
};
export async function createApp(
  pool: Pool,
  options: {
    webhookResolver?: Resolver;
    webhookEncryptionKey?: string;
    proposalProvider?: ProposalProvider;
  } = {},
) {
  const proposalProvider = options.proposalProvider || openAIProposalProvider();
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule,
    new FastifyAdapter({ bodyLimit: 1_048_576, trustProxy: false }),
    { logger: false },
  );
  const f = app.getHttpAdapter().getInstance();
  const origin = process.env.WEB_ORIGIN || "http://localhost:3000";
  await f.register(cookie);
  await f.register(cors, { origin, credentials: true });

  f.addHook("onRequest", async (req: any, reply: any) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "no-store");
    if (
      req.url.startsWith("/api/") &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== origin
    )
      throw new Problem(403, "Origin not allowed.");
  });
  async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const value = await fn(c);
      await c.query("COMMIT");
      return value;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async function actor(req: any) {
    const secret = req.cookies.st_session;
    if (!secret) throw new Problem(401, "Sign in required.");
    const { rows } = await pool.query(
      "SELECT u.id,u.email,m.organization_id,m.role FROM auth_sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now() ORDER BY m.organization_id LIMIT 1",
      [digest(secret)],
    );
    if (!rows[0]) throw new Problem(401, "Session expired.");
    return rows[0];
  }
  const boxFor = async (req: any, ownerOnly = false) => {
    const user = await actor(req);
    const { rows } = await pool.query(
      "SELECT * FROM sandboxes WHERE id=$1 AND organization_id=$2",
      [req.params.id, user.organization_id],
    );
    if (!rows[0]) throw new Problem(404, "Sandbox not found.");
    if (ownerOnly && user.role !== "owner")
      throw new Problem(403, "Workspace owner access required.");
    return rows[0];
  };
  async function sessionCookie(reply: any, userId: string) {
    const secret = token();
    await pool.query(
      "INSERT INTO auth_sessions VALUES($1,$2,now()+interval '7 days')",
      [digest(secret), userId],
    );
    reply.setCookie("st_session", secret, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 604800,
    });
  }
  f.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });
  // DB-backed attempt limits work across API instances. Do not retain submitted credentials.
  async function authLimit(req: any) {
    const { rows } = await pool.query(
      "INSERT INTO auth_attempts VALUES($1,1,now()) ON CONFLICT(address) DO UPDATE SET attempts=CASE WHEN auth_attempts.window_start<now()-interval '15 minutes' THEN 1 ELSE auth_attempts.attempts+1 END,window_start=CASE WHEN auth_attempts.window_start<now()-interval '15 minutes' THEN now() ELSE auth_attempts.window_start END RETURNING attempts",
      [digest(req.ip)],
    );
    if (rows[0].attempts > 30)
      throw new Problem(429, "Too many attempts. Try again later.");
  }
  f.post("/api/auth/register", async (req: any, reply: any) => {
    await authLimit(req);
    const email = required(req.body?.email).trim().toLowerCase(),
      password = required(req.body?.password);
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      password.length < 12 ||
      password.length > 128
    )
      throw new Problem(
        400,
        "Use a valid email and a password of 12–128 characters.",
      );
    const hash = await hashPassword(password),
      uid = randomUUID(),
      oid = randomUUID();
    try {
      await tx(async (c) => {
        await c.query(
          "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
          [uid, email, hash],
        );
        await c.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [
          oid,
          "My workspace",
        ]);
        await c.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
          uid,
          oid,
        ]);
      });
    } catch (e: any) {
      if (e.code === "23505")
        throw new Problem(409, "Unable to register this email.");
      throw e;
    }
    await sessionCookie(reply, uid);
    reply.code(201);
    return { id: uid, email, organization_id: oid };
  });
  f.post("/api/auth/login", async (req: any, reply: any) => {
    await authLimit(req);
    const email = required(req.body?.email).trim().toLowerCase(),
      password = required(req.body?.password);
    if (password.length > 128)
      throw new Problem(400, "Invalid password length.");
    const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [
      email,
    ]);
    const hash =
      rows[0]?.password_hash || (await hashPassword("dummy-password"));
    if (!(await verifyPassword(password, hash)) || !rows[0])
      throw new Problem(401, "Invalid email or password.");
    await sessionCookie(reply, rows[0].id);
    return { email };
  });
  f.post("/api/auth/logout", async (req: any, reply: any) => {
    if (req.cookies.st_session)
      await pool.query("DELETE FROM auth_sessions WHERE token_hash=$1", [
        digest(req.cookies.st_session),
      ]);
    reply.clearCookie("st_session", { path: "/" });
    return { ok: true };
  });
  f.get("/api/me", async (req: any) => actor(req));
  f.get("/api/usage", async (req: any) => {
    const u = await actor(req);
    return (
      await pool.query(
        "SELECT o.request_limit,o.sandbox_limit,coalesce(m.requests,0) AS requests FROM organizations o LEFT JOIN monthly_usage m ON m.organization_id=o.id AND m.month=date_trunc('month',now())::date WHERE o.id=$1",
        [u.organization_id],
      )
    ).rows[0];
  });
  f.get("/api/sandboxes", async (req: any) => {
    const u = await actor(req);
    return (
      await pool.query(
        "SELECT id,name,approved,created_at,contract FROM sandboxes WHERE organization_id=$1 ORDER BY created_at DESC",
        [u.organization_id],
      )
    ).rows;
  });
  f.post("/api/sandboxes", async (req: any, reply: any) => {
    const u = await actor(req);
    let contract: Contract;
    try {
      contract = parseContract(required(req.body?.source));
    } catch (e: any) {
      throw new Problem(400, e.message);
    }
    const key = token(),
      id = randomUUID(),
      sid = randomUUID();
    await tx(async (c) => {
      const org = (
        await c.query(
          "SELECT sandbox_limit FROM organizations WHERE id=$1 FOR UPDATE",
          [u.organization_id],
        )
      ).rows[0];
      const count = Number(
        (
          await c.query(
            "SELECT count(*) FROM sandboxes WHERE organization_id=$1",
            [u.organization_id],
          )
        ).rows[0].count,
      );
      if (count >= org.sandbox_limit)
        throw new Problem(429, "Sandbox limit reached.");
      await c.query(
        "INSERT INTO sandboxes(id,organization_id,name,contract,api_key_hash) VALUES($1,$2,$3,$4,$5)",
        [id, u.organization_id, contract.title, contract, digest(key)],
      );
      await c.query(
        "INSERT INTO sandbox_versions(id,sandbox_id,number,definition) VALUES($1,$1,1,$2)",
        [id, defaultDefinition()],
      );
      await c.query(
        "INSERT INTO simulation_sessions(id,sandbox_id,name,version_id) VALUES($1,$2,'default',$2)",
        [sid, id],
      );
    });
    reply.code(201);
    return {
      id,
      name: contract.title,
      contract,
      sessionId: sid,
      apiKey: key,
      approved: false,
    };
  });
  f.post("/api/sandboxes/:id/approve", async (req: any) => {
    await boxFor(req, true);
    await tx(async (c) => {
      await c.query("UPDATE sandboxes SET approved=true WHERE id=$1", [
        req.params.id,
      ]);
      await c.query(
        "UPDATE sandbox_versions SET approved_at=now() WHERE sandbox_id=$1 AND number=1 AND approved_at IS NULL",
        [req.params.id],
      );
    });
    return { ok: true };
  });
  f.get("/api/sandboxes/:id/sessions", async (req: any) => {
    await boxFor(req);
    return (
      await pool.query(
        "SELECT id,name,scenario,generation,version_id,clock FROM simulation_sessions WHERE sandbox_id=$1 ORDER BY name",
        [req.params.id],
      )
    ).rows;
  });
  f.post("/api/sandboxes/:id/sessions", async (req: any, reply: any) => {
    await boxFor(req);
    const name = required(req.body?.name);
    if (!/^[a-z0-9-]{1,40}$/.test(name))
      throw new Problem(
        400,
        "Use a session name of 1–40 lowercase letters, numbers, or hyphens.",
      );
    const id = randomUUID();
    try {
      await tx(async (c) => {
        await c.query("SELECT id FROM sandboxes WHERE id=$1 FOR UPDATE", [
          req.params.id,
        ]);
        if (
          Number(
            (
              await c.query(
                "SELECT count(*) FROM simulation_sessions WHERE sandbox_id=$1",
                [req.params.id],
              )
            ).rows[0].count,
          ) >= 10
        )
          throw new Problem(429, "Session limit reached.");
        await c.query(
          "INSERT INTO simulation_sessions(id,sandbox_id,name,version_id) VALUES($1,$2,$3,$2)",
          [id, req.params.id, name],
        );
      });
    } catch (error: any) {
      if (error.code === "23505")
        throw new Problem(409, "Session name already exists.");
      throw error;
    }
    reply.code(201);
    return { id, name };
  });
  f.post("/api/sandboxes/:id/key", async (req: any) => {
    await boxFor(req, true);
    const apiKey = token();
    await pool.query("UPDATE sandboxes SET api_key_hash=$1 WHERE id=$2", [
      digest(apiKey),
      req.params.id,
    ]);
    return { apiKey };
  });
  f.get("/api/sandboxes/:id/webhooks", async (req: any) => {
    await boxFor(req);
    return (
      await pool.query(
        "SELECT id,url,description,active,created_at FROM webhook_endpoints WHERE sandbox_id=$1 ORDER BY created_at DESC",
        [req.params.id],
      )
    ).rows;
  });
  f.post("/api/sandboxes/:id/webhooks", async (req: any, reply: any) => {
    await boxFor(req, true);
    const url = required(req.body?.url).trim(),
      description = String(req.body?.description || "").trim();
    if (url.length > 2048 || description.length > 200)
      throw new Problem(400, "Webhook URL or description is too long.");
    try {
      await validateWebhookUrl(url, options.webhookResolver || systemResolver);
    } catch (error: any) {
      throw new Problem(400, error.message);
    }
    const id = randomUUID(),
      signingSecret = `whsec_${token()}`;
    let encrypted: string;
    try {
      encrypted = encryptSecret(signingSecret, options.webhookEncryptionKey);
    } catch (error: any) {
      throw new Problem(503, error.message);
    }
    await tx(async (client) => {
      await client.query("SELECT id FROM sandboxes WHERE id=$1 FOR UPDATE", [
        req.params.id,
      ]);
      const count = Number(
        (
          await client.query(
            "SELECT count(*) FROM webhook_endpoints WHERE sandbox_id=$1",
            [req.params.id],
          )
        ).rows[0].count,
      );
      if (count >= 10)
        throw new Problem(429, "Webhook endpoint limit reached.");
      await client.query(
        "INSERT INTO webhook_endpoints(id,sandbox_id,url,description,secret_ciphertext) VALUES($1,$2,$3,$4,$5)",
        [id, req.params.id, url, description, encrypted],
      );
    });
    reply.code(201);
    return { id, url, description, active: true, signingSecret };
  });
  f.post("/api/sandboxes/:id/webhooks/:wid/disable", async (req: any) => {
    await boxFor(req, true);
    const result = await pool.query(
      "UPDATE webhook_endpoints SET active=false WHERE id=$1 AND sandbox_id=$2",
      [req.params.wid, req.params.id],
    );
    if (!result.rowCount) throw new Problem(404, "Webhook endpoint not found.");
    return { ok: true };
  });
  f.get("/api/sandboxes/:id/webhook-deliveries", async (req: any) => {
    await boxFor(req);
    return (
      await pool.query(
        "SELECT d.id,d.status,d.attempts,d.response_status,d.response_excerpt,d.last_error,d.delivered_at,d.created_at,e.type,e.payload->>'id' AS event_public_id,p.url FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id JOIN webhook_endpoints p ON p.id=d.endpoint_id WHERE e.sandbox_id=$1 ORDER BY d.created_at DESC LIMIT 100",
        [req.params.id],
      )
    ).rows;
  });
  f.post(
    "/api/sandboxes/:id/webhook-deliveries/:did/replay",
    async (req: any) => {
      await boxFor(req, true);
      const result = await pool.query(
        "UPDATE webhook_deliveries d SET status='pending',attempts=0,next_attempt_at=now(),locked_until=NULL,worker_token=NULL,last_error=NULL,updated_at=now() FROM webhook_events e WHERE d.id=$1 AND d.event_id=e.id AND e.sandbox_id=$2 AND d.status<>'delivering'",
        [req.params.did, req.params.id],
      );
      if (!result.rowCount) {
        const exists = await pool.query(
          "SELECT 1 FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1 AND e.sandbox_id=$2",
          [req.params.did, req.params.id],
        );
        if (exists.rowCount)
          throw new Problem(409, "Delivery is currently in progress.");
        throw new Problem(404, "Delivery not found.");
      }
      return { ok: true };
    },
  );
  f.post("/api/sandboxes/:id/sessions/:sid/scenario", async (req: any) => {
    await boxFor(req);
    if (!scenarios.includes(req.body?.scenario))
      throw new Problem(400, "Unknown scenario.");
    const result = await pool.query(
      "UPDATE simulation_sessions SET scenario=$1 WHERE id=$2 AND sandbox_id=$3",
      [req.body.scenario, req.params.sid, req.params.id],
    );
    if (!result.rowCount) throw new Problem(404, "Session not found.");
    return { ok: true };
  });
  f.post("/api/sandboxes/:id/sessions/:sid/reset", async (req: any) => {
    await boxFor(req, true);
    await tx(async (c) => {
      const found = await c.query(
        "SELECT id FROM simulation_sessions WHERE id=$1 AND sandbox_id=$2 FOR UPDATE",
        [req.params.sid, req.params.id],
      );
      if (!found.rowCount) throw new Problem(404, "Session not found.");
      await c.query("DELETE FROM resources WHERE session_id=$1", [
        req.params.sid,
      ]);
      await c.query("DELETE FROM idempotent_results WHERE session_id=$1", [
        req.params.sid,
      ]);
      await c.query("DELETE FROM request_logs WHERE session_id=$1", [
        req.params.sid,
      ]);
      await c.query(
        "UPDATE simulation_sessions SET counter=0,generation=generation+1,rule_counts='{}',clock=(SELECT (definition->>'clock')::timestamptz FROM sandbox_versions WHERE id=version_id) WHERE id=$1",
        [req.params.sid],
      );
    });
    return { ok: true };
  });
  for (const view of ["logs", "resources"])
    f.get(`/api/sandboxes/:id/sessions/:sid/${view}`, async (req: any) => {
      await boxFor(req);
      const session = await pool.query(
        "SELECT id FROM simulation_sessions WHERE id=$1 AND sandbox_id=$2",
        [req.params.sid, req.params.id],
      );
      if (!session.rowCount) throw new Problem(404, "Session not found.");
      return (
        await pool.query(
          view === "logs"
            ? "SELECT method,path,status,detail,created_at,version_id,simulated_at FROM request_logs WHERE session_id=$1 ORDER BY id DESC LIMIT 100"
            : "SELECT kind,id,data FROM resources WHERE session_id=$1 ORDER BY kind,id LIMIT 1000",
          [req.params.sid],
        )
      ).rows;
    });

  f.get("/api/sandboxes/:id/proposals", async (req: any) => {
    const box = await boxFor(req);
    return suggestedFailures(box.contract);
  });
  f.post("/api/sandboxes/:id/proposals", async (req: any) => {
    const box = await boxFor(req, true);
    const prompt = required(req.body?.prompt);
    if (!prompt.trim() || prompt.length > 2000)
      throw new Problem(400, "Describe the scenario using 1–2000 characters.");
    if (Buffer.byteLength(JSON.stringify(box.contract)) > 65536)
      throw new Problem(400, "Contract exceeds the 64 KB proposal limit.");
    if (!proposalProvider)
      throw new Problem(
        503,
        "AI proposals are not configured. Template suggestions remain available.",
      );
    const reservation = await pool.query(
      "INSERT INTO proposal_usage(organization_id,month,requests) VALUES($1,date_trunc('month',now() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(organization_id,month) DO UPDATE SET requests=proposal_usage.requests+1 WHERE proposal_usage.requests<100 RETURNING requests",
      [box.organization_id],
    );
    if (!reservation.rowCount)
      throw new Problem(429, "Monthly AI proposal limit reached.");
    try {
      return await proposeScenario(box.contract, prompt, proposalProvider);
    } catch {
      throw new Problem(
        502,
        "AI proposal could not be generated. Try a template suggestion.",
      );
    }
  });
  f.get("/api/sandboxes/:id/versions", async (req: any) => {
    await boxFor(req);
    return (
      await pool.query(
        "SELECT id,number,definition,approved_at,created_at FROM sandbox_versions WHERE sandbox_id=$1 ORDER BY number DESC",
        [req.params.id],
      )
    ).rows;
  });
  f.post("/api/sandboxes/:id/versions", async (req: any, reply: any) => {
    const box = await boxFor(req);
    let value;
    try {
      value = definition(req.body, box.contract);
    } catch (e: any) {
      throw new Problem(400, e.message);
    }
    const id = randomUUID();
    const number = await tx(async (c) => {
      await c.query("SELECT id FROM sandboxes WHERE id=$1 FOR UPDATE", [
        box.id,
      ]);
      const n =
        Number(
          (
            await c.query(
              "SELECT max(number) AS n FROM sandbox_versions WHERE sandbox_id=$1",
              [box.id],
            )
          ).rows[0].n,
        ) + 1;
      if (n > 100) throw new Problem(429, "Scenario version limit reached.");
      await c.query(
        "INSERT INTO sandbox_versions(id,sandbox_id,number,definition) VALUES($1,$2,$3,$4)",
        [id, box.id, n, value],
      );
      return n;
    });
    reply.code(201);
    return { id, number, definition: value, approved_at: null };
  });
  f.post("/api/sandboxes/:id/versions/:vid/approve", async (req: any) => {
    await boxFor(req, true);
    const r = await pool.query(
      "UPDATE sandbox_versions SET approved_at=coalesce(approved_at,now()) WHERE id=$1 AND sandbox_id=$2 RETURNING id",
      [req.params.vid, req.params.id],
    );
    if (!r.rowCount) throw new Problem(404, "Version not found.");
    return { ok: true };
  });
  f.post("/api/sandboxes/:id/sessions/:sid/configure", async (req: any) => {
    await boxFor(req, true);
    const vid = required(req.body?.versionId);
    await tx(async (c) => {
      const row = (
        await c.query(
          "SELECT id FROM simulation_sessions WHERE id=$1 AND sandbox_id=$2 FOR UPDATE",
          [req.params.sid, req.params.id],
        )
      ).rows[0];
      if (!row) throw new Problem(404, "Session not found.");
      const version = (
        await c.query(
          "SELECT * FROM sandbox_versions WHERE id=$1 AND sandbox_id=$2 AND approved_at IS NOT NULL",
          [vid, req.params.id],
        )
      ).rows[0];
      if (!version)
        throw new Problem(409, "Choose an approved version from this sandbox.");
      await c.query("DELETE FROM resources WHERE session_id=$1", [row.id]);
      await c.query("DELETE FROM request_logs WHERE session_id=$1", [row.id]);
      await c.query("DELETE FROM idempotent_results WHERE session_id=$1", [
        row.id,
      ]);
      await c.query(
        "UPDATE simulation_sessions SET version_id=$1,counter=0,rule_counts='{}',clock=$2,generation=generation+1,scenario='success' WHERE id=$3",
        [vid, version.definition.clock, row.id],
      );
    });
    return { ok: true };
  });
  f.post("/api/sandboxes/:id/sessions/:sid/clock", async (req: any) => {
    await boxFor(req);
    const ms = req.body?.advanceMs;
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 86400000)
      throw new Problem(400, "Advance the clock by 0–86400000 milliseconds.");
    const r = await pool.query(
      "UPDATE simulation_sessions SET clock=clock+($1 * interval '1 millisecond') WHERE id=$2 AND sandbox_id=$3 RETURNING clock",
      [ms, req.params.sid, req.params.id],
    );
    if (!r.rowCount) throw new Problem(404, "Session not found.");
    return r.rows[0];
  });

  f.all("/sandbox/:id/*", async (req: any, reply: any) => {
    const route = "/" + req.params["*"];
    const key = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const sandbox = (
      await pool.query(
        "SELECT * FROM sandboxes WHERE id=$1 AND api_key_hash=$2",
        [req.params.id, digest(key)],
      )
    ).rows[0];
    if (!sandbox) throw new Problem(401, "Invalid sandbox key.");
    if (!sandbox.approved)
      throw new Problem(
        409,
        "Review and approve inferred behaviors before running this sandbox.",
      );
    const result = await tx((c) => execute(c, sandbox, req, route));
    if (result.delay)
      await new Promise((resolve) => setTimeout(resolve, result.delay));
    return reply.code(result.status).send(result.data);
  });
  await app.init();
  f.setErrorHandler((error: any, _req: any, reply: any) => {
    const code =
      error.code === "23505"
        ? 409
        : error.code === "22P02"
          ? 400
          : error instanceof Problem
            ? error.status
            : error.statusCode && error.statusCode < 500
              ? error.statusCode
              : 500;
    reply.code(code).send({
      error:
        code === 500
          ? "Internal server error."
          : error.code === "23505"
            ? "Resource already exists."
            : error.code === "22P02"
              ? "Invalid identifier."
              : error.message,
    });
  });
  await f.ready();
  return app;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL is required. Run migrations before starting.",
    );
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  });
  const app = await createApp(pool);
  app.enableShutdownHooks();
  await app.listen(
    Number(process.env.PORT || 4000),
    process.env.HOST || "127.0.0.1",
  );
  console.log("SpecTwin API ready");
}
