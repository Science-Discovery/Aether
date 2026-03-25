#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
ver="${1:-$(cd "$root" && bun -e 'const p=await Bun.file("packages/opencode/package.json").json();console.log(p.version)')}"
date="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"

pushd "$root/packages/opencode" >/dev/null
bun run build -- --single

src="dist/aether-darwin-arm64/bin"
if [ ! -d "$src" ]; then
  echo "Missing $src. Run this on mac arm64."
  exit 1
fi

zip="dist/aether-darwin-arm64-web.zip"
rm -f "$zip"
(cd "$src" && zip -r "../../aether-darwin-arm64-web.zip" .)

sha="$(openssl dgst -sha512 -binary "$zip" | openssl base64 -A)"
size="$(wc -c <"$zip" | tr -d '[:space:]')"

cat >dist/latest-web-mac.yml <<EOF
version: $ver
files:
  - url: aether-darwin-arm64-web.zip
    sha512: $sha
    size: $size
releaseDate: '$date'
EOF

popd >/dev/null

echo "Done"
echo "Asset: packages/opencode/$zip"
echo "YML:   packages/opencode/dist/latest-web-mac.yml"
