#!/usr/bin/env bash
# Creates (or resets) a user in the LOCAL docker-compose database. Prompts for the password.
# Usage: scripts/local-user.sh you@example.com
set -euo pipefail
EMAIL=${1:?usage: scripts/local-user.sh <email>}
OWNER_DATABASE_URL="postgres://outreach_owner:local_owner_pw@localhost:54330/outreach?sslmode=disable" \
  npm run -s -w server create-user -- "$EMAIL"
