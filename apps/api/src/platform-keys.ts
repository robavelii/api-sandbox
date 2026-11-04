import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { digest, token } from "./auth.js";

type Actor = { id: string; organization_id: string; role: string };
type ProblemConstructor = new (status: number, message: string) => Error;

export async function platformActor(pool: Pool, secret: string) {
  if (!/^stp_[a-f0-9]{64}$/.test(secret)) return undefined;
  return (
    await pool.query(
      "SELECT u.id,u.email,k.organization_id,m.role FROM platform_api_keys k JOIN users u ON u.id=k.created_by JOIN memberships m ON m.user_id=k.created_by AND m.organization_id=k.organization_id WHERE k.token_hash=$1 AND k.scope='read' AND k.revoked_at IS NULL AND k.expires_at>now() AND m.role='owner'",
      [digest(secret)],
    )
  ).rows[0];
}

export function platformKeyReadAllowed(method: string, url: string) {
  const path = url.split("?")[0];
  return (
    method === "GET" &&
    (path === "/api/me" ||
      path === "/api/usage" ||
      path === "/api/sandboxes" ||
      path.startsWith("/api/sandboxes/"))
  );
}

export function registerPlatformKeys(
  server: any,
  pool: Pool,
  actor: (req: any) => Promise<Actor>,
  tx: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>,
  Problem: ProblemConstructor,
) {
  const owner = async (req: any) => {
    const user = await actor(req);
    if (user.role !== "owner")
      throw new Problem(403, "Workspace owner access required.");
    return user;
  };
  server.get("/api/platform-keys", async (req: any) => {
    const user = await owner(req);
    return (
      await pool.query(
        "SELECT id,name,scope,created_at,expires_at,revoked_at FROM platform_api_keys WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
        [user.organization_id],
      )
    ).rows;
  });
  server.post("/api/platform-keys", async (req: any, reply: any) => {
    const user = await owner(req);
    const name = req.body?.name;
    const days = req.body?.expiresInDays ?? 90;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 80 ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 365
    )
      throw new Problem(
        400,
        "Use a key name of 1–80 characters and an expiry of 1–365 days.",
      );
    const secret = `stp_${token()}`,
      id = randomUUID();
    const result = await tx(async (client) => {
      await client.query(
        "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
        [user.organization_id],
      );
      const membership = (
        await client.query(
          "SELECT role FROM memberships WHERE user_id=$1 AND organization_id=$2",
          [user.id, user.organization_id],
        )
      ).rows[0];
      if (membership?.role !== "owner")
        throw new Problem(403, "Workspace owner access required.");
      const count = Number(
        (
          await client.query(
            "SELECT count(*) FROM platform_api_keys WHERE organization_id=$1 AND revoked_at IS NULL AND expires_at>now()",
            [user.organization_id],
          )
        ).rows[0].count,
      );
      if (count >= 20)
        throw new Problem(429, "Active platform key limit reached.");
      return (
        await client.query(
          "INSERT INTO platform_api_keys(id,organization_id,created_by,name,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+($6*interval '1 day')) RETURNING id,name,scope,expires_at",
          [
            id,
            user.organization_id,
            user.id,
            name.trim(),
            digest(secret),
            days,
          ],
        )
      ).rows[0];
    });
    reply.code(201);
    return { ...result, token: secret };
  });
  server.post("/api/platform-keys/:kid/revoke", async (req: any) => {
    const user = await owner(req);
    await tx(async (client) => {
      await client.query(
        "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
        [user.organization_id],
      );
      const membership = (
        await client.query(
          "SELECT role FROM memberships WHERE user_id=$1 AND organization_id=$2",
          [user.id, user.organization_id],
        )
      ).rows[0];
      if (membership?.role !== "owner")
        throw new Problem(403, "Workspace owner access required.");
      const result = await client.query(
        "UPDATE platform_api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND organization_id=$2 RETURNING id",
        [req.params.kid, user.organization_id],
      );
      if (!result.rowCount) throw new Problem(404, "Platform key not found.");
    });
    return { ok: true };
  });
}
