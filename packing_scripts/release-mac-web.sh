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
rm -f "$out/aether_darwin_installer.command" "$out/aether_darwin_x64_installer.command" "$out/aether_darwin_installer_beta.command" "$out/aether_darwin_installer_devtest.command"

ins="$root/Update/install.command"
[ -f "$ins" ] || {
  echo "Missing $ins"
  exit 1
}
cp "$ins" "$out/install.command"
chmod +x "$out/install.command"

icon="$root/packages/desktop-web/icons/prod/icon.icns"
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
1) Open this DMG
2) In Finder, open the aether-darwin-ARCH folder
3) Right click install.command and choose Open
4) If macOS asks again, click Open in the security prompt

Troubleshooting
- If you see "cannot be opened" or "unidentified developer":
  Right click install.command -> Open, then confirm Open

- If execution permission is missing:
    chmod +x ./install.command

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
echo "Note:  DMG includes README_FIRST.txt and install.command"
