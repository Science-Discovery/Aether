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

if [ -d "$uv" ]; then
  for dir in "$uv"/*; do
    [ -d "$dir" ] || continue
    case "$(basename "$dir")" in
      *x86_64-unknown-linux-gnu*) ;;
      *) rm -rf "$dir" ;;
    esac
  done
fi

pkg="aether-linux-x64"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
out="$tmp/$pkg"

mkdir -p "$out"
cp -R "$src"/. "$out"/

ins="$root/Update/aether_linux_installer.sh"
if [ -f "$ins" ]; then
  cp "$ins" "$out/aether_linux_installer.sh"
  chmod +x "$out/aether_linux_installer.sh"
fi
rm -f "$out/.aether_version"
printf "%s\n" "$ver" >"$out/.aether_web_version"

if [ -f "$out/aether" ]; then
  chmod +x "$out/aether"
fi

if [ -f "$out/Aether.sh" ]; then
  chmod +x "$out/Aether.sh"
fi

cat >"$out/README_FIRST.txt" <<'EOF'
Aether Web (Linux x64)

Quick start
1) Extract this ZIP and copy the folder aether-linux-x64 to a local path, for example: ~/Applications/Aether-Web
2) Open Terminal in that folder and run: ./Aether.sh

Updates
- Use Aether's in-app update flow to download and install newer versions.
EOF

zip="dist/aether-linux-x64.zip"
zip_path="$PWD/$zip"
rm -f "$zip"
(cd "$tmp" && zip -r "$zip_path" "$pkg")

sha="$(openssl dgst -sha512 -binary "$zip" | openssl base64 -A)"
size="$(wc -c <"$zip" | tr -d '[:space:]')"

cat >dist/latest-web-linux.yml <<EOF
version: $ver
files:
  - url: aether-linux-x64.zip
    sha512: $sha
    size: $size
releaseDate: '$date'
EOF

popd >/dev/null

echo "Done"
echo "Asset: packages/opencode/$zip"
echo "YML:   packages/opencode/dist/latest-web-linux.yml"
echo "Note:  ZIP includes folder $pkg and aether_linux_installer.sh"
