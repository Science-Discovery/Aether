#!/usr/bin/env bash

set -euo pipefail

base="https://aether.aiphys.cn/download"
meta_url="$base/latest-web-mac.yml"

self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$self/aether" ] && [ -f "$self/Aether.command" ]; then
  app="$self"
elif [ -f "$self/../aether" ] && [ -f "$self/../Aether.command" ]; then
  app="$(cd "$self/.." && pwd)"
else
  echo "未检测到当前安装目录。请将此脚本放在安装目录中，或安装目录的子目录中再执行。"
  echo "示例: ~/Applications/Aether-Web/update_darwin_web.command"
  exit 1
fi

name="$(basename "$app")"
parent="$(dirname "$app")"
state="$app/.aether_web_version"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/aether-web-update.XXXXXX")"
meta="$tmp/latest-web-mac.yml"
dmg="$tmp/aether-darwin-arm64-web.dmg"
mnt="$tmp/mount"
next="$parent/.${name}.next"
old="$parent/.${name}.old"

cleanup() {
  hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

echo "[1/4] 检查远端版本..."
curl -fsSL "$meta_url" -o "$meta"

ver_remote="$(awk -F': ' '/^version:/{print $2; exit}' "$meta")"
url_remote="$(awk '/- url:/{print $3; exit}' "$meta")"
sha_remote="$(awk '/sha512:/{print $2; exit}' "$meta")"

if [ -z "$ver_remote" ]; then
  echo "无法读取远端版本号: $meta_url"
  exit 1
fi

if [ -z "$url_remote" ]; then
  url_remote="aether-darwin-arm64-web.dmg"
fi

ver_local=""
if [ -f "$state" ]; then
  ver_local="$(tr -d '[:space:]' <"$state")"
fi

echo "本地版本: ${ver_local:-未记录}"
echo "远端版本: $ver_remote"

if [ "$ver_local" = "$ver_remote" ]; then
  echo "已是最新版本，无需更新。"
  exit 0
fi

echo "[2/4] 下载新版本..."
curl -fL "$base/$url_remote" -o "$dmg"

if [ -n "$sha_remote" ]; then
  sha_local="$(openssl dgst -sha512 -binary "$dmg" | openssl base64 -A)"
  if [ "$sha_local" != "$sha_remote" ]; then
    echo "下载文件校验失败（sha512 不一致），已停止更新。"
    exit 1
  fi
fi

echo "[3/4] 安装新版本..."
mkdir -p "$mnt"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mnt" -quiet

rm -rf "$next"
mkdir -p "$next"
ditto "$mnt" "$next"

if [ -f "$next/aether" ]; then
  chmod +x "$next/aether"
fi

if [ -f "$next/Aether.command" ]; then
  chmod +x "$next/Aether.command"
fi

if [ -f "$next/aether" ] && [ -f "$next/Aether.command" ]; then
  xattr -cr "$next/aether" "$next/Aether.command" || true
fi

printf "%s\n" "$ver_remote" >"$next/.aether_web_version"

hdiutil detach "$mnt" -quiet

if [ -d "$old" ]; then
  rm -rf "$old"
fi

mv "$app" "$old"
mv "$next" "$app"

if [ -f "$app/package.json" ]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "检测到 package.json，但未找到 bun。请先安装 bun 后重试。"
    mv "$app" "$next"
    mv "$old" "$app"
    rm -rf "$next"
    exit 1
  fi

  if ! (cd "$app" && bun install); then
    echo "bun install 执行失败，已回滚到旧版本。"
    mv "$app" "$next"
    mv "$old" "$app"
    rm -rf "$next"
    exit 1
  fi
fi

echo "[4/4] 删除旧版本..."
rm -rf "$old"

echo "更新完成，当前版本: $ver_remote"
