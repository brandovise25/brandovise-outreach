#!/usr/bin/env bash
# Deploys the pushed code on the server (Easypanel) and waits until its migrations are applied.
#   scripts/deploy.sh
# Needs DEPLOY_HOOK_URL in .env (git-ignored, never printed, never committed; leak guard: .gitleaks.toml).
# Guards: refuses when the latest commit is not on GitHub (a deploy only builds pushed code).
set -euo pipefail
set +x
cd "$(dirname "$0")/.."
# Server access for the wait/copy steps, from .env (git-ignored): SSH_HOST, PROD_DB_CONTAINER, PROD_API_CONTAINER.
envval() { sed -n "s/^$1=//p" .env 2>/dev/null | head -1; }
HOST=${SSH_HOST:-$(envval SSH_HOST)}
DB=${PROD_DB_CONTAINER:-$(envval PROD_DB_CONTAINER)}
[[ -n "$HOST" && -n "$DB" ]] || { echo "Set SSH_HOST and PROD_DB_CONTAINER in .env" >&2; exit 1; }

HOOK=$(sed -n 's/^DEPLOY_HOOK_URL=//p' .env 2>/dev/null | head -1)
[[ -n "$HOOK" ]] || { echo "DEPLOY_HOOK_URL is not set in .env" >&2; exit 1; }

git fetch -q origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Not pushed: HEAD is not origin/main. Push first (a deploy only builds pushed code)." >&2
  exit 1
fi
want=$(ls db/migrations | sort | tail -1 | cut -d_ -f1)
echo "Deploying $(git rev-parse --short HEAD); newest migration $want"

# stderr is dropped: curl's error text must never be able to echo the link.
code=$(curl -s -m 40 -o /dev/null -w '%{http_code}' -X POST "$HOOK" 2>/dev/null || true)
[[ "$code" == "200" ]] || { echo "Deploy request failed (HTTP ${code:-none}). Is the VPN/domain reachable?" >&2; exit 1; }
echo "Deploy started (HTTP 200). Waiting for the server to apply migrations..."

for _ in $(seq 1 60); do
  got=$(ssh -q -o LogLevel=ERROR -o ConnectTimeout=15 "$HOST" \
    "docker exec -i $DB psql -U outreach_owner -d outreach -At -c 'select max(version) from public.schema_migrations'" 2>/dev/null || true)
  [[ "$got" == "$want" ]] && { echo "Done: server is on migration $got."; exit 0; }
  sleep 10
done
echo "Timed out: server is on migration ${got:-unknown}, expected $want. Check Easypanel." >&2
exit 1
