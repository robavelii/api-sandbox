# Staging deployment on the shared OCI host

SpecTwin staging runs at `https://spectwin.rfh.et` on a shared ARM64 VM. Other projects run on that host too. This deployment owns only the `spectwin` compose project, `/opt/spectwin` and `/etc/caddy/sites/spectwin.caddy`. This is a staging preview, not a production release; the roadmap's production gates still apply.

## Topology

| Component  | Where                                      | Notes                                        |
| ---------- | ------------------------------------------ | -------------------------------------------- |
| Caddy      | host, shared                               | TLS for `spectwin.rfh.et`; DNS-only A record |
| `api`      | container, `127.0.0.1:4100`                | `/api/*`, `/sandbox/*`, `/health`            |
| `web`      | container, `127.0.0.1:3100`                | every other path                             |
| `worker`   | container                                  | webhook delivery, no ports                   |
| `postgres` | container, volume `spectwin_postgres-data` | no published port                            |
| `migrate`  | one-shot container                         | runs before each rollout                     |

All containers share the `spectwin` network (`172.30.40.0/24`). Caddy reaches the API through docker-proxy, which connects from the gateway `172.30.40.1`. That gateway is the API's only trusted proxy (`TRUSTED_PROXIES`), so login rate limits apply per real client IP. Caddy replaces client-sent `X-Forwarded-For`. If the hostname is ever proxied through Cloudflare, rate limiting must be reconfigured first.

One image built from the repository `Dockerfile` serves all four app roles. Resource limits in `deploy/compose.yaml` keep SpecTwin from starving the host's other services.

## Server layout

```
/opt/spectwin/
  .env          secrets, owner ubuntu, mode 600, never committed
  repo.git      bare repository; push to it over SSH
  src/          checkout used by bin/check and deploy
  backups/      pg_dump before each migration, newest 14 kept
  bin/check     runs the CI gates in a capped container
```

## Environment file

`/opt/spectwin/.env`:

```sh
POSTGRES_PASSWORD=<random>
WEBHOOK_ENCRYPTION_KEY=<openssl rand -base64 32; back this up, never rotate without a migration>
WEB_ORIGIN=https://spectwin.rfh.et
NEXT_PUBLIC_RUNTIME_URL=https://spectwin.rfh.et
# Optional. Without them, email verification and AI proposals are unavailable.
RESEND_API_KEY=
VERIFICATION_FROM=
OPENAI_API_KEY=
PROPOSAL_MODEL=gpt-4.1-mini
```

## Rolling out

```sh
git push oci <branch>                    # from a workstation
ssh ubuntu@<host>
cd /opt/spectwin/src && git fetch -q origin && git checkout --detach origin/main
deploy/deploy.sh
```

The script builds `spectwin:<commit>`, backs up the database if it exists, runs migrations, waits for healthy `api`, `worker` and `web`, then installs the Caddy site. It installs the site only if `caddy validate` passes, and restores the previous file otherwise. It keeps the three newest SpecTwin images and never prunes anything else.

Rollback: `SPECTWIN_IMAGE_TAG=<older> docker compose --project-name spectwin -f deploy/compose.yaml up -d api worker web`, run from the checkout with the env file sourced. Migrations are forward-only, so restore from `backups/` if a migration must be undone.

## Not yet covered

Off-host backups and a restore drill, monitoring and alerting, log retention beyond Caddy's rotation, a separate runtime workload, and CI-driven deploys. Configure `RESEND_API_KEY` before relying on email verification or recovery.
