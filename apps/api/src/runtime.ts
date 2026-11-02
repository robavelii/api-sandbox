import type { PoolClient } from "pg";
import {
  match,
  validate,
  deterministicId,
} from "../../../packages/engine/src/index.js";
import {
  selectRule,
  generate,
  fingerprint,
  type Definition,
} from "../../../packages/engine/src/scenario.js";
export async function execute(
  c: PoolClient,
  sandbox: any,
  req: any,
  route: string,
) {
  const session = (
    await c.query(
      "SELECT s.*,v.definition,v.approved_at FROM simulation_sessions s JOIN sandbox_versions v ON v.id=s.version_id WHERE s.sandbox_id=$1 AND s.name=$2 FOR UPDATE OF s",
      [sandbox.id, req.headers["x-spectwin-session"] || "default"],
    )
  ).rows[0];
  if (!session)
    throw Object.assign(new Error("Session not found."), { statusCode: 404 });
  const config = session.definition as Definition;
  let delay = session.scenario === "delay" ? 1000 : 0;
  const log = async (status: number, data: any, detail: string) => {
    await c.query(
      "INSERT INTO request_logs(session_id,method,path,status,detail,version_id,simulated_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        session.id,
        req.method,
        route.slice(0, 2048),
        status,
        detail,
        session.version_id,
        session.clock,
      ],
    );
    return { status, data, delay };
  };
  if (!session.approved_at)
    return log(
      409,
      { error: "Approve the pinned scenario version first." },
      "Unapproved scenario",
    );
  const usage = (
    await c.query(
      "INSERT INTO monthly_usage VALUES($1,date_trunc('month',now())::date,1) ON CONFLICT(organization_id,month) DO UPDATE SET requests=monthly_usage.requests+1 RETURNING requests",
      [sandbox.organization_id],
    )
  ).rows[0];
  const limit = (
    await c.query("SELECT request_limit FROM organizations WHERE id=$1", [
      sandbox.organization_id,
    ])
  ).rows[0].request_limit;
  if (usage.requests > limit)
    return log(
      429,
      { error: "Monthly request quota exceeded." },
      "Platform quota",
    );
  const op = match(sandbox.contract, req.method, route);
  if (!op)
    return log(404, { error: "Operation is not declared." }, "Route not found");
  const mutation = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method);
  const key = req.headers["idempotency-key"];
  if (
    key !== undefined &&
    (typeof key !== "string" || key.length < 1 || key.length > 128)
  )
    return log(
      400,
      { error: "Idempotency-Key must contain 1–128 characters." },
      "Invalid idempotency key",
    );
  const cacheKey =
    mutation && key && config.idempotency !== "off" ? fingerprint(key) : null;
  const requestHash = fingerprint({
    method: req.method,
    route,
    query: req.query,
    body: req.body,
  });
  if (cacheKey) {
    const prior = (
      await c.query(
        "SELECT * FROM idempotent_results WHERE session_id=$1 AND key_hash=$2",
        [session.id, cacheKey],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.fingerprint !== requestHash ||
        config.idempotency === "conflict"
      )
        return log(
          409,
          { error: "Idempotency key conflict." },
          "Idempotency conflict",
        );
      return log(
        prior.status,
        prior.result ?? undefined,
        "Replayed saved result",
      );
    }
  }
  if (session.scenario === "error")
    return log(
      500,
      { error: "Simulated server error." },
      "Injected before mutation",
    );
  if (session.scenario === "rate_limit")
    return log(
      429,
      { error: "Simulated rate limit." },
      "Injected before mutation",
    );
  if (op.requestRequired && req.body === undefined)
    return log(400, { error: "Request body is required." }, "Validation");
  const invalid = validate(op.request, req.body);
  if (invalid) return log(400, { error: invalid }, "Request validation");
  const selected = selectRule(config, op.id, session.rule_counts),
    rule = selected?.rule;
  if (selected) {
    await c.query(
      "UPDATE simulation_sessions SET rule_counts=jsonb_set(rule_counts,ARRAY[$1],to_jsonb(coalesce((rule_counts->>$1)::integer,0)+1)) WHERE id=$2",
      [String(selected.index), session.id],
    );
  }
  delay = Math.max(delay, rule?.delayMs || 0);
  if (rule?.failure?.phase === "before")
    return log(
      rule.failure.status,
      { error: "Simulated failure before mutation." },
      "Scenario failure before mutation",
    );
  if (op.behavior === "unconfigured" && !rule?.action)
    return log(
      501,
      { error: "Custom action is not configured." },
      "Unsupported action",
    );
  if (
    ["create", "update", "replace"].includes(op.behavior) &&
    (typeof req.body !== "object" ||
      req.body === null ||
      Array.isArray(req.body))
  )
    return log(
      400,
      { error: "Stateful mutations require an object body." },
      "Validation",
    );
  const rid = route.split("/")[2],
    kind = op.resource;
  let value: any;
  if (op.behavior === "create" && !rule?.action) {
    let generated: any = {};
    try {
      generated = generate(
        op.response,
        `${config.seed}:${session.counter + 1}`,
        new Date(session.clock).toISOString(),
      );
    } catch (e: any) {
      return log(
        422,
        { error: e.message },
        "Generation failed without mutation",
      );
    }
    if (!generated || typeof generated !== "object" || Array.isArray(generated))
      return log(
        422,
        { error: "Create responses must be objects for stateful storage." },
        "Unsupported response shape",
      );
    value = {
      ...generated,
      ...req.body,
      id: deterministicId(kind, session.counter + 1),
    };
  } else if (op.behavior === "list" && !rule?.action)
    value = (
      await c.query(
        "SELECT data FROM resources WHERE session_id=$1 AND kind=$2 ORDER BY id LIMIT 1000",
        [session.id, kind],
      )
    ).rows.map((x) => x.data);
  else {
    const row = (
      await c.query(
        "SELECT data FROM resources WHERE session_id=$1 AND kind=$2 AND id=$3",
        [session.id, kind, rid],
      )
    ).rows[0];
    if (!row)
      return log(404, { error: "Resource not found." }, "Missing resource");
    if (rule?.action) {
      if (!rule.action.from.includes(row.data[rule.action.field]))
        return log(
          409,
          { error: "Resource is not in an allowed source state." },
          "Transition precondition failed",
        );
      value = { ...row.data, [rule.action.field]: rule.action.to };
    } else
      value =
        op.behavior === "update"
          ? { ...row.data, ...req.body, id: rid }
          : op.behavior === "replace"
            ? { ...req.body, id: rid }
            : row.data;
  }
  const response = op.status === 204 ? undefined : value;
  const responseError =
    op.status === 204 ? null : validate(op.response, response);
  if (responseError)
    return log(
      422,
      {
        error: "Resource cannot satisfy the declared response schema.",
        detail: responseError,
      },
      "Response validation prevented mutation",
    );
  if (op.behavior === "create" && !rule?.action) {
    await c.query("INSERT INTO resources VALUES($1,$2,$3,$4)", [
      session.id,
      kind,
      value.id,
      value,
    ]);
    await c.query(
      "UPDATE simulation_sessions SET counter=counter+1 WHERE id=$1",
      [session.id],
    );
  } else if (rule?.action || ["update", "replace"].includes(op.behavior))
    await c.query(
      "UPDATE resources SET data=$1 WHERE session_id=$2 AND kind=$3 AND id=$4",
      [value, session.id, kind, rid],
    );
  else if (op.behavior === "delete")
    await c.query(
      "DELETE FROM resources WHERE session_id=$1 AND kind=$2 AND id=$3",
      [session.id, kind, rid],
    );
  const status =
    rule?.failure?.phase === "after" ? rule.failure.status : op.status;
  const data =
    rule?.failure?.phase === "after"
      ? { error: "Simulated failure after committed mutation." }
      : response;
  if (cacheKey)
    await c.query("INSERT INTO idempotent_results VALUES($1,$2,$3,$4,$5)", [
      session.id,
      cacheKey,
      requestHash,
      status,
      data ?? null,
    ]);
  return log(
    status,
    data,
    rule?.failure?.phase === "after"
      ? "Scenario failure after mutation"
      : rule?.action
        ? `Transitioned ${rule.action.field} to ${rule.action.to}`
        : `Executed ${op.behavior}`,
  );
}
