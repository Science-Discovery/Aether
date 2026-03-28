#!/usr/bin/env bash

set -euo pipefail

base="https://aether.aiphys.cn/download"
meta_url="$base/latest-web-linux.yml"

self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$self/aether" ] && [ -f "$self/Aether.sh" ]; then
  app="$self"
elif [ -f "$self/../aether" ] && [ -f "$self/../Aether.sh" ]; then
  app="$(cd "$self/.." && pwd)"
else
  echo "未检测到当前安装目录。请将此脚本放在安装目录中，或安装目录的子目录中再执行。"
  echo "示例: ~/Applications/Aether-Web/update_linux_web.sh"
  exit 1
fi

name="$(basename "$app")"
parent="$(dirname "$app")"
state="$app/.aether_web_version"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/aether-web-update.XXXXXX")"
meta="$tmp/latest-web-linux.yml"
zip="$tmp/aether-linux-x64-web.zip"
next="$parent/.${name}.next"
old="$parent/.${name}.old"

cleanup() {
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
  url_remote="aether-linux-x64-web.zip"
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
curl -fL "$base/$url_remote" -o "$zip"

if [ -n "$sha_remote" ]; then
  sha_local="$(openssl dgst -sha512 -binary "$zip" | openssl base64 -A)"
  if [ "$sha_local" != "$sha_remote" ]; then
    echo "下载文件校验失败（sha512 不一致），已停止更新。"
    exit 1
  fi
fi

echo "[3/4] 安装新版本..."
rm -rf "$next"
mkdir -p "$next"
unzip -q -o "$zip" -d "$next"

if [ -f "$next/aether" ]; then
  chmod +x "$next/aether"
fi

if [ -f "$next/Aether.sh" ]; then
  chmod +x "$next/Aether.sh"
fi

if [ -f "$next/update_linux_web.sh" ]; then
  chmod +x "$next/update_linux_web.sh"
fi

printf "%s\n" "$ver_remote" >"$next/.aether_web_version"

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
