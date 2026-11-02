import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { createApp } from "../../apps/api/src/main.js";

type InjectResult = { status: number; data: any; cookie: string };
type Measurement = { operation: string; durationMs: number; status: number };

const profiles = {
  smoke: {
    sessions: 4,
    creates: 48,
    idempotentRequests: 32,
    reads: 160,
    concurrency: 12,
    p95Ms: 750,
    maxRunMs: 20_000,
    maxHeapGrowthMb: 128,
  },
  nightly: {
    sessions: 10,
    creates: 800,
    idempotentRequests: 400,
    reads: 4_000,
    concurrency: 50,
    p95Ms: 1_500,
    maxRunMs: 120_000,
    maxHeapGrowthMb: 384,
  },
} as const;

const profileName =
  process.env.LOAD_PROFILE === "nightly" ? "nightly" : "smoke";
const profile = profiles[profileName];
const connectionString = process.env.LOAD_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "LOAD_TEST_DATABASE_URL is required. The harness creates and removes its own schema in that database.",
  );
}

const runId = `spectwin_load_${process.pid}_${Date.now()}`;
const applicationName = `${runId}_${profileName}`;
const admin = new Pool({
  connectionString,
  application_name: `${applicationName}_admin`,
});
const measurements: Measurement[] = [];
const startedAt = performance.now();
const heapBefore = process.memoryUsage().heapUsed;
let workload: Pool | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${label} exceeded the 15 second deadlock timeout`),
            ),
          15_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function percentile(values: number[], percentileValue: number) {
  const ordered = [...values].sort((a, b) => a - b);
  return (
    ordered[
      Math.min(ordered.length - 1, Math.floor(ordered.length * percentileValue))
    ] ?? 0
  );
}

async function boundedMap<T, R>(
  values: T[],
  concurrency: number,
  operation: string,
  work: (value: T, index: number) => Promise<R & { status: number }>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        const start = performance.now();
        const result = await work(values[index], index);
        measurements.push({
          operation,
          durationMs: performance.now() - start,
          status: result.status,
        });
        output[index] = result;
      }
    }),
  );
  return output;
}

try {
  await admin.query(`CREATE SCHEMA ${runId}`);
  workload = new Pool({
    connectionString,
    options: `-c search_path=${runId} -c statement_timeout=15000 -c lock_timeout=5000`,
    application_name: applicationName,
    max: profile.concurrency + 4,
  });
  await workload.query(await readFile("migrations/001_foundation.sql", "utf8"));
  await workload.query(await readFile("migrations/002_scenarios.sql", "utf8"));
  app = await createApp(workload);
  const server = app.getHttpAdapter().getInstance();

  async function request(
    path: string,
    method: any = "GET",
    data?: any,
    cookie = "",
    key = "",
    session = "",
    idempotencyKey = "",
  ): Promise<InjectResult> {
    const response = await withTimeout(
      server.inject({
        url: path,
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(session ? { "x-spectwin-session": session } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(data === undefined ? {} : { payload: data }),
      }),
      `${method} ${path}`,
    );
    return {
      status: response.statusCode,
      data: response.body ? JSON.parse(response.body) : undefined,
      cookie: String(response.headers["set-cookie"] || "").split(";")[0],
    };
  }

  const owner = await request("/api/auth/register", "POST", {
    email: `${runId}@example.com`,
    password: "load-test-password",
  });
  assert.equal(owner.status, 201);
  const outsider = await request("/api/auth/register", "POST", {
    email: `${runId}-outsider@example.com`,
    password: "load-test-password",
  });
  assert.equal(outsider.status, 201);

  const spec = JSON.parse(
    await readFile("apps/web/public/payments.json", "utf8"),
  );
  const created = await request(
    "/api/sandboxes",
    "POST",
    { source: JSON.stringify(spec) },
    owner.cookie,
  );
  assert.equal(created.status, 201);
  const outsiderBox = await request(
    "/api/sandboxes",
    "POST",
    { source: JSON.stringify(spec) },
    outsider.cookie,
  );
  assert.equal(outsiderBox.status, 201);
  await request(
    `/api/sandboxes/${created.data.id}/approve`,
    "POST",
    {},
    owner.cookie,
  );
  await request(
    `/api/sandboxes/${outsiderBox.data.id}/approve`,
    "POST",
    {},
    outsider.cookie,
  );

  const sessionNames = ["default"];
  for (let index = 1; index < profile.sessions; index++) {
    const name = `load-${index}`;
    const session = await request(
      `/api/sandboxes/${created.data.id}/sessions`,
      "POST",
      { name },
      owner.cookie,
    );
    assert.equal(session.status, 201);
    sessionNames.push(name);
  }
  const runtimePath = `/sandbox/${created.data.id}`;

  const creates = await boundedMap(
    Array.from({ length: profile.creates }, (_, index) => index),
    profile.concurrency,
    "create",
    async (index) => {
      const session = sessionNames[index % sessionNames.length];
      const response = await request(
        `${runtimePath}/payments`,
        "POST",
        { amount: index + 1, currency: "USD" },
        "",
        created.data.apiKey,
        session,
      );
      return { ...response, session };
    },
  );
  assert.ok(creates.every((response) => response.status === 201));
  for (const session of sessionNames) {
    const rows = await request(
      `${runtimePath}/payments`,
      "GET",
      undefined,
      "",
      created.data.apiKey,
      session,
    );
    assert.equal(rows.status, 200);
    assert.equal(
      rows.data.length,
      creates.filter((response) => response.session === session).length,
    );
    assert.equal(
      new Set(rows.data.map((row: any) => row.id)).size,
      rows.data.length,
    );
  }

  const idempotent = await boundedMap(
    Array.from({ length: profile.idempotentRequests }),
    profile.concurrency,
    "idempotent-create",
    async () =>
      request(
        `${runtimePath}/payments`,
        "POST",
        { amount: 999, currency: "USD" },
        "",
        created.data.apiKey,
        "default",
        "shared-load-key",
      ),
  );
  assert.ok(idempotent.every((response) => response.status === 201));
  assert.equal(new Set(idempotent.map((response) => response.data.id)).size, 1);
  assert.ok(
    idempotent.every(
      (response) =>
        response.data.amount === 999 && response.data.currency === "USD",
    ),
  );

  const sampleIds = new Map<string, string>();
  for (const response of creates) {
    if (!sampleIds.has(response.session))
      sampleIds.set(response.session, response.data.id);
  }
  const reads = await boundedMap(
    Array.from({ length: profile.reads }, (_, index) => index),
    profile.concurrency,
    "retrieve",
    async (index) => {
      const session = sessionNames[index % sessionNames.length];
      return request(
        `${runtimePath}/payments/${sampleIds.get(session)}`,
        "GET",
        undefined,
        "",
        created.data.apiKey,
        session,
      );
    },
  );
  assert.ok(reads.every((response) => response.status === 200));

  const defaultSession = (
    await request(
      `/api/sandboxes/${created.data.id}/sessions`,
      "GET",
      undefined,
      owner.cookie,
    )
  ).data.find((session: any) => session.name === "default");
  const createResetRace = await Promise.all([
    ...Array.from({ length: 20 }, (_, index) =>
      request(
        `${runtimePath}/payments`,
        "POST",
        { amount: 2_000 + index, currency: "USD" },
        "",
        created.data.apiKey,
        "default",
      ),
    ),
    request(
      `/api/sandboxes/${created.data.id}/sessions/${defaultSession.id}/reset`,
      "POST",
      {},
      owner.cookie,
    ),
  ]);
  assert.ok(
    createResetRace.every((response) => [200, 201].includes(response.status)),
  );

  const createConfigureRace = await Promise.all([
    ...Array.from({ length: 20 }, (_, index) =>
      request(
        `${runtimePath}/payments`,
        "POST",
        { amount: 3_000 + index, currency: "USD" },
        "",
        created.data.apiKey,
        "default",
      ),
    ),
    request(
      `/api/sandboxes/${created.data.id}/sessions/${defaultSession.id}/configure`,
      "POST",
      { versionId: created.data.id },
      owner.cookie,
    ),
  ]);
  assert.ok(
    createConfigureRace.every((response) =>
      [200, 201].includes(response.status),
    ),
  );

  const clockCreateRace = await Promise.all([
    ...Array.from({ length: 10 }, (_, index) =>
      request(
        `${runtimePath}/payments`,
        "POST",
        { amount: 4_000 + index, currency: "USD" },
        "",
        created.data.apiKey,
        "default",
      ),
    ),
    ...Array.from({ length: 10 }, () =>
      request(
        `/api/sandboxes/${created.data.id}/sessions/${defaultSession.id}/clock`,
        "POST",
        { advanceMs: 1_000 },
        owner.cookie,
      ),
    ),
  ]);
  assert.ok(
    clockCreateRace.every((response) => [200, 201].includes(response.status)),
  );
  const sessionsAfterClockRace = await request(
    `/api/sandboxes/${created.data.id}/sessions`,
    "GET",
    undefined,
    owner.cookie,
  );
  assert.equal(
    new Date(
      sessionsAfterClockRace.data.find(
        (session: any) => session.name === "default",
      ).clock,
    ).toISOString(),
    "2026-01-01T00:00:10.000Z",
  );
  await request(
    `/api/sandboxes/${created.data.id}/sessions/${defaultSession.id}/reset`,
    "POST",
    {},
    owner.cookie,
  );
  const deterministicAfterRaces = await request(
    `${runtimePath}/payments`,
    "POST",
    { amount: 1, currency: "USD" },
    "",
    created.data.apiKey,
    "default",
  );
  assert.equal(deterministicAfterRaces.status, 201);
  assert.equal(deterministicAfterRaces.data.id, "pay_000001");

  const sessionLimitRace = await Promise.all(
    Array.from({ length: 15 }, (_, index) =>
      request(
        `/api/sandboxes/${outsiderBox.data.id}/sessions`,
        "POST",
        { name: `limit-${index}` },
        outsider.cookie,
      ),
    ),
  );
  assert.equal(
    sessionLimitRace.filter((response) => response.status === 201).length,
    9,
  );
  assert.equal(
    sessionLimitRace.filter((response) => response.status === 429).length,
    6,
  );

  const sandboxLimitRace = await Promise.all(
    Array.from({ length: 8 }, () =>
      request(
        "/api/sandboxes",
        "POST",
        { source: JSON.stringify(spec) },
        owner.cookie,
      ),
    ),
  );
  assert.equal(
    sandboxLimitRace.filter((response) => response.status === 201).length,
    4,
  );
  assert.equal(
    sandboxLimitRace.filter((response) => response.status === 429).length,
    4,
  );

  const crossTenantRuntime = await request(
    `${runtimePath}/payments`,
    "GET",
    undefined,
    "",
    outsiderBox.data.apiKey,
  );
  assert.equal(crossTenantRuntime.status, 401);
  const crossTenantControl = await request(
    `/api/sandboxes/${created.data.id}/sessions`,
    "GET",
    undefined,
    outsider.cookie,
  );
  assert.equal(crossTenantControl.status, 404);

  const currentUsage = await workload.query(
    "SELECT requests FROM monthly_usage WHERE organization_id=$1",
    [owner.data.organization_id],
  );
  const quotaSuccesses = 20;
  await workload.query(
    "UPDATE organizations SET request_limit=$1 WHERE id=$2",
    [
      currentUsage.rows[0].requests + quotaSuccesses,
      owner.data.organization_id,
    ],
  );
  const quotaBoundary = await boundedMap(
    Array.from({ length: 30 }),
    profile.concurrency,
    "quota-boundary",
    async () =>
      request(
        `${runtimePath}/payments/pay_000001`,
        "GET",
        undefined,
        "",
        created.data.apiKey,
        "default",
      ),
  );
  assert.equal(
    quotaBoundary.filter((response) => response.status === 200).length,
    20,
  );
  assert.equal(
    quotaBoundary.filter((response) => response.status === 429).length,
    10,
  );

  const durationMs = performance.now() - startedAt;
  const heapGrowthMb =
    (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
  const successfulDurations = measurements
    .filter((measurement) => measurement.status < 400)
    .map((measurement) => measurement.durationMs);
  const report = {
    profile: profileName,
    runId,
    requests: measurements.length,
    concurrency: profile.concurrency,
    durationMs: Number(durationMs.toFixed(2)),
    throughputPerSecond: Number(
      (measurements.length / (durationMs / 1000)).toFixed(2),
    ),
    latencyMs: {
      p50: Number(percentile(successfulDurations, 0.5).toFixed(2)),
      p95: Number(percentile(successfulDurations, 0.95).toFixed(2)),
      p99: Number(percentile(successfulDurations, 0.99).toFixed(2)),
      max: Number(Math.max(...successfulDurations).toFixed(2)),
    },
    heapGrowthMb: Number(heapGrowthMb.toFixed(2)),
    operations: Object.fromEntries(
      [
        ...new Set(measurements.map((measurement) => measurement.operation)),
      ].map((operation) => {
        const values = measurements
          .filter((measurement) => measurement.operation === operation)
          .map((measurement) => measurement.durationMs);
        return [
          operation,
          {
            count: values.length,
            p95Ms: Number(percentile(values, 0.95).toFixed(2)),
          },
        ];
      }),
    ),
  };
  await mkdir("artifacts/load", { recursive: true });
  await writeFile(
    `artifacts/load/${profileName}.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));

  assert.ok(
    report.latencyMs.p95 <= profile.p95Ms,
    `p95 ${report.latencyMs.p95}ms exceeds ${profile.p95Ms}ms budget`,
  );
  assert.ok(
    durationMs <= profile.maxRunMs,
    `run ${durationMs.toFixed(0)}ms exceeds ${profile.maxRunMs}ms budget`,
  );
  assert.ok(
    heapGrowthMb <= profile.maxHeapGrowthMb,
    `heap growth ${heapGrowthMb.toFixed(2)}MB exceeds ${profile.maxHeapGrowthMb}MB budget`,
  );
} finally {
  if (app) await app.close();
  if (workload) await workload.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${runId} CASCADE`);
  const remaining = await admin.query(
    "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1",
    [applicationName],
  );
  assert.equal(
    remaining.rows[0].count,
    0,
    "workload PostgreSQL connections leaked",
  );
  await admin.end();
}
