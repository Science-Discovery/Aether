#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ver="${1:-$(cd "$root" && bun -e 'const p=await Bun.file("packages/opencode/package.json").json();console.log(p.version)')}"
date="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"

pushd "$root/packages/opencode" >/dev/null
bun run build -- --single

src="dist/aether-darwin-arm64/bin"
if [ ! -d "$src" ]; then
  echo "Missing $src. Run this on mac arm64."
  exit 1
fi

uv="$src/wechat-bridge/runtime/uv"
if [ -d "$uv" ]; then
  for dir in "$uv"/*; do
    [ -d "$dir" ] || continue
    case "$(basename "$dir")" in
      *aarch64-apple-darwin*) ;;
      *) rm -rf "$dir" ;;
    esac
  done
fi

dmg="dist/aether-darwin-arm64-web.dmg"
vol="Aether Web"
tmp="dist/aether-darwin-arm64-web"
upd="$root/Update/update_darwin_web.command"

rm -rf "$tmp"
mkdir -p "$tmp"
cp -R "$src"/. "$tmp"/

if [ ! -f "$upd" ]; then
  echo "Missing updater script: $upd"
  exit 1
fi
cp "$upd" "$tmp/update_darwin_web.command"

printf "%s\n" "$ver" >"$tmp/.aether_web_version"

if [ -f "$tmp/aether" ]; then
  chmod +x "$tmp/aether"
fi

if [ -f "$tmp/Aether.command" ]; then
  chmod +x "$tmp/Aether.command"
fi

chmod +x "$tmp/update_darwin_web.command"

cat >"$tmp/README_FIRST.txt" <<'EOF'
Aether Web (macOS arm64)

Quick start
1) Open this DMG and copy all files to a local folder, for example: ~/Applications/Aether-Web
2) In Finder, right click Aether.command and choose Open
3) If macOS asks again, click Open in the security prompt

Troubleshooting
- If you see "cannot be opened" or "unidentified developer":
  Right click Aether.command -> Open, then confirm Open

- If you see "is damaged and cannot be opened":
  Open Terminal in the install folder and run:
    xattr -cr ./aether ./Aether.command

- If execution permission is missing:
    chmod +x ./aether ./Aether.command

- If Gatekeeper still blocks it:
  System Settings -> Privacy & Security -> scroll down and allow the blocked item, then retry Open

Offline update
- Run ./update_darwin_web.command to check and install newer versions from:
  https://aether.aiphys.cn/download
EOF

rm -f "$dmg"
hdiutil create -volname "$vol" -srcfolder "$tmp" -format UDZO "$dmg"

sha="$(openssl dgst -sha512 -binary "$dmg" | openssl base64 -A)"
size="$(wc -c <"$dmg" | tr -d '[:space:]')"

cat >dist/latest-web-mac.yml <<EOF
version: $ver
files:
  - url: aether-darwin-arm64-web.dmg
    sha512: $sha
    size: $size
releaseDate: '$date'
EOF

popd >/dev/null

echo "Done"
echo "Asset: packages/opencode/$dmg"
echo "YML:   packages/opencode/dist/latest-web-mac.yml"
echo "Note:  DMG includes README_FIRST.txt and update_darwin_web.command"
