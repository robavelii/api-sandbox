# Delivery roadmap and release gates

## PR 1 — Repository rules

Branch conventions, authorship policy, PR template, and automated policy checks. Main branch protection requires a repository administrator to enable: require PRs, require `policy` and (after foundation lands) `test`, block force pushes/deletions, and require branches up to date. The connected integration cannot change protection settings (GitHub returns 403). Do not merge PRs automatically.

## PR 2 — SaaS foundation

Next.js, NestJS/Fastify, shared compiler, PostgreSQL migrations, cookie accounts, organization scoping, hashed sandbox keys, explicit mapping approval, isolated sessions, persistent CRUD, reset, deterministic IDs, simple failures/delays, logs, and atomic quotas. CI runs unit/integration tests and builds. The foundation intentionally uses a single API process for control and execution; separate runtime deployment remains a release gate.

## Subsequent feature PRs, in order

1. **feat/scenario-engine**: implemented in PR 4 with versioned typed rules, approved custom transitions, bounded deterministic schema generation, controlled clocks, immutable configuration versions, idempotency policies, and before/after-mutation failure semantics. PostgreSQL tests cover replay, malformed rules, reset, version isolation, and concurrency.
2. **feat/durable-webhooks**: implemented with a transactional event outbox and isolated worker, delayed signed deliveries, bounded retries/replay, encrypted signing secrets, and egress isolation with DNS pinning plus redirect revalidation. Tests cover expired worker leases, duplicate fanout, delayed availability, signatures, retries, replay, and private/reserved address rejection. Delayed state transitions remain separate future work; this phase delays event delivery after an atomic transition.
3. **feat/ai-scenario-proposals**: structured generation, deterministic validation and one repair pass, provenance evidence, explicit approval, provider configuration, usage budgets, and operation without AI. No runtime model calls or arbitrary generated code.
4. **feat/organization-access**: verified email and recovery, invitations/roles, session management, platform API keys, retention jobs, audit events, and distributed abuse protection. Add cross-tenant tests for every new endpoint.
5. **feat/billing**: select a merchant-of-record provider, signed/idempotent subscription webhook handling, checkout and cancellation, entitlement updates and grace periods. Test against provider sandbox; never label a mocked checkout as live billing.
6. **chore/production-deployment**: separate runtime, control-plane and worker workloads; managed PostgreSQL/Redis/object storage; TLS, secrets, backups/restore drill, observability and alerting; load and isolation testing. Configure provider accounts before claiming hosting is available.

## Pilot release gate

Design partners must complete contract import, behavior review, a persistent journey, repeatable reset, injected failure, and delayed webhook inspection independently. Ship a hosted pilot only after all release gates above pass, including response/parameter coverage documentation, security review, recovery tests, runtime quota/load checks, and operational ownership. CLI portability and full OpenAPI compliance are later work, not current claims.
