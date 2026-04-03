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
  app="${HOME}/Applications/Aether-Web"
fi

name="$(basename "$app")"
parent="$(dirname "$app")"
state="$app/.aether_web_version"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/aether-web-update.XXXXXX")"
meta="$tmp/latest-web-linux.yml"
zip="$tmp/aether-linux-x64-web.zip"
ex="$tmp/extract"
next="$parent/.${name}.next"
old="$parent/.${name}.old"
has_app="0"

if [ -f "$app/aether" ] && [ -f "$app/Aether.sh" ]; then
  has_app="1"
fi

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

if [ "$has_app" = "1" ] && [ "$ver_local" = "$ver_remote" ]; then
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
rm -rf "$ex"
mkdir -p "$ex"
unzip -q -o "$zip" -d "$ex"

src="$ex"
if [ ! -f "$src/aether" ] || [ ! -f "$src/Aether.sh" ]; then
  shopt -s nullglob
  dirs=("$ex"/*/)
  shopt -u nullglob
  if [ "${#dirs[@]}" -eq 1 ] && [ -f "${dirs[0]}aether" ] && [ -f "${dirs[0]}Aether.sh" ]; then
    src="${dirs[0]%/}"
  fi
fi

if [ ! -f "$src/aether" ] || [ ! -f "$src/Aether.sh" ]; then
  echo "ZIP 内容结构不符合预期，未找到 aether 与 Aether.sh。"
  exit 1
fi

rm -rf "$next"
mkdir -p "$next"
cp -R "$src"/. "$next"/

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

mkdir -p "$parent"

if [ "$has_app" = "1" ]; then
  mv "$app" "$old"
  mv "$next" "$app"
else
  if [ -d "$app" ]; then
    echo "目标目录已存在但不是已安装实例: $app"
    echo "请先清理该目录后重试，或将脚本放到已安装目录中执行更新。"
    rm -rf "$next"
    exit 1
  fi
  mv "$next" "$app"
fi

echo "[4/4] 删除旧版本..."
rm -rf "$old"

if [ "$has_app" = "1" ]; then
  echo "更新完成，当前版本: $ver_remote"
else
  echo "安装完成，当前版本: $ver_remote"
  echo "安装目录: $app"
fi
