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
  src/          checkout used by bin/check and manual deploys
  deploy-src/   checkout used only by automatic deploys
  backups/      pg_dump before each migration, newest 14 kept
  logs/         automatic deploy logs, newest 30 kept
  bin/check     runs the CI gates in a capped container
  bin/deploy-main  forced command for the GitHub deploy key
```

## Environment file

`/opt/spectwin/.env`:

```sh
POSTGRES_PASSWORD=<random>
DATABASE_URL=<postgresql URL for user spectwin at host postgres, database spectwin, using that password>
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

Merging to `main` deploys automatically. When CI succeeds on a push to `main`, `.github/workflows/deploy.yml` (environment `staging`, restricted to `main`) connects with a dedicated SSH key and sends the commit SHA. On the server, that key's `authorized_keys` entry is `restrict,command="/opt/spectwin/bin/deploy-main"`: it allows no shell, forwarding or other commands. The forced command (`deploy/deploy-main.sh`, installed by hand) does the following:

1. Fetches `main` from GitHub itself.
2. Refuses any commit that is not on `main`.
3. Deploys from its own checkout, `/opt/spectwin/deploy-src`.
4. Runs `deploy/deploy.sh` detached under `/opt/spectwin/deploy.lock` and streams the log back.

A cancelled or disconnected run never interrupts a migration, and overlapping deploys wait their turn. Logs are kept in `/opt/spectwin/logs` (newest 30). Run the workflow manually from the Actions tab to redeploy.

| GitHub `staging` environment | Value                                                       |
| ---------------------------- | ----------------------------------------------------------- |
| secret `DEPLOY_SSH_KEY`      | private half of the restricted key (never stored elsewhere) |
| secret `DEPLOY_KNOWN_HOSTS`  | the host's ed25519 key, so the runner cannot be redirected  |
| variable `DEPLOY_TARGET`     | `ubuntu@<host>`                                             |

`deploy/deploy-main.sh` changes take effect only after it is copied to `/opt/spectwin/bin/deploy-main` on the server. To revoke CI deploys, delete the `spectwin-github-deploy` line from `~ubuntu/.ssh/authorized_keys`.

Manual deploy of a branch (for example before merging):

```sh
git push oci <branch>                    # from a workstation
ssh ubuntu@<host>
cd /opt/spectwin/src && git fetch -q origin && git checkout --detach origin/<branch>
deploy/deploy.sh
```

Avoid running a manual deploy while an automatic one holds the lock.

The script builds `spectwin:<commit>`, backs up the database if it exists, runs migrations, waits for healthy `api`, `worker` and `web`, then installs the Caddy site. It installs the site only if `caddy validate` passes, and restores the previous file otherwise. It keeps the three newest SpecTwin images and never prunes anything else.

Rollback: `SPECTWIN_IMAGE_TAG=<older> docker compose --project-name spectwin -f deploy/compose.yaml up -d api worker web`, run from the checkout with the env file sourced. Migrations are forward-only, so restore from `backups/` if a migration must be undone.

## Not yet covered

Off-host backups and a restore drill, monitoring and alerting, log retention beyond Caddy's rotation, and a separate runtime workload. Configure `RESEND_API_KEY` before relying on email verification or recovery.
