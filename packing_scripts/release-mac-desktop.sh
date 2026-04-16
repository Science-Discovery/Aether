#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ver="${1:-$(cd "$root" && bun -e 'const p=await Bun.file("packages/desktop-electron/package.json").json();console.log(p.version)')}"
date="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"

bun install

pushd "$root/packages/desktop-electron" >/dev/null
export OPENCODE_CHANNEL=prod
export OPENCODE_UPDATER_CHANNEL=latest
export RUST_TARGET=aarch64-apple-darwin

echo "Preparing desktop resources..."
bun ./scripts/prepare.ts

bun run build
npx electron-builder --mac dmg --arm64 --publish never --config electron-builder.config.ts

shopt -s nullglob
arr=(dist/*-mac-arm64.dmg dist/*mac*arm64*.dmg)
shopt -u nullglob
if [ "${#arr[@]}" -eq 0 ]; then
  echo "No mac arm64 dmg found in packages/desktop-electron/dist"
  exit 1
fi

art="${arr[0]}"
url="$(basename "$art")"
sha="$(openssl dgst -sha512 -binary "$art" | openssl base64 -A)"
size="$(wc -c <"$art" | tr -d '[:space:]')"

cat >dist/latest-mac.yml <<EOF
version: $ver
files:
  - url: $url
    sha512: $sha
    size: $size
releaseDate: '$date'
EOF

popd >/dev/null

echo "Done"
echo "Asset: packages/desktop-electron/$art"
echo "YML:   packages/desktop-electron/dist/latest-mac.yml"
