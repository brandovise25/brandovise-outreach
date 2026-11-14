#!/bin/sh
set -e
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  node_modules/.bin/tsx server/src/cli/migrate.ts
fi
exec node_modules/.bin/tsx server/src/main.ts
