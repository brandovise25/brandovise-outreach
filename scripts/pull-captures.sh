#!/usr/bin/env bash
# Copies the LinkedIn pages saved on the server (developer captures) into fixtures/raw on this Mac
# (git-ignored). They contain names and texts from LinkedIn: they stay out of git.
#   scripts/pull-captures.sh            # copy new pages
#   scripts/pull-captures.sh --clear    # copy, then delete them on the server
set -euo pipefail
cd "$(dirname "$0")/.."
# Server access for the wait/copy steps, from .env (git-ignored): SSH_HOST, PROD_DB_CONTAINER, PROD_API_CONTAINER.
envval() { sed -n "s/^$1=//p" .env 2>/dev/null | head -1; }
HOST=${SSH_HOST:-$(envval SSH_HOST)}
API=${PROD_API_CONTAINER:-$(envval PROD_API_CONTAINER)}
[[ -n "$HOST" && -n "$API" ]] || { echo "Set SSH_HOST and PROD_API_CONTAINER in .env" >&2; exit 1; }
mkdir -p fixtures/raw
before=$(find fixtures/raw -name '*.html' | wc -l)
# One SSH connection: unpack into a temp folder, then copy only files the Mac does not have yet.
tmp=$(mktemp -d)
ssh -q -o LogLevel=ERROR "$HOST" "docker exec $API tar -C /captures -cf - ." | tar -C "$tmp" -xf -
(cd "$tmp" && find . -name '*.html' -print0) | while IFS= read -r -d '' f; do
  [[ -e "fixtures/raw/$f" ]] || { mkdir -p "fixtures/raw/$(dirname "$f")"; cp "$tmp/$f" "fixtures/raw/$f"; echo "  new: ${f#./}"; }
done
rm -rf "$tmp"
after=$(find fixtures/raw -name '*.html' | wc -l)
echo "copied $((after - before)) new page(s) into fixtures/raw"
if [[ "${1:-}" == "--clear" ]]; then
  ssh -q -o LogLevel=ERROR "$HOST" "docker exec $API sh -c 'rm -rf /captures/*'"
  echo "cleared the server copies"
fi
