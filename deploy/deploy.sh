#!/usr/bin/env bash
# Build and roll out SpecTwin on the shared host. Touches only the "spectwin" compose
# project, /opt/spectwin and /etc/caddy/sites/spectwin.caddy.
# Usage: deploy/deploy.sh   (run from the checkout to deploy, on the server)
set -euo pipefail

ROOT=/opt/spectwin
ENV_FILE="$ROOT/.env"
SITE=/etc/caddy/sites/spectwin.caddy
COMPOSE=(docker compose --project-name spectwin -f deploy/compose.yaml)
cd "$(git rev-parse --show-toplevel)"

[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE; see docs/deployment.md"; exit 1; }
[[ "$(stat -c %a "$ENV_FILE")" == 600 ]] || { echo "$ENV_FILE must be mode 600"; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
: "${POSTGRES_PASSWORD:?}" "${WEBHOOK_ENCRYPTION_KEY:?}" "${WEB_ORIGIN:?}" "${NEXT_PUBLIC_RUNTIME_URL:?}"

export SPECTWIN_IMAGE_TAG
SPECTWIN_IMAGE_TAG="$(git rev-parse --short=12 HEAD)"
export SPECTWIN_ENV_FILE="$ENV_FILE"
echo "== building spectwin:$SPECTWIN_IMAGE_TAG"
docker build --build-arg NEXT_PUBLIC_RUNTIME_URL="$NEXT_PUBLIC_RUNTIME_URL" \
  -t "spectwin:$SPECTWIN_IMAGE_TAG" .

"${COMPOSE[@]}" up -d --wait postgres
if [[ -n "$("${COMPOSE[@]}" exec -T postgres psql -U spectwin -d spectwin -tAc \
  "SELECT 1 FROM information_schema.tables WHERE table_name='schema_migrations'")" ]]; then
  mkdir -p "$ROOT/backups"
  backup="$ROOT/backups/spectwin-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  "${COMPOSE[@]}" exec -T postgres pg_dump -U spectwin -d spectwin | gzip > "$backup"
  chmod 600 "$backup"
  echo "== backup $backup"
  ls -1t "$ROOT"/backups/spectwin-*.sql.gz | tail -n +15 | xargs -r rm --
fi

echo "== migrating"
"${COMPOSE[@]}" --profile migrate run --rm migrate
echo "== starting"
"${COMPOSE[@]}" up -d --wait --remove-orphans api worker web

# The Caddy instance is shared: never leave an invalid site file behind for other apps' reloads.
# Without DNS, Caddy would retry certificate issuance and hit ACME failure limits.
host="$(sed -n 's/^\([a-z0-9.-]*\.[a-z]*\) {$/\1/p' deploy/spectwin.caddy | head -1)"
if ! getent hosts "$host" >/dev/null; then
  echo "== $host does not resolve; Caddy site not installed (loopback only)"
elif ! sudo cmp -s deploy/spectwin.caddy "$SITE"; then
  previous="$(mktemp)"
  had_previous=false
  if sudo test -f "$SITE"; then sudo cp "$SITE" "$previous"; had_previous=true; fi
  sudo install -m 644 deploy/spectwin.caddy "$SITE"
  if ! sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    if $had_previous; then sudo install -m 644 "$previous" "$SITE"; else sudo rm -f "$SITE"; fi
    rm -f "$previous"
    echo "Caddy rejected spectwin.caddy; previous site restored, Caddy not reloaded."
    exit 1
  fi
  rm -f "$previous"
  sudo systemctl reload caddy
  echo "== caddy site updated and reloaded"
fi
curl -fsS http://127.0.0.1:4100/health >/dev/null

# Keep the three newest SpecTwin images; never prune anything else on the host.
docker image ls spectwin --format '{{.Tag}}' | grep -vx "$SPECTWIN_IMAGE_TAG" |
  tail -n +3 | xargs -r -I{} docker image rm "spectwin:{}" >/dev/null || true
echo "== spectwin:$SPECTWIN_IMAGE_TAG deployed"
