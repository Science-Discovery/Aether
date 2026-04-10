#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ver="${1:-$(cd "$root" && bun -e 'const p=await Bun.file("packages/opencode/package.json").json();console.log(p.version)')}"
date="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"

pushd "$root/packages/opencode" >/dev/null
bun install
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

dmg="dist/aether-darwin-arm64.dmg"
vol="Aether Web"
pkg="aether-darwin-arm64"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
out="$tmp/$pkg"

mkdir -p "$out"
cp -R "$src"/. "$out"/

ins="$root/Update/aether_darwin_installer.command"
if [ -f "$ins" ]; then
  cp "$ins" "$out/aether_darwin_installer.command"
  chmod +x "$out/aether_darwin_installer.command"
fi

printf "%s\n" "$ver" >"$out/.aether_version"

if [ -f "$out/aether" ]; then
  chmod +x "$out/aether"
fi

if [ -f "$out/Aether.command" ]; then
  chmod +x "$out/Aether.command"
fi

cat >"$out/README_FIRST.txt" <<'EOF'
Aether Web (macOS arm64)

Quick start
1) Open this DMG and copy the folder aether-darwin-arm64 to a local path, for example: ~/Applications/Aether-Web
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

Updates
- Use Aether's in-app update flow to download and install newer versions.
EOF

rm -f "$dmg"
hdiutil create -volname "$vol" -srcfolder "$tmp" -format UDZO "$dmg"

sha="$(openssl dgst -sha512 -binary "$dmg" | openssl base64 -A)"
size="$(wc -c <"$dmg" | tr -d '[:space:]')"

cat >dist/latest-web-mac.yml <<EOF
version: $ver
files:
  - url: aether-darwin-arm64.dmg
    sha512: $sha
    size: $size
releaseDate: '$date'
EOF

popd >/dev/null

echo "Done"
echo "Asset: packages/opencode/$dmg"
echo "YML:   packages/opencode/dist/latest-web-mac.yml"
echo "Note:  DMG includes README_FIRST.txt and aether_darwin_installer.command"
