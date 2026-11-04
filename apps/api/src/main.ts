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
import { isIP } from "node:net";
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
import { verificationMailer } from "./verification-mail.js";
import {
  platformActor,
  platformKeyReadAllowed,
  registerPlatformKeys,
} from "./platform-keys.js";
import {
  registerRecovery,
  recoveryMailer,
  type RecoverySender,
} from "./recovery.js";
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
// Only explicit proxy addresses are trusted, so X-Forwarded-For cannot be
// spoofed by clients connecting directly. Wildcards are rejected.
export function trustedProxyList(value = ""): string[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split("/");
    const family = isIP(address);
    const bits = family === 4 ? 32 : 128;
    if (
      !family ||
      extra !== undefined ||
      (prefix !== undefined &&
        !(/^\d{1,3}$/.test(prefix) && Number(prefix) <= bits))
    )
      throw new Error(`Invalid TRUSTED_PROXIES entry: ${entry}`);
  }
  if (entries.length > 16)
    throw new Error("TRUSTED_PROXIES allows 16 entries.");
  return entries;
}
export async function createApp(
  pool: Pool,
  options: {
    webhookResolver?: Resolver;
    webhookEncryptionKey?: string;
    proposalProvider?: ProposalProvider;
    sendVerification?: (email: string, code: string) => Promise<void>;
    sendRecovery?: RecoverySender;
    trustedProxies?: string[];
  } = {},
) {
  const proposalProvider = options.proposalProvider || openAIProposalProvider();
  const sendVerification = options.sendVerification || verificationMailer();
  const trustedProxies =
    options.trustedProxies || trustedProxyList(process.env.TRUSTED_PROXIES);
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule,
    new FastifyAdapter({
      bodyLimit: 1_048_576,
      trustProxy: trustedProxies.length ? trustedProxies : false,
    }),
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
      req.headers.authorization &&
      !platformKeyReadAllowed(req.method, req.url)
    )
      throw new Problem(
        403,
        "Platform keys provide read-only sandbox access. Use a browser session for this action.",
      );
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
  async function cancelSessionWebhooks(client: PoolClient, sessionId: string) {
    await client.query(
      "UPDATE webhook_events SET fanout_at=coalesce(fanout_at,now()) WHERE session_id=$1",
      [sessionId],
    );
    await client.query(
      "UPDATE webhook_deliveries d SET status='failed',locked_until=NULL,worker_token=NULL,last_error='Session reset or reconfigured',updated_at=now() FROM webhook_events e WHERE d.event_id=e.id AND e.session_id=$1 AND d.status IN ('pending','delivering')",
      [sessionId],
    );
  }
  async function actor(req: any, ignoreWorkspace = false) {
    if (req.headers.authorization) {
      const value = await platformActor(
        pool,
        String(req.headers.authorization).replace(/^Bearer /, ""),
      );
      if (!value) throw new Problem(401, "Invalid or expired platform key.");
      return value;
    }
    const secret = req.cookies.st_session;
    if (!secret) throw new Problem(401, "Sign in required.");
    const workspace = ignoreWorkspace ? null : req.cookies.st_workspace || null;
    if (
      workspace &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        workspace,
      )
    )
      throw new Problem(400, "Invalid workspace identifier.");
    const { rows } = await pool.query(
      "SELECT u.id,u.email,m.organization_id,m.role FROM auth_sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now() AND ($2::uuid IS NULL OR m.organization_id=$2) ORDER BY m.organization_id LIMIT 1",
      [digest(secret), workspace],
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
  async function sessionCookie(
    reply: any,
    userId: string,
    database: Pick<Pool, "query"> = pool,
  ) {
    const secret = token();
    await database.query(
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
    reply.clearCookie("st_workspace", { path: "/" });
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
  registerRecovery(
    f,
    pool,
    tx,
    authLimit,
    options.sendRecovery || recoveryMailer(),
  );
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
    await tx(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM users WHERE email=$1 FOR UPDATE",
        [email],
      );
      const hash =
        rows[0]?.password_hash || (await hashPassword("dummy-password"));
      if (!(await verifyPassword(password, hash)) || !rows[0])
        throw new Problem(401, "Invalid email or password.");
      await sessionCookie(reply, rows[0].id, client);
    });
    return { email };
  });
  f.post("/api/auth/password", async (req: any, reply: any) => {
    const user = await actor(req);
    await authLimit(req);
    const currentPassword = required(req.body?.currentPassword);
    const newPassword = required(req.body?.newPassword);
    if (
      currentPassword.length > 128 ||
      newPassword.length < 12 ||
      newPassword.length > 128
    )
      throw new Problem(400, "Use a password of 12–128 characters.");
    await tx(async (client) => {
      const row = (
        await client.query(
          "SELECT password_hash FROM users WHERE id=$1 FOR UPDATE",
          [user.id],
        )
      ).rows[0];
      // Recheck after taking the user lock: another password change may have
      // revoked this request's session while it waited.
      const session = await client.query(
        "SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()",
        [digest(req.cookies.st_session), user.id],
      );
      if (!session.rowCount) throw new Problem(401, "Session expired.");
      if (!(await verifyPassword(currentPassword, row.password_hash)))
        throw new Problem(401, "Current password is incorrect.");
      await client.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        await hashPassword(newPassword),
        user.id,
      ]);
      await client.query("DELETE FROM auth_sessions WHERE user_id=$1", [
        user.id,
      ]);
      await client.query("DELETE FROM password_recoveries WHERE user_id=$1", [
        user.id,
      ]);
      await sessionCookie(reply, user.id, client);
    });
    return { ok: true };
  });
  for (const mode of ["logout-others", "logout-all"] as const) {
    f.post(`/api/auth/${mode}`, async (req: any, reply: any) => {
      const user = await actor(req);
      await tx(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          user.id,
        ]);
        const valid = await client.query(
          "SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()",
          [digest(req.cookies.st_session), user.id],
        );
        if (!valid.rowCount) throw new Problem(401, "Session expired.");
        await client.query(
          "DELETE FROM auth_sessions WHERE user_id=$1 AND ($2::boolean OR token_hash<>$3)",
          [user.id, mode === "logout-all", digest(req.cookies.st_session)],
        );
      });
      if (mode === "logout-all") reply.clearCookie("st_session", { path: "/" });
      return { ok: true };
    });
  }
  f.post("/api/auth/logout", async (req: any, reply: any) => {
    if (req.cookies.st_session)
      await pool.query("DELETE FROM auth_sessions WHERE token_hash=$1", [
        digest(req.cookies.st_session),
      ]);
    reply.clearCookie("st_session", { path: "/" });
    return { ok: true };
  });
  f.get("/api/me", async (req: any) => actor(req));
  registerPlatformKeys(f, pool, actor, tx, Problem);
  f.get("/api/auth/email-status", async (req: any) => {
    const user = await actor(req, true);
    const row = (
      await pool.query("SELECT email_verified_at FROM users WHERE id=$1", [
        user.id,
      ])
    ).rows[0];
    return { verified: Boolean(row.email_verified_at) };
  });
  f.post("/api/auth/email-verification", async (req: any) => {
    const user = await actor(req, true);
    await authLimit(req);
    if (!sendVerification)
      throw new Problem(503, "Verification email delivery is not configured.");
    const code = token();
    await tx(async (client) => {
      const row = (
        await client.query(
          "SELECT email_verified_at FROM users WHERE id=$1 FOR UPDATE",
          [user.id],
        )
      ).rows[0];
      if (row.email_verified_at)
        throw new Problem(409, "Email is already verified.");
      const reservation = await client.query(
        "INSERT INTO email_verifications(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '24 hours') ON CONFLICT(user_id) DO UPDATE SET token_hash=$2,expires_at=now()+interval '24 hours',sent_at=now() WHERE email_verifications.sent_at<now()-interval '1 minute' RETURNING user_id",
        [user.id, digest(code)],
      );
      if (!reservation.rowCount)
        throw new Problem(
          429,
          "Wait one minute before requesting another verification email.",
        );
    });
    try {
      await sendVerification(user.email, code);
    } catch {
      await pool.query(
        "UPDATE email_verifications SET expires_at=now() WHERE user_id=$1 AND token_hash=$2",
        [user.id, digest(code)],
      );
      throw new Problem(502, "Unable to deliver verification email.");
    }
    return { ok: true };
  });
  f.post("/api/auth/email-verification/confirm", async (req: any) => {
    const user = await actor(req, true);
    await authLimit(req);
    const code = required(req.body?.code);
    if (!/^[a-f0-9]{64}$/.test(code))
      throw new Problem(400, "Invalid or expired verification code.");
    await tx(async (client) => {
      await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        user.id,
      ]);
      const consumed = await client.query(
        "DELETE FROM email_verifications WHERE user_id=$1 AND token_hash=$2 AND expires_at>now() RETURNING user_id",
        [user.id, digest(code)],
      );
      if (!consumed.rowCount)
        throw new Problem(400, "Invalid or expired verification code.");
      await client.query(
        "UPDATE users SET email_verified_at=now() WHERE id=$1",
        [user.id],
      );
    });
    return { ok: true };
  });
  f.get("/api/workspaces", async (req: any) => {
    const user = await actor(req, true);
    return (
      await pool.query(
        "SELECT o.id,o.name,m.role FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=$1 ORDER BY o.name,o.id",
        [user.id],
      )
    ).rows;
  });
  f.get("/api/workspaces/invitations", async (req: any) => {
    const user = await actor(req);
    if (user.role !== "owner")
      throw new Problem(403, "Workspace owner access required.");
    return (
      await pool.query(
        "SELECT id,email,expires_at,created_at FROM workspace_invitations WHERE organization_id=$1 AND expires_at>now() ORDER BY created_at DESC",
        [user.organization_id],
      )
    ).rows;
  });
  f.post("/api/workspaces/invitations", async (req: any) => {
    const user = await actor(req);
    const email = required(req.body?.email).trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Problem(400, "Use a valid email address.");
    const code = token(),
      id = randomUUID();
    await tx(async (client) => {
      await client.query(
        "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
        [user.organization_id],
      );
      const caller = (
        await client.query(
          "SELECT m.role,u.email_verified_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.organization_id=$2",
          [user.id, user.organization_id],
        )
      ).rows[0];
      if (caller?.role !== "owner")
        throw new Problem(403, "Workspace owner access required.");
      if (!caller.email_verified_at)
        throw new Problem(403, "Verify your email before inviting members.");
      await client.query(
        "DELETE FROM workspace_invitations WHERE organization_id=$1 AND (expires_at<=now() OR email=$2)",
        [user.organization_id, email],
      );
      const count = Number(
        (
          await client.query(
            "SELECT count(*) FROM workspace_invitations WHERE organization_id=$1",
            [user.organization_id],
          )
        ).rows[0].count,
      );
      if (count >= 100)
        throw new Problem(429, "Workspace invitation limit reached.");
      await client.query(
        "INSERT INTO workspace_invitations(id,organization_id,email,token_hash) VALUES($1,$2,$3,$4)",
        [id, user.organization_id, email, digest(code)],
      );
    });
    return { id, email, code };
  });
  f.post("/api/workspaces/invitations/:iid/revoke", async (req: any) => {
    const user = await actor(req);
    await tx(async (client) => {
      await client.query(
        "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
        [user.organization_id],
      );
      const caller = (
        await client.query(
          "SELECT role FROM memberships WHERE user_id=$1 AND organization_id=$2",
          [user.id, user.organization_id],
        )
      ).rows[0];
      if (caller?.role !== "owner")
        throw new Problem(403, "Workspace owner access required.");
      const result = await client.query(
        "DELETE FROM workspace_invitations WHERE id=$1 AND organization_id=$2",
        [req.params.iid, user.organization_id],
      );
      if (!result.rowCount) throw new Problem(404, "Invitation not found.");
    });
    return { ok: true };
  });
  f.post("/api/workspaces/invitations/accept", async (req: any) => {
    const user = await actor(req, true);
    await authLimit(req);
    const code = required(req.body?.code);
    if (!/^[a-f0-9]{64}$/.test(code))
      throw new Problem(400, "Invalid invitation code.");
    return tx(async (client) => {
      const invitation = (
        await client.query(
          "SELECT organization_id FROM workspace_invitations WHERE token_hash=$1",
          [digest(code)],
        )
      ).rows[0];
      if (!invitation)
        throw new Problem(404, "Invitation not found or expired.");
      await client.query(
        "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
        [invitation.organization_id],
      );
      const account = (
        await client.query(
          "SELECT email,email_verified_at FROM users WHERE id=$1",
          [user.id],
        )
      ).rows[0];
      if (!account.email_verified_at)
        throw new Problem(
          403,
          "Verify your email before accepting invitations.",
        );
      const consumed = await client.query(
        "DELETE FROM workspace_invitations WHERE token_hash=$1 AND email=$2 AND expires_at>now() RETURNING organization_id",
        [digest(code), account.email],
      );
      if (!consumed.rowCount)
        throw new Problem(404, "Invitation not found or expired.");
      await client.query(
        "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",
        [user.id, invitation.organization_id],
      );
      return { workspaceId: invitation.organization_id };
    });
  });
  f.get("/api/workspaces/audit", async (req: any) => {
    const user = await actor(req);
    if (user.role !== "owner")
      throw new Problem(403, "Workspace owner access required.");
    const before = req.query.before;
    if (
      before !== undefined &&
      (typeof before !== "string" ||
        !/^[1-9][0-9]{0,18}$/.test(before) ||
        BigInt(before) > 9223372036854775807n)
    )
      throw new Problem(400, "Invalid audit cursor.");
    return (
      await pool.query(
        "SELECT id,action,resource_id,metadata,created_at FROM audit_events WHERE organization_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 100",
        [user.organization_id, before || null],
      )
    ).rows;
  });
  f.get("/api/workspaces/members", async (req: any) => {
    const user = await actor(req);
    if (user.role !== "owner")
      throw new Problem(403, "Workspace owner access required.");
    return (
      await pool.query(
        "SELECT u.id,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY u.email",
        [user.organization_id],
      )
    ).rows;
  });
  for (const action of ["role", "remove"] as const) {
    f.post(`/api/workspaces/members/:uid/${action}`, async (req: any) => {
      const user = await actor(req);
      const role = action === "role" ? req.body?.role : null;
      if (action === "role" && !["owner", "member"].includes(role))
        throw new Problem(400, "Role must be owner or member.");
      await tx(async (client) => {
        // All membership mutations take the same workspace lock, including
        // authorization rechecks and the last-owner invariant.
        await client.query(
          "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
          [user.organization_id],
        );
        const caller = (
          await client.query(
            "SELECT role FROM memberships WHERE user_id=$1 AND organization_id=$2",
            [user.id, user.organization_id],
          )
        ).rows[0];
        if (caller?.role !== "owner")
          throw new Problem(403, "Workspace owner access required.");
        const target = (
          await client.query(
            "SELECT role FROM memberships WHERE user_id=$1 AND organization_id=$2",
            [req.params.uid, user.organization_id],
          )
        ).rows[0];
        if (!target) throw new Problem(404, "Member not found.");
        if (target.role === "owner" && role !== "owner") {
          const count = Number(
            (
              await client.query(
                "SELECT count(*) FROM memberships WHERE organization_id=$1 AND role='owner'",
                [user.organization_id],
              )
            ).rows[0].count,
          );
          if (count <= 1)
            throw new Problem(
              409,
              "A workspace must retain at least one owner.",
            );
        }
        if (action === "remove")
          await client.query(
            "DELETE FROM memberships WHERE user_id=$1 AND organization_id=$2",
            [req.params.uid, user.organization_id],
          );
        else
          await client.query(
            "UPDATE memberships SET role=$1 WHERE user_id=$2 AND organization_id=$3",
            [role, req.params.uid, user.organization_id],
          );
      });
      return { ok: true };
    });
  }
  f.post("/api/workspaces/select", async (req: any, reply: any) => {
    const user = await actor(req, true);
    const id = required(req.body?.workspaceId);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      throw new Problem(400, "Invalid workspace identifier.");
    const membership = await pool.query(
      "SELECT role FROM memberships WHERE user_id=$1 AND organization_id=$2",
      [user.id, id],
    );
    if (!membership.rowCount) throw new Problem(404, "Workspace not found.");
    reply.setCookie("st_workspace", id, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 604800,
    });
    return { id, role: membership.rows[0].role };
  });
  f.get("/api/usage", async (req: any) => {
    const u = await actor(req);
    return (
      await pool.query(
        "SELECT o.request_limit,o.sandbox_limit,coalesce(m.requests,0) AS requests FROM organizations o LEFT JOIN monthly_usage m ON m.organization_id=o.id AND m.month=date_trunc('month',now() AT TIME ZONE 'UTC')::date WHERE o.id=$1",
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
      await cancelSessionWebhooks(c, req.params.sid);
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
      await cancelSessionWebhooks(c, row.id);
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
