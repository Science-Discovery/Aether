#!/usr/bin/env bash
#
# Build macOS ARM64 Web DMG and upload to aether.aiphys.cn
#
# Usage:
#   ./Update/release-and-upload-mac-web.sh <version> <admin-password> [release-notes-url]
#
# Examples:
#   ./Update/release-and-upload-mac-web.sh 0.2.3 mypassword
#   ./Update/release-and-upload-mac-web.sh 0.2.3 mypassword https://aether.aiphys.cn/release-notes/0.2.3

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <version> <admin-password> [release-notes-url]"
  exit 1
fi

ver="$1"
password="$2"
notes_url="${3:-}"

root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/packages/opencode/dist"
src="$dist/aether-darwin-arm64/bin"
dmg="$dist/aether-darwin-arm64-web.dmg"
updater="$root/Update/update_darwin.command"
upload_url="https://aether.aiphys.cn/api/download/admin/upload"

# ── 1. Build ────────────────────────────────────────────────────────
echo "[1/4] Building CLI (OPENCODE_VERSION=$ver) ..."
pushd "$root/packages/opencode" >/dev/null
OPENCODE_VERSION="$ver" bun run build
popd >/dev/null

if [ ! -d "$src" ]; then
  echo "Error: $src not found. Full build must include darwin-arm64 target."
  exit 1
fi

# ── 2. Package DMG ──────────────────────────────────────────────────
echo "[2/4] Creating DMG ..."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pkg="$tmp/aether-darwin-arm64-web"

mkdir -p "$pkg"
cp -R "$src"/. "$pkg"/

# Write version file
rm -f "$pkg/.aether_version"
printf "%s\n" "$ver" > "$pkg/.aether_web_version"

ins="$root/Update/aether_darwin_installer.command"
if [ -f "$ins" ]; then
  cp "$ins" "$pkg/aether_darwin_installer.command"
  chmod +x "$pkg/aether_darwin_installer.command"
fi

# Ensure executables are +x
[ -f "$pkg/aether" ] && chmod +x "$pkg/aether"
[ -f "$pkg/Aether.command" ] && chmod +x "$pkg/Aether.command"

# Add README
cat > "$pkg/README_FIRST.txt" <<'EOFREADME'
Aether Web (macOS arm64)

Quick start
1) Open this DMG and copy the folder to a local path, e.g. ~/Applications/Aether-Web
2) In Finder, right-click Aether.command and choose Open
3) If macOS asks again, click Open in the security prompt

Troubleshooting
- "cannot be opened" / "unidentified developer":
  Right-click Aether.command -> Open, then confirm
- "is damaged and cannot be opened":
  Open Terminal in the folder and run: xattr -cr ./aether ./Aether.command
- Permission denied:
  chmod +x ./aether ./Aether.command

Updates
- Use Aether's in-app update flow to download and install newer versions.
EOFREADME

rm -f "$dmg"

if command -v hdiutil >/dev/null 2>&1; then
  # macOS
  hdiutil create -volname "Aether Web" -srcfolder "$tmp" -format UDZO "$dmg"
else
  # Linux
  if ! command -v genisoimage >/dev/null 2>&1; then
    echo "Error: genisoimage not found. Install with: sudo apt install genisoimage"
    exit 1
  fi
  genisoimage -V "Aether Web" -D -R -apple -no-pad -o "$dmg" "$tmp"
fi

echo "DMG created: $dmg"

# ── 3. Generate metadata YML ───────────────────────────────────────
echo "[3/4] Generating latest-web-mac.yml ..."

if command -v openssl >/dev/null 2>&1; then
  sha="$(openssl dgst -sha512 -binary "$dmg" | openssl base64 -A)"
else
  sha="$(sha512sum "$dmg" | awk '{print $1}' | xxd -r -p | base64 -w0)"
fi
size="$(wc -c < "$dmg" | tr -d '[:space:]')"
date="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"

cat > "$dist/latest-web-mac.yml" <<EOF
version: $ver
files:
  - url: aether-darwin-arm64-web.dmg
    sha512: $sha
    size: $size
releaseDate: '$date'
EOF

echo "YML created: $dist/latest-web-mac.yml"

# ── 4. Upload ───────────────────────────────────────────────────────
echo "[4/4] Uploading to $upload_url ..."

upload_args=(
  -X POST "$upload_url"
  -H "x-download-admin-password: $password"
  -F "macVersion=$ver"
  -F "macos=@$dmg"
  -F "macInstaller=@$updater"
)

if [ -n "$notes_url" ]; then
  upload_args+=(-F "macNotesUrl=$notes_url")
fi

curl "${upload_args[@]}"

echo ""
echo "Done! v$ver uploaded."
