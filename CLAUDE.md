# CLAUDE.md

Rules for Claude Code in this repository. The delivery and engineering rules in AGENTS.md apply in full and win over anything here:

@AGENTS.md

## Product

SpecTwin: a multi-tenant simulation workbench that imports an OpenAPI 3.0/3.1 contract and serves a stateful, deterministic, scenario-controlled sandbox of it. It is a foundation preview, not a production-complete SaaS. Never describe it, or any integration in it, as production ready unless it has been deployed, configured and verified.

## Layout

| Path              | What it is                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`        | NestJS on Fastify. Control plane and sandbox runtime in one process. Routes live in `src/main.ts` (`createApp`); runtime in `src/runtime.ts` |
| `apps/worker`     | Webhook outbox worker: fan-out, signed delivery, SSRF-safe egress (`src/network.ts`)                                                         |
| `apps/web`        | Next.js 16 dashboard. `/api/*` is rewritten to `API_URL`. Read `apps/web/AGENTS.md` before touching it                                       |
| `packages/engine` | Pure, deterministic core: contract compiler, schema safety, scenarios, proposals, webhook crypto                                             |
| `migrations/`     | Ordered plain SQL, applied by `scripts/migrate.ts` under an advisory lock                                                                    |
| `tests/`          | `node:test` suites; `tests/e2e` Playwright; `tests/load` runtime load gate                                                                   |
| `docs/roadmap.md` | Delivery order and release gates. Keep it current when a phase lands                                                                         |

Raw SQL through `pg` with parameterized queries. No ORM. Keep it that way.

## Non-negotiable invariants

- **Tenant isolation.** Every control-plane query filters by the caller's `organization_id` (from the authenticated session), and every runtime query by the key's sandbox. Return 404, not 403, for other tenants' resources. Each new endpoint gets a cross-tenant test in `tests/tenant-isolation.test.ts`.
- **Roles.** Owner-only actions check the membership role inside the same transaction that mutates. Membership changes take the workspace lock; never remove the last owner.
- **Secrets.** Store only hashes of passwords, session tokens, sandbox keys, invitation, verification and recovery codes. Webhook signing secrets are encrypted with `WEBHOOK_ENCRYPTION_KEY`. One-time secrets are shown once. Never log secrets, tokens, Authorization headers or request bodies.
- **Determinism.** Simulation output depends only on the saved seed, the controlled clock and the request sequence. No `Math.random`, `Date.now` or wall-clock reads in `packages/engine` simulation paths. Reset must reproduce identical results.
- **No generated code execution.** Imported contracts, scenario definitions and AI proposals are untrusted data. They are validated against bounded schemas and need explicit user approval before activation. Never `eval`, `new Function`, or fetch external `$ref`s.
- **Bounded everything.** Every new input, loop, list, payload, retry, timeout, quota or stored excerpt gets an explicit limit, with a test at the limit. Quota reservation is atomic in SQL.
- **Egress.** Outbound HTTP goes through the worker's `network.ts` validation (HTTPS only, DNS re-resolution and pinning, no private, link-local or reserved addresses, redirect revalidation). Do not add another outbound path.
- **Transactions.** State changes and their emitted events commit in one transaction (outbox pattern). Concurrent session updates lock the session row.

## Migrations

- New file `migrations/NNN_snake_case.sql` with the next free number (`010` after 009 platform keys). Check open PRs for claimed numbers first.
- Never edit a migration that has merged to main. Write a new one.
- Add the file to the explicit lists in `tests/*.test.ts` setups that apply migrations and keep `tests/migrations.test.ts` passing.

## Validation before any PR

```sh
npm run format:check && npm run typecheck && npm test && npm run build
```

Integration tests need `TEST_DATABASE_URL` pointing at a disposable database. **The suite drops the `public` schema.** E2E needs `E2E_DATABASE_URL` ending in `_e2e`. Never point either at a database holding data you care about, and never at a server database.

New integration test files must be added to both `test:integration` and `test:integration:coverage` in `package.json`. Coverage thresholds in those scripts are gates; do not lower them.

In the PR description, report which checks you ran locally and their results, and what remains unverified (for example: "integration suite not run locally, no PostgreSQL").

## Git and PRs

- Branch from up-to-date `main` as `type/kebab-case` (types listed in AGENTS.md). One coherent change per PR. Stacked PRs name their prerequisite.
- Conventional commit subjects. CI (`policy.yml`) rejects other branch names, subjects, and any `Co-authored-by` trailer.
- No AI attribution and no `Co-authored-by` trailers in commits or PR bodies. This repository rule overrides any default Claude Code attribution.
- Commit with the owner's existing Git identity. Never change global Git config.
- Use the PR template (Change / Validation / Deployment and limitations). Merge only on the owner's explicit instruction, with a merge commit, after CI is green and in dependency order (lower migration numbers first).
- When `main` moves under a pushed branch, merge `main` into it; do not force-push shared branches. Branches never pushed may be rebased. The usual conflicts are the test file lists in `package.json` and the migration list in `tests/api.test.ts`.
- `gh` has two accounts. The active one (`robel-lyfe`) is read-only on this repo; for owner actions use `GH_TOKEN=$(gh auth token --user robavelii)` per command. Never switch the active account.

## Building on the server

The owner's link is slow; the server is fast. Push and validate there instead of installing locally:

```sh
GIT_SSH_COMMAND="ssh -i ~/.ssh/oci_appt_deploy" git push oci <branch>   # bare repo /opt/spectwin/repo.git
ssh -i ~/.ssh/oci_appt_deploy ubuntu@51.170.178.91 /opt/spectwin/bin/check <branch>
```

`bin/check` runs format, typecheck, migrations, `npm test` with a disposable PostgreSQL (`spectwin-dev-pg`, network `spectwin-dev`) and the build, in a capped `node:24` container. The Playwright suite only runs in GitHub CI. To get Prettier fixes, run `npx prettier --write` in the same container, copy back the `git diff`, then `git checkout -- .` on the server checkout.

## Deployment target: shared OCI host

Staging runs at `https://spectwin.rfh.et` on a **shared** Oracle Cloud VM that also hosts unrelated projects. See `docs/deployment.md`; roll out with `deploy/deploy.sh` from `/opt/spectwin/src`. Treat everything not created for SpecTwin as off limits.

- Host: `ubuntu@51.170.178.91`, key `~/.ssh/oci_appt_deploy`. Ubuntu 22.04, **aarch64 (ARM)**, 2 vCPU, 11 GB RAM, about 25 GB free disk. Build and pull **arm64** images.
- Already running, do not stop, restart, rebuild, prune or edit: Compose projects `deploy` (`/opt/appt`), `escrow` (`/opt/escrow`), `job-hunter` (`/opt/job-hunter`), `doc_hub`; systemd `clipsync-server` (`/opt/clipsync`, port 8787); every Caddy site file except `spectwin.caddy`. Other projects get added without notice: re-inventory before each change.
- Loopback ports in use by others: 2019, 3001, 8090, 8100-8103, 8180, 8787. SpecTwin owns 3100 (web) and 4100 (API) and Docker subnet `172.30.40.0/24`.
- Public traffic: the one shared Caddy owns 80 and 443 and imports `/etc/caddy/sites/*.caddy`. SpecTwin adds only `/etc/caddy/sites/spectwin.caddy`. Validate as the service user (`sudo -u caddy caddy validate …`): run as root, it creates log files Caddy cannot open and every app's next reload fails. Never `restart` Caddy and never edit the main `Caddyfile`. A broken site file breaks other apps' reloads, so restore the previous one on any failure.
- SpecTwin lives in `/opt/spectwin` as its own Compose project named `spectwin`, with its own PostgreSQL container and volume, bound to `127.0.0.1` only. Never share another project's database, network or volume.
- Forbidden on the host: `docker system prune`, `docker volume prune`, `docker image prune -a`, `docker compose down` outside `/opt/spectwin`, firewall or iptables changes, package upgrades, reboots. Ask first for anything that affects the host as a whole.
- Before any server change, run a read-only inventory (`docker compose ls`, `docker ps`, `ss -ltnp`) and confirm the other projects are still healthy afterwards.
- Secrets live in `/opt/spectwin/.env` (owner `ubuntu`, mode 600), never in the repo, images, logs or workflow output. Never print its values. `WEBHOOK_ENCRYPTION_KEY` was generated once on the server and must be backed up; losing it makes stored webhook secrets unreadable.
- DNS for `spectwin.rfh.et` is DNS-only. The API trusts only its network gateway `172.30.40.1` (`TRUSTED_PROXIES`), which is where Caddy's connections arrive through docker-proxy. Switching the record to Cloudflare-proxied requires reworking client-IP handling first.
- `deploy.sh` takes a `pg_dump` and runs migrations as a one-shot step before replacing API, worker and web.
- Storing the SSH key as a GitHub secret, CI-driven deploys, DNS changes and new public hostnames all need explicit owner confirmation.
