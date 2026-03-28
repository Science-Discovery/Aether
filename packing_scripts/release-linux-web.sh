#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ver="${1:-$(cd "$root" && bun -e 'const p=await Bun.file("packages/opencode/package.json").json();console.log(p.version)')}"
date="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"

pushd "$root/packages/opencode" >/dev/null
bun install
bun run build -- --single

src="dist/aether-linux-x64/bin"
if [ ! -d "$src" ]; then
  echo "Missing $src. Run this on linux x64."
  exit 1
fi

uv="$src/wechat-bridge/runtime/uv"
upd="$root/Update/update_linux_web.sh"

if [ -d "$uv" ]; then
  for dir in "$uv"/*; do
    [ -d "$dir" ] || continue
    case "$(basename "$dir")" in
      *x86_64-unknown-linux-gnu*) ;;
      *) rm -rf "$dir" ;;
    esac
  done
fi

if [ ! -f "$upd" ]; then
  echo "Missing updater script: $upd"
  exit 1
fi

cp "$upd" "$src/update_linux_web.sh"
chmod +x "$src/update_linux_web.sh"
printf "%s\n" "$ver" >"$src/.aether_web_version"

zip="dist/aether-linux-x64-web.zip"
rm -f "$zip"
(cd "$src" && zip -r "../../aether-linux-x64-web.zip" .)

sha="$(openssl dgst -sha512 -binary "$zip" | openssl base64 -A)"
size="$(wc -c <"$zip" | tr -d '[:space:]')"

cat >dist/latest-web-linux.yml <<EOF
version: $ver
files:
  - url: aether-linux-x64-web.zip
    sha512: $sha
    size: $size
releaseDate: '$date'
EOF

popd >/dev/null

echo "Done"
echo "Asset: packages/opencode/$zip"
echo "YML:   packages/opencode/dist/latest-web-linux.yml"
echo "Note:  Package includes update_linux_web.sh"
