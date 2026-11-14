#!/usr/bin/env bash
# Starts a throwaway Postgres 17 for local tests, applies migrations + seeds, runs SQL tests.
# Usage: scripts/test-db.sh [up|down]
set -euo pipefail
NAME=outreach-test-db
PORT=${TEST_DB_PORT:-54329}
OWNER_URL="postgres://postgres:postgres@localhost:${PORT}/outreach_test?sslmode=disable"

if [[ "${1:-up}" == "down" ]]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  exit 0
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=outreach_test \
  -p "${PORT}:5432" postgres:17-alpine >/dev/null
until docker exec "$NAME" pg_isready -U postgres -d outreach_test >/dev/null 2>&1; do sleep 1; done
sleep 1

MIGRATION_DATABASE_URL="$OWNER_URL" API_RPC_PASSWORD=api_rpc_test npx tsx server/src/cli/migrate.ts
for f in db/tests/*.sql; do psql "$OWNER_URL" -q -v ON_ERROR_STOP=1 -f "$f"; done

echo "TEST_OWNER_URL=$OWNER_URL"
echo "TEST_API_URL=postgres://api_rpc:api_rpc_test@localhost:${PORT}/outreach_test"
