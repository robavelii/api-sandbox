import type { Pool, PoolClient } from "pg";
import { token, digest, hashPassword } from "./auth.js";

export type RecoverySender = (email: string, code: string) => Promise<void>;
export function recoveryMailer(
  key = process.env.RESEND_API_KEY,
  from = process.env.VERIFICATION_FROM,
  transport: typeof fetch = fetch,
): RecoverySender | undefined {
  if (!key || !from) return undefined;
  return async (email, code) => {
    const response = await transport("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: "Reset your SpecTwin password",
        text: `Your password recovery code is:\n\n${code}\n\nEnter it in SpecTwin's Forgot password form within 30 minutes. This code can be used once. If you did not request it, ignore this email.`,
      }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Recovery mail delivery failed.");
  };
}

export function registerRecovery(
  server: any,
  pool: Pool,
  tx: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>,
  authLimit: (req: any) => Promise<void>,
  sender: RecoverySender | undefined,
) {
  const generic = {
    message:
      "If this email belongs to a verified account, a recovery code will be sent.",
  };
  server.post("/api/auth/recovery/request", async (req: any) => {
    await authLimit(req);
    const email =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
    // All syntactically invalid, unknown, unverified, cooldown and delivery
    // outcomes share one public response. Never expose provider details.
    if (
      !email ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !sender
    )
      return generic;
    const reserved = await pool.query(
      "INSERT INTO recovery_requests(email_hash) VALUES($1) ON CONFLICT(email_hash) DO UPDATE SET requested_at=now() WHERE recovery_requests.requested_at<now()-interval '1 minute' RETURNING email_hash",
      [digest(email)],
    );
    if (!reserved.rowCount) return generic;
    const code = token();
    const user = await tx(async (client) => {
      const account = (
        await client.query(
          "SELECT id,email FROM users WHERE email=$1 AND email_verified_at IS NOT NULL FOR UPDATE",
          [email],
        )
      ).rows[0];
      if (!account) return undefined;
      await client.query(
        "INSERT INTO password_recoveries(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 minutes') ON CONFLICT(user_id) DO UPDATE SET token_hash=$2,expires_at=now()+interval '30 minutes'",
        [account.id, digest(code)],
      );
      return account;
    });
    if (user) {
      try {
        await sender(user.email, code);
      } catch {
        await pool.query(
          "DELETE FROM password_recoveries WHERE user_id=$1 AND token_hash=$2",
          [user.id, digest(code)],
        );
      }
    }
    return generic;
  });
  server.post("/api/auth/recovery/confirm", async (req: any, reply: any) => {
    await authLimit(req);
    const code = req.body?.code,
      password = req.body?.newPassword;
    if (
      typeof code !== "string" ||
      !/^[a-f0-9]{64}$/.test(code) ||
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 128
    )
      return reply.code(400).send({
        error: "Use a valid recovery code and a password of 12–128 characters.",
      });
    const hash = await hashPassword(password);
    const changed = await tx(async (client) => {
      const recovery = (
        await client.query(
          "SELECT user_id FROM password_recoveries WHERE token_hash=$1",
          [digest(code)],
        )
      ).rows[0];
      if (!recovery) return false;
      // Same lock order as login, password change and recovery issuance.
      await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        recovery.user_id,
      ]);
      const consumed = await client.query(
        "DELETE FROM password_recoveries WHERE user_id=$1 AND token_hash=$2 AND expires_at>now() RETURNING user_id",
        [recovery.user_id, digest(code)],
      );
      if (!consumed.rowCount) return false;
      await client.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        hash,
        recovery.user_id,
      ]);
      await client.query("DELETE FROM auth_sessions WHERE user_id=$1", [
        recovery.user_id,
      ]);
      return true;
    });
    if (!changed)
      return reply
        .code(400)
        .send({ error: "Recovery code is invalid or expired." });
    // No login is created and no unrelated account's cookie is cleared.
    return { ok: true };
  });
}
