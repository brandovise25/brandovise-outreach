#!/usr/bin/env bash
# Builds the extension zip and refreshes the unpacked copy Chrome loads, next to the repo:
#   ../Brandovise Outreach Extension
# Only the extension's own build files are replaced; the folder itself is kept so Chrome keeps it.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="$(cd .. && pwd)/Brandovise Outreach Extension"
npm run zip -w extension >/dev/null
ZIP=$(ls -t extension/.output/brandovise-outreach-*-chrome.zip | head -1)
mkdir -p "${TARGET:?}"
for entry in chunks content-scripts assets icon background.js manifest.json options.html sidepanel.html; do
  rm -rf "${TARGET:?}/${entry:?}"
done
unzip -q -o "$ZIP" -d "${TARGET:?}"
echo "Updated: $TARGET (from $(basename "$ZIP"))"
