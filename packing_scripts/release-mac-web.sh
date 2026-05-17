#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ver="${1:-$(cd "$root" && bun -e 'const p=await Bun.file("packages/opencode/package.json").json();console.log(p.version)')}"
date="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
arch="${2:-}"

if [ -z "$arch" ]; then
  case "$(uname -m)" in
    arm64) arch="arm64" ;;
    x86_64) arch="x64" ;;
    *)
      echo "Unsupported macOS architecture: $(uname -m)"
      exit 1
      ;;
  esac
fi

case "$arch" in
  arm64) uv="aarch64-apple-darwin" ;;
  x64) uv="x86_64-apple-darwin" ;;
  *)
    echo "Unsupported macOS architecture: $arch"
    exit 1
    ;;
esac

pkg="aether-darwin-$arch"
yml="latest-web-mac"
[ "$arch" = "arm64" ] || yml="$yml-$arch"

pushd "$root/packages/opencode" >/dev/null
bun install
bun run build -- --single

src="dist/$pkg/bin"
if [ ! -d "$src" ]; then
  echo "Missing $src. Run this on mac $arch."
  exit 1
fi

uv_dir="$src/wechat-bridge/runtime/uv"
if [ -d "$uv_dir" ]; then
  for dir in "$uv_dir"/*; do
    [ -d "$dir" ] || continue
    case "$(basename "$dir")" in
      *"$uv"*) ;;
      *) rm -rf "$dir" ;;
    esac
  done
fi

dmg="dist/$pkg.dmg"
vol="Aether Web"
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

icon="$root/packages/desktop-electron/icons/prod/icon.icns"
if [ -f "$icon" ]; then
  cp "$icon" "$out/aether-icon.icns"
fi

rm -f "$out/.aether_version"
printf "%s\n" "$ver" >"$out/.aether_web_version"

if [ -f "$out/aether" ]; then
  chmod +x "$out/aether"
fi

if [ -f "$out/Aether.command" ]; then
  chmod +x "$out/Aether.command"
fi

cat >"$out/README_FIRST.txt" <<'EOF'
Aether Web (macOS ARCH)

Quick start
1) Open this DMG and copy the folder PACKAGE to a local path, for example: ~/Applications/Aether-Web
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
sed -i '' "s/ARCH/$arch/g;s/PACKAGE/$pkg/g" "$out/README_FIRST.txt"

rm -f "$dmg"
hdiutil create -volname "$vol" -srcfolder "$tmp" -format UDZO "$dmg"

sha="$(openssl dgst -sha512 -binary "$dmg" | openssl base64 -A)"
size="$(wc -c <"$dmg" | tr -d '[:space:]')"

cat >"dist/$yml.yml" <<EOF
version: $ver
files:
  - url: $pkg.dmg
    sha512: $sha
    size: $size
releaseDate: '$date'
EOF

popd >/dev/null

echo "Done"
echo "Asset: packages/opencode/$dmg"
echo "YML:   packages/opencode/dist/$yml.yml"
echo "Note:  DMG includes README_FIRST.txt and aether_darwin_installer.command"
