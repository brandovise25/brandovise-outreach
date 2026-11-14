#!/usr/bin/env bash
# Moves pages saved with the side panel's "Capture page (redacted)" button from ~/Downloads into
# fixtures/redacted/<kind>/<lang>/, then runs the fixture safety test.
set -euo pipefail
shopt -s nullglob
moved=0
# Raw captures (real text) go to the git-ignored fixtures/raw/ and never into the repo.
for f in "$HOME"/Downloads/linkedin-raw-*.html; do
  base=$(basename "$f")
  kind=$(sed -E 's/^linkedin-raw-([a-z-]+)-([a-z]{2}|un)-[0-9T-]+\.html$/\1/' <<<"$base")
  mkdir -p "fixtures/raw/$kind"
  mv "$f" "fixtures/raw/$kind/$base"
  echo "moved $base -> fixtures/raw/$kind/ (local only)"
  moved=$((moved + 1))
done
for f in "$HOME"/Downloads/linkedin-*-*-*.html; do
  base=$(basename "$f")
  kind=$(sed -E 's/^linkedin-([a-z-]+)-([a-z]{2}|un)-[0-9T-]+\.html$/\1/' <<<"$base")
  lang=$(sed -E 's/^linkedin-([a-z-]+)-([a-z]{2}|un)-[0-9T-]+\.html$/\2/' <<<"$base")
  mkdir -p "fixtures/redacted/$kind/$lang"
  mv "$f" "fixtures/redacted/$kind/$lang/$base"
  echo "moved $base -> fixtures/redacted/$kind/$lang/"
  moved=$((moved + 1))
done
echo "$moved file(s) moved"
npx vitest run --project extension test/fixtures.test.ts
