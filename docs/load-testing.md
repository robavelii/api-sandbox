# Runtime load testing

The load harness exercises the real Fastify handlers and PostgreSQL transactions without TCP server noise. It creates a uniquely named schema, runs migrations there, generates two organizations and several independent sessions, and removes the schema and all workload connections in `finally` cleanup.

Run the smoke profile against a disposable PostgreSQL database:

```sh
LOAD_TEST_DATABASE_URL=postgresql://spectwin:password@localhost:5432/spectwin_load npm run test:load:smoke
```

The nightly profile increases sessions, concurrency, creates, idempotent retries, and reads:

```sh
LOAD_TEST_DATABASE_URL=postgresql://spectwin:password@localhost:5432/spectwin_load npm run test:load:nightly
```

Each run writes `artifacts/load/<profile>.json`. The report includes request counts, duration, throughput, heap growth, global latency percentiles, and per-operation p95 latency. GitHub uploads it for 14 days.

The smoke profile is a regression gate for runtime PRs. Its deliberately broad p95, total-duration, and heap budgets are intended to detect deadlocks, accidental serialization across sessions, connection leaks, unbounded growth, or order-of-magnitude regressions on shared CI runners. They are not production service-level objectives. The nightly profile increases coverage while retaining broad thresholds to avoid runner-noise failures.

The harness verifies that:

- concurrent creates remain unique inside each session;
- session resource counts remain isolated under concurrent traffic;
- concurrent retries with one idempotency key produce one stored result;
- a sandbox key from another organization cannot access the target runtime;
- a user from another organization cannot access target control-plane routes;
- every request completes with the expected status;
- the workload pool closes and leaves no PostgreSQL connections behind.

Use deployed-environment load tests, representative payload sizes, production network paths, and a dedicated environment before setting real capacity or latency objectives. Do not point this harness at a database containing data you need: although it only drops its generated schema, it creates users and application state inside that schema for the duration of the run.
