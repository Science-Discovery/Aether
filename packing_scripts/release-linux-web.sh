#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ver="${1:-$(cd "$root" && bun -e 'const p=await Bun.file("packages/opencode/package.json").json();console.log(p.version)')}"
date="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
arch="${2:-}"

if [ -z "$arch" ]; then
  case "$(uname -m)" in
    aarch64|arm64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *)
      echo "Unsupported Linux architecture: $(uname -m)"
      exit 1
      ;;
  esac
fi

case "$arch" in
  arm64) uv="aarch64-unknown-linux-gnu" ;;
  x64) uv="x86_64-unknown-linux-gnu" ;;
  *)
    echo "Unsupported Linux architecture: $arch"
    exit 1
    ;;
esac

pkg="aether-linux-$arch"
yml="latest-web-linux"
[ "$arch" = "x64" ] || yml="$yml-$arch"

pushd "$root/packages/opencode" >/dev/null
bun install
bun run build -- --single

src="dist/$pkg/bin"
if [ ! -d "$src" ]; then
  echo "Missing $src. Run this on linux $arch."
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
Aether Web (Linux ARCH)

Quick start
1) Extract this ZIP and copy the folder PACKAGE to a local path, for example: ~/Applications/Aether-Web
2) Open Terminal in that folder and run: ./Aether.sh
3) Optional base path: VITE_BASE_PATH=/aether ./Aether.sh

Updates
- Use Aether's in-app update flow to download and install newer versions.
EOF
sed -i "s/ARCH/$arch/g;s/PACKAGE/$pkg/g" "$out/README_FIRST.txt"

zip="dist/$pkg.zip"
zip_path="$PWD/$zip"
rm -f "$zip"
(cd "$tmp" && zip -r "$zip_path" "$pkg")

sha="$(openssl dgst -sha512 -binary "$zip" | openssl base64 -A)"
size="$(wc -c <"$zip" | tr -d '[:space:]')"

cat >"dist/$yml.yml" <<EOF
version: $ver
files:
  - url: $pkg.zip
    sha512: $sha
    size: $size
releaseDate: '$date'
EOF

popd >/dev/null

echo "Done"
echo "Asset: packages/opencode/$zip"
echo "YML:   packages/opencode/dist/$yml.yml"
echo "Note:  ZIP includes folder $pkg and aether_linux_installer.sh"
