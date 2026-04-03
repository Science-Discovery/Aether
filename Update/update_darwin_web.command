#!/usr/bin/env bash

set -euo pipefail

want="${1:-}"
self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  echo "$1"
  exit 1
}

ver_from_name() {
  local file name
  file="$(basename "$1")"
  name="${file%.dmg}"
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

detect_work() {
  local dir base par
  dir="$1"
  base="$(basename "$dir")"
  par="$(basename "$(dirname "$dir")")"
  if [ "$base" = "Aether" ]; then
    printf "%s" "$dir"
    return 0
  fi
  if [ "$base" = "Update" ] && [ "$par" = "Aether" ]; then
    printf "%s" "$(dirname "$dir")"
    return 0
  fi
  if [ "$base" = "downloads" ] && [ "$par" = "Aether" ]; then
    printf "%s" "$(dirname "$dir")"
    return 0
  fi
  if [[ "$base" == aether-* ]] && [ "$par" = "Aether" ]; then
    printf "%s" "$(dirname "$dir")"
    return 0
  fi
  printf "%s" "$HOME/Applications/Aether"
}

pick_pkg() {
  local dir want_ver file ver best_file best_ver
  dir="$1"
  want_ver="$2"
  best_file=""
  best_ver=""
  shopt -s nullglob
  for file in "$dir"/*.dmg; do
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
  local work link real file
  work="$1"
  link="$work/current"
  if [ -L "$link" ]; then
    real="$(cd "$(dirname "$link")" && pwd)/$(readlink "$link")"
    if [ -d "$real" ] && [ -f "$real/.aether_web_version" ]; then
      printf "%s" "$real"
      return 0
    fi
  fi
  if [ -f "$work/.aether_web_version" ]; then
    local v
    v="$(tr -d '[:space:]' <"$work/.aether_web_version")"
    if [ -n "$v" ] && [ -d "$work/aether-$v" ]; then
      printf "%s" "$work/aether-$v"
      return 0
    fi
  fi
  shopt -s nullglob
  for file in "$work"/aether-*; do
    [ -d "$file" ] || continue
    if [ -f "$file/.aether_web_version" ]; then
      printf "%s" "$file"
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  printf ""
}

launch_file() {
  local work
  work="$1"
  cat >"$work/Aether.command" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cur="$root/current"

if [ -L "$cur" ] && [ -f "$cur/Aether.command" ]; then
  exec "$cur/Aether.command"
fi

echo "No active version found under: $root"
exit 1
EOF
  chmod +x "$work/Aether.command"
  xattr -cr "$work/Aether.command" >/dev/null 2>&1 || true
}

work="$(detect_work "$self")"
if [ "$(basename "$work")" != "Aether" ]; then
  work="$work/Aether"
fi
mkdir -p "$work"

echo "[0/4] 工作目录: $work"

pick="$(pick_pkg "$self" "$want" || true)"
[ -n "$pick" ] || fail "未在脚本目录找到可用 dmg（文件名需包含版本号）。目录: $self"

pkg="${pick%%|*}"
ver="${pick##*|}"
target="$work/aether-$ver"

echo "[1/4] 安装包: $(basename "$pkg")"
echo "      目标版本: $ver"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/aether-web-install.XXXXXX")"
mnt="$tmp/mount"
next="$work/.aether-$ver.next"

cleanup() {
  hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

rm -rf "$next"
mkdir -p "$next" "$mnt"

hdiutil attach "$pkg" -nobrowse -readonly -mountpoint "$mnt" -quiet

src="$mnt"
if [ ! -f "$src/aether" ] || [ ! -f "$src/Aether.command" ]; then
  shopt -s nullglob
  dirs=("$mnt"/*/)
  shopt -u nullglob
  if [ "${#dirs[@]}" -eq 1 ] && [ -f "${dirs[0]}aether" ] && [ -f "${dirs[0]}Aether.command" ]; then
    src="${dirs[0]%/}"
  fi
fi

[ -f "$src/aether" ] || fail "安装包内容缺少 aether"
[ -f "$src/Aether.command" ] || fail "安装包内容缺少 Aether.command"

echo "[2/4] 解包并安装到: $target"
ditto "$src" "$next"

old="$(active_dir "$work")"
small=0
if [ -n "$old" ] && [ -f "$old/.aether_web_version" ]; then
  old_ver="$(tr -d '[:space:]' <"$old/.aether_web_version")"
  if [ -n "$old_ver" ] && [ "$(major_minor "$old_ver")" = "$(major_minor "$ver")" ]; then
    small=1
  fi
fi

if [ "$small" = "1" ] && [ -n "${old:-}" ] && [ "$old" != "$target" ] && [ -d "$old/.opencode" ]; then
  rm -rf "$next/.opencode"
  cp -R "$old/.opencode" "$next/.opencode"
fi

rm -rf "$target"
mv "$next" "$target"
chflags nohidden "$target" >/dev/null 2>&1 || true

shopt -s nullglob
for dir in "$work"/aether-*; do
  [ -d "$dir" ] || continue
  chflags nohidden "$dir" >/dev/null 2>&1 || true
done
shopt -u nullglob

chmod +x "$target/aether" "$target/Aether.command"
xattr -cr "$target/aether" "$target/Aether.command" >/dev/null 2>&1 || true
printf "%s\n" "$ver" >"$target/.aether_web_version"
printf "%s\n" "$ver" >"$work/.aether_web_version"

ln -sfn "aether-$ver" "$work/current"
launch_file "$work"

if [ "$small" = "1" ] && [ -n "${old:-}" ] && [ "$old" != "$target" ]; then
  echo "[3/4] 小版本更新：替换旧目录并保留 .opencode"
  rm -rf "$old"
else
  echo "[3/4] 大版本更新：保留旧版本目录"
fi

echo "[4/4] 完成"
echo "当前版本: $ver"
echo "版本目录: $target"
echo "启动入口: $work/Aether.command"
