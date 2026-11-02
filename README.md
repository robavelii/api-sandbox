# SpecTwin

A simulation workbench for repeatable API integration journeys. This branch delivers the first SaaS foundation: a Next.js dashboard, NestJS/Fastify API, shared contract compiler, and durable PostgreSQL state.

## Run locally

Requires Node.js 24 and Docker (or PostgreSQL 17).

```sh
npm ci
cp .env.example .env
docker compose up -d
node --env-file=.env --import tsx scripts/migrate.ts
```

Start these in separate terminals:

```sh
node --env-file=.env --import tsx apps/api/src/main.ts
npm run dev:web
```

Open http://localhost:3000, create an account with a password of at least 12 characters, and choose **Explore example**. Import the contract, save the one-time sandbox key, review the inferred mappings, and approve them. The default sandbox limit is five per organization; requests are limited to 10,000 per calendar month. Use a key as a Bearer token:

```sh
curl "$BASE_URL/payments" -X POST \
  -H "Authorization: Bearer $SANDBOX_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"amount":2500,"currency":"USD"}'
curl "$BASE_URL/payments/pay_000001" -H "Authorization: Bearer $SANDBOX_KEY"
```

`BASE_URL` is the endpoint shown in the dashboard. Add `X-SpecTwin-Session: ci` after creating a session called `ci` to isolate its state. Reset deletes resources/logs and resets the ID sequence. Rotating a key revokes the prior key immediately.

## Scenario versions

The scenario editor saves immutable definitions. A saved version remains a draft until it is explicitly approved. Selecting an approved version for a session resets that session and pins its resources, logs, rule counters, idempotency history, seed, and controlled clock to the selected version.

Definitions use a bounded JSON format rather than executable code:

```json
{
  "version": 1,
  "name": "Three failures then success",
  "seed": "checkout-ci",
  "clock": "2026-06-01T12:00:00.000Z",
  "idempotency": "replay",
  "rules": [
    {
      "operation": "POST /payments",
      "times": 3,
      "failure": { "phase": "before", "status": 429 }
    }
  ]
}
```

Rules may add a delay of up to five seconds, inject a bounded HTTP failure before or after mutation, or transition one declared item field from an allowed source value to a target value. `times` limits how often a rule applies after each reset. Mutation requests may send an `Idempotency-Key` of 1–128 characters. The `replay` policy returns the saved outcome for an identical request, `conflict` rejects every reused key, and `off` disables idempotency storage. Keys are hashed before storage.

The controlled clock starts at the version's `clock` value and can be advanced through the dashboard. Schema-generated dates use that clock, and generated values use the saved seed. Reset restores the clock, rule counts, deterministic ID sequence, and idempotency history so an identical request sequence produces the same result.

## Validation

```sh
npm run format:check
npm run typecheck
npm test
npm run build
```

The integration suite is enabled by `TEST_DATABASE_URL`. It **drops and recreates the public schema** of that database; use a dedicated disposable database, never development or production data. CI provisions its own database and always runs the integration suite. Without that variable only engine and password tests run.

## Behavior and boundaries

The compiler accepts OpenAPI 3.0/3.1 JSON and YAML, validates inline/local-reference JSON request and response schemas, and never fetches external references. Only declared routes execute. Simple collection/item patterns receive inferred CRUD mappings; users must explicitly approve activation. Custom item actions require an approved transition rule or return 501. Bounded deterministic response generation supports common scalar, object, array, enum, composition, format, example, default, and local-reference shapes. Unsupported constraints fail with 422 before mutation. Pagination envelopes and arbitrary scripts are not supported.

The API stores hashed authentication sessions and sandbox keys. Platform sessions use HttpOnly, SameSite cookies (Secure in production). Every control-plane lookup checks organization membership; runtime keys scope to a sandbox. PostgreSQL transactions lock sessions to serialize concurrent updates, and quotas update atomically. Request logs contain paths and execution metadata, excluding bodies and authorization headers. Avoid sensitive values in URL paths.

This is a foundation preview, not a production-ready complete SaaS. Next steps and release gates are in [docs/roadmap.md](docs/roadmap.md). Before exposing the application, configure HTTPS, a trusted reverse proxy and correct origin/runtime URL, secret management, database backups, monitoring, retention jobs, and abuse controls. `trustProxy` is deliberately disabled; auth rate limiting uses the direct connection IP. Public self-service registration has no email verification or recovery yet. Only one initial organization is exposed per account; collaboration is not implemented.

`WEB_ORIGIN` is the exact public web origin allowed to make credentialed requests. `API_URL` is the server-side Next.js proxy destination. `NEXT_PUBLIC_RUNTIME_URL` is compiled into the dashboard at build time. `DATABASE_URL` is mandatory for the API and migrations. Production builds run with `npm run build`; then run the API with `npm run start -w @spectwin/api` and the web app with `npm run start -w @spectwin/web`, supplying environment variables through your process manager.

## Repository workflow

See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Major development retains the owner's configured Git identity. Small maintenance commits use Codex. Co-author trailers are prohibited. Changes are reviewed through topic branches and PRs.
