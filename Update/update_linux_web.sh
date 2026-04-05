#!/usr/bin/env bash

set -euo pipefail

want="${1:-}"
self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="$(basename "$self")"
work="$(dirname "$self")"
launch=""
restart="0"

if [ "${2:-}" = "--restart" ]; then
  restart="1"
fi

fail() {
  echo "$1"
  exit 1
}

ver_from_name() {
  local file name
  file="$(basename "$1")"
  name="${file%.zip}"
  if [[ "$name" =~ ([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$ ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
    return 0
  fi
  printf ""
}

cmp() {
  local a b
  a="${1#v}"
  b="${2#v}"
  a="${a%%-*}"
  b="${b%%-*}"
  local aa bb i x y
  IFS=. read -r -a aa <<<"$a"
  IFS=. read -r -a bb <<<"$b"
  for i in 0 1 2 3; do
    x="${aa[$i]:-0}"
    y="${bb[$i]:-0}"
    x=$((10#$x))
    y=$((10#$y))
    if [ "$x" -lt "$y" ]; then
      echo lt
      return 0
    fi
    if [ "$x" -gt "$y" ]; then
      echo gt
      return 0
    fi
  done
  echo eq
}

major_minor() {
  local v a b
  v="${1#v}"
  v="${v%%-*}"
  IFS=. read -r a b _ <<<"$v"
  printf "%s.%s" "${a:-0}" "${b:-0}"
}

pick_pkg() {
  local dir want_ver file ver best_file best_ver
  dir="$1"
  want_ver="$2"
  best_file=""
  best_ver=""
  shopt -s nullglob
  for file in "$dir"/*.zip; do
    [ -f "$file" ] || continue
    ver="$(ver_from_name "$file")"
    if [ -z "$ver" ]; then
      continue
    fi
    if [ -n "$want_ver" ] && [ "$ver" != "$want_ver" ]; then
      continue
    fi
    if [ -z "$best_file" ]; then
      best_file="$file"
      best_ver="$ver"
      continue
    fi
    if [ "$(cmp "$best_ver" "$ver")" = "lt" ]; then
      best_file="$file"
      best_ver="$ver"
    fi
  done
  shopt -u nullglob
  if [ -n "$best_file" ]; then
    echo "$best_file|$best_ver"
    return 0
  fi
  return 1
}

active_dir() {
  local root link rel dir v
  root="$1"
  link="$root/current"
  if [ -L "$link" ]; then
    rel="$(readlink "$link")"
    dir="$root/$rel"
    if [ -d "$dir" ] && [ -f "$dir/.aether_web_version" ]; then
      printf "%s" "$dir"
      return 0
    fi
  fi
  if [ -f "$root/.aether_web_version" ]; then
    v="$(tr -d '[:space:]' <"$root/.aether_web_version")"
    if [ -n "$v" ] && [ -d "$root/aether_$v" ]; then
      printf "%s" "$root/aether_$v"
      return 0
    fi
  fi
  printf ""
}

write_launch() {
  local root desk
  root="$1"
  desk="$HOME/Desktop"
  mkdir -p "$desk"
  cat >"$desk/Aether.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail

root="$root"
cur="\$root/current"

if [ -L "\$cur" ] && [ -f "\$cur/Aether.sh" ]; then
  exec "\$cur/Aether.sh"
fi

echo "No active version found under: $root"
exit 1
EOF
  chmod +x "$desk/Aether.sh"
  launch="$desk/Aether.sh"
}

if [ "$base" != "downloads" ]; then
  fail "规范错误：update_linux_web.sh 必须放在 .../aether/downloads 目录。当前: $self"
fi
if [ "$(basename "$work")" != "aether" ]; then
  fail "规范错误：工作目录必须是 .../aether。当前: $work"
fi
if [ ! -f "$work/aether_linux_installer.sh" ]; then
  fail "规范错误：缺少 .../aether/aether_linux_installer.sh"
fi

echo "[0/4] 工作目录: $work"

pick="$(pick_pkg "$self" "$want" || true)"
[ -n "$pick" ] || fail "未在 .../aether/downloads 找到可用 zip（文件名需包含版本号）"

pkg="${pick%%|*}"
ver="${pick##*|}"
target="$work/aether_$ver"

echo "[1/4] 安装包: $(basename "$pkg")"
echo "      目标版本: $ver"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/aether-web-install.XXXXXX")"
ex="$tmp/extract"
next="$work/.aether_$ver.next"

cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

rm -rf "$next" "$ex"
mkdir -p "$next" "$ex"

unzip -q -o "$pkg" -d "$ex"

src="$ex"
if [ ! -f "$src/aether" ] || [ ! -f "$src/Aether.sh" ]; then
  shopt -s nullglob
  dirs=("$ex"/*/)
  shopt -u nullglob
  if [ "${#dirs[@]}" -eq 1 ] && [ -f "${dirs[0]}aether" ] && [ -f "${dirs[0]}Aether.sh" ]; then
    src="${dirs[0]%/}"
  fi
fi

[ -f "$src/aether" ] || fail "安装包内容缺少 aether"
[ -f "$src/Aether.sh" ] || fail "安装包内容缺少 Aether.sh"

echo "[2/4] 解包并安装到: $target"
cp -R "$src"/. "$next"/

old="$(active_dir "$work")"
small=0
if [ -n "$old" ] && [ -f "$old/.aether_web_version" ]; then
  old_ver="$(tr -d '[:space:]' <"$old/.aether_web_version")"
  if [ -n "$old_ver" ] && [ "$(major_minor "$old_ver")" = "$(major_minor "$ver")" ]; then
    small=1
  fi
fi

rm -rf "$target"
mv "$next" "$target"

chmod +x "$target/aether" "$target/Aether.sh"
printf "%s\n" "$ver" >"$target/.aether_web_version"
printf "%s\n" "$ver" >"$work/.aether_web_version"

ln -sfn "aether_$ver" "$work/current"
write_launch "$work"

if [ "$restart" = "1" ]; then
  if [ -n "$old" ]; then
    pkill -f "$old/Aether.sh" >/dev/null 2>&1 || true
    pkill -f "$old/aether web" >/dev/null 2>&1 || true
    pkill -f "$old/aether serve" >/dev/null 2>&1 || true
  fi
  pkill -f "$work/current/Aether.sh" >/dev/null 2>&1 || true
  pkill -f "$work/current/aether web" >/dev/null 2>&1 || true
  pkill -f "$work/current/aether serve" >/dev/null 2>&1 || true
  nohup "$work/current/Aether.sh" >/dev/null 2>&1 &
fi

if [ "$small" = "1" ] && [ -n "${old:-}" ] && [ "$old" != "$target" ]; then
  echo "[3/4] 小版本更新：替换旧目录"
  rm -rf "$old"
else
  echo "[3/4] 大版本更新：保留旧版本目录"
fi

echo "[4/4] 完成"
echo "当前版本: $ver"
echo "版本目录: $target"
echo "启动入口: $launch"
