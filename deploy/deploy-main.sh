#!/usr/bin/env bash
# Forced command for the GitHub Actions deploy key (installed as /opt/spectwin/bin/deploy-main).
# The client may only name a commit; this deploys GitHub's main and nothing else.
# The deploy runs detached under a lock, so a dropped or cancelled SSH session never
# interrupts a migration, and overlapping requests wait their turn.
set -euo pipefail

ROOT=/opt/spectwin
UPSTREAM=https://github.com/robavelii/api-sandbox.git
CHECKOUT="$ROOT/deploy-src"
requested="${SSH_ORIGINAL_COMMAND:-}"
[[ "$requested" =~ ^[0-9a-f]{40}$ ]] || { echo "Expected a 40-character commit SHA." >&2; exit 2; }

exec 9>"$ROOT/deploy.lock"
echo "== waiting for deploy lock"
flock 9

git -C "$ROOT/repo.git" fetch -q "$UPSTREAM" +refs/heads/main:refs/heads/main
main="$(git -C "$ROOT/repo.git" rev-parse refs/heads/main)"
if [[ "$main" != "$requested" ]]; then
  git -C "$ROOT/repo.git" merge-base --is-ancestor "$requested" "$main" 2>/dev/null ||
    { echo "$requested is not on main." >&2; exit 3; }
  echo "== main has moved on to $main; deploying that instead"
fi

[[ -d "$CHECKOUT/.git" ]] || git clone -q "$ROOT/repo.git" "$CHECKOUT"
git -C "$CHECKOUT" fetch -q origin
git -C "$CHECKOUT" checkout -q --detach "$main"

mkdir -p "$ROOT/logs"
log="$ROOT/logs/deploy-$(date -u +%Y%m%dT%H%M%SZ)-${main:0:12}.log"
cd "$CHECKOUT"
# The child inherits fd 9, so the lock is held until the deploy itself finishes.
setsid -w deploy/deploy.sh >"$log" 2>&1 </dev/null &
pid=$!
tail -n +1 -f --pid="$pid" "$log" || true
status=0
wait "$pid" || status=$?
ls -1t "$ROOT"/logs/deploy-*.log | tail -n +31 | xargs -r rm --
exit "$status"
