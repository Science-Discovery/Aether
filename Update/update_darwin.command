#!/usr/bin/env bash

set -euo pipefail

want="${1:-}"
self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="$(basename "$self")"
work="$(dirname "$self")"
launch=""
launch_note=""
copy_note=""
restart="0"
prune="0"
res=""
mirror_only="${AETHER_MIRROR_ONLY:-0}"

if [ "${2:-}" = "--restart" ]; then
  restart="1"
fi

fail() {
  write_result "failed" "${2:-recover}" "$1"
  echo "$1"
  exit 1
}

flat() {
  printf "%s" "$1" | tr '\r\n' '  '
}

write_result() {
  [ -n "$res" ] || return 0
  mkdir -p "$(dirname "$res")" 2>/dev/null || true
  {
    printf 'status=%s\n' "$(flat "$1")"
    printf 'version=%s\n' "$(flat "$ver")"
    printf 'action=%s\n' "$(flat "${2:-}")"
    printf 'error=%s\n' "$(flat "${3:-}")"
    printf 'at=%s\n' "$(date +%s)"
  } >"$res"
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

dir_version() {
  local dir name ver
  dir="$1"
  if [ -f "$dir/.aether_web_version" ]; then
    ver="$(tr -d '[:space:]' <"$dir/.aether_web_version")"
    if [ -n "$ver" ]; then
      printf "%s" "$ver"
      return 0
    fi
  fi
  name="$(basename "$dir")"
  if [[ "$name" =~ ^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$ ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
    return 0
  fi
  printf ""
}

latest_dir() {
  local root best best_ver dir ver
  root="$1"
  best=""
  best_ver=""
  shopt -s nullglob
  for dir in "$root"/aether_*; do
    [ -d "$dir" ] || continue
    ver="$(dir_version "$dir")"
    [ -n "$ver" ] || continue
    if [ -z "$best" ] || [ "$(cmp "$best_ver" "$ver")" = "lt" ]; then
      best="$dir"
      best_ver="$ver"
    fi
  done
  shopt -u nullglob
  printf "%s" "$best"
}

active_dir() {
  local root
  root="$1"
  printf "%s" "$(latest_dir "$root")"
}

has_dir() {
  local dir="$1"
  shift
  local item
  for item in "$@"; do
    if [ "$item" = "$dir" ]; then
      return 0
    fi
  done
  return 1
}

prune_versions() {
  local root keep hold dir ver item tmp i j
  local -a items=()
  local -a keepers=()
  root="$1"
  keep="$2"
  hold="$3"
  prune="0"

  shopt -s nullglob
  for dir in "$root"/aether_*; do
    [ -d "$dir" ] || continue
    ver="$(dir_version "$dir")"
    [ -n "$ver" ] || continue
    items+=("$ver|$dir")
  done
  shopt -u nullglob

  for ((i = 0; i < ${#items[@]}; i++)); do
    for ((j = i + 1; j < ${#items[@]}; j++)); do
      if [ "$(cmp "${items[$i]%%|*}" "${items[$j]%%|*}")" = "lt" ]; then
        tmp="${items[$i]}"
        items[$i]="${items[$j]}"
        items[$j]="$tmp"
      fi
    done
  done

  for dir in "$hold"; do
    [ -n "${dir:-}" ] || continue
    if [ "${#keepers[@]}" -gt 0 ] && has_dir "$dir" "${keepers[@]}"; then
      continue
    fi
    for item in "${items[@]}"; do
      if [ "${item#*|}" = "$dir" ]; then
        keepers+=("$dir")
        break
      fi
    done
  done

  for item in "${items[@]}"; do
    if [ "${#keepers[@]}" -ge "$keep" ]; then
      break
    fi
    dir="${item#*|}"
    if [ "${#keepers[@]}" -gt 0 ] && has_dir "$dir" "${keepers[@]}"; then
      continue
    fi
    keepers+=("$dir")
  done

  for item in "${items[@]}"; do
    dir="${item#*|}"
    if [ "${#keepers[@]}" -gt 0 ] && has_dir "$dir" "${keepers[@]}"; then
      continue
    fi
    rm -rf "$dir"
    if [ ! -d "$dir" ]; then
      prune=$((prune + 1))
    fi
  done
}

stamp() {
  date +"%Y%m%d%H%M"
}

mirror_root() {
  if [ -n "${AETHER_MIRROR_ROOT:-}" ]; then
    cd "${AETHER_MIRROR_ROOT}" && pwd
    return 0
  fi
  local cur
  cur="${AETHER_CURRENT_DIR:-}"
  [ -n "$cur" ] || return 1
  cd "$cur/.." && pwd
}

in_work() {
  local cur root
  cur="${AETHER_CURRENT_DIR:-}"
  root="$1"
  [ -n "$cur" ] || return 1
  [ -n "$root" ] || return 1
  cur="$(cd "$cur" && pwd)"
  root="$(cd "$root" && pwd)"
  case "$cur" in
    "$root"|"$root"/*) return 0 ;;
  esac
  return 1
}

mirror_target() {
  local root dst now
  root="$1"
  dst="$root/aether_$ver"
  if [ ! -e "$dst" ]; then
    printf "%s" "$dst"
    return 0
  fi
  now="$(stamp)"
  printf "%s" "$root/aether_${ver}_$now"
}

build_app() {
  local dest final app bin cmd
  dest="$1"
  final="$2"
  app="$dest/Aether.app"
  bin="$app/Contents/MacOS/Aether"
  cmd="$final/Aether.command"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cat >"$bin" <<EOF
#!/usr/bin/env bash
set -euo pipefail

cmd="$cmd"
if [ -x "\$cmd" ]; then
  if open "\$cmd"; then
    exit 0
  fi
  nohup "\$cmd" >/dev/null 2>&1 &
  pid="\$!"
  sleep 1
  if kill -0 "\$pid" >/dev/null 2>&1; then
    exit 0
  fi
  exec "\$cmd"
fi

echo "Launch target not found: $cmd"
exit 1
EOF
  chmod +x "$bin"
  cat >"$app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Aether</string>
  <key>CFBundleDisplayName</key>
  <string>Aether</string>
  <key>CFBundleIdentifier</key>
  <string>cn.aiphys.aether.web</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>Aether</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
</dict>
</plist>
EOF
  xattr -cr "$app" >/dev/null 2>&1 || true
}

write_launch() {
  local final dest
  final="$1"
  dest="/Applications"
  if build_app "$dest" "$final" 2>/dev/null; then
    launch="$dest/Aether.app"
    launch_note="从 app 启动器中运行Aether。"
    return 0
  fi

  dest="$HOME/Applications"
  mkdir -p "$dest"
  build_app "$dest" "$final"
  launch="$dest/Aether.app"
  launch_note="无法写入 /Applications，已回退到 $launch。手动复制该 App 到 /Applications后，从 app 启动器中运行Aether，或在\"$HOME/Applications\"文件夹中双击Aether.app运行。"
}

stop() {
  local dir="$1"
  [ -n "$dir" ] || return 0
  pkill -f "$dir/Aether.command" >/dev/null 2>&1 || true
  pkill -f "$dir/aether web" >/dev/null 2>&1 || true
  pkill -f "$dir/aether serve" >/dev/null 2>&1 || true
}

boot() {
  local dir="$1"
  [ -x "$dir/Aether.command" ] || return 1
  nohup "$dir/Aether.command" >/dev/null 2>&1 &
}

mirror_dir() {
  local root dst tmp
  root="$(mirror_root || true)"
  [ -n "$root" ] || return 1
  dst="$(mirror_target "$root")"
  tmp="${dst}.copy"
  rm -rf "$tmp" "$dst"
  mkdir -p "$tmp" || return 1
  ditto "$target" "$tmp" || {
    rm -rf "$tmp"
    return 1
  }
  mv "$tmp" "$dst" || {
    rm -rf "$tmp"
    return 1
  }
  printf "%s" "$dst"
}

if [ "$base" != "downloads" ]; then
  fail "规范错误：update_darwin.command 必须放在 .../aether/downloads 目录。当前: $self"
fi
if [ "$(basename "$work")" != "aether" ]; then
  fail "规范错误：工作目录必须是 .../aether。当前: $work"
fi

res="${AETHER_UPDATE_RESULT:-$work/downloads/web-update-result.env}"
rm -f "$res" >/dev/null 2>&1 || true

echo "[0/4] 工作目录: $work"

pick="$(pick_pkg "$self" "$want" || true)"
[ -n "$pick" ] || {
  [ "$mirror_only" = "1" ] || fail "未在 .../aether/downloads 找到可用 dmg（文件名需包含版本号）"
}

pkg="${pick%%|*}"
ver="${pick##*|}"
[ -n "$ver" ] || ver="$want"
target="$work/aether_$ver"

echo "[1/4] 安装包: $(basename "$pkg")"
echo "      目标版本: $ver"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/aether-install.XXXXXX")"
mnt="$tmp/mount"
next="$work/.aether_$ver.next"

cleanup() {
  hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

old="$(active_dir "$work")"
if [ "$mirror_only" = "1" ]; then
  [ -d "$target" ] || fail "镜像重试时未找到已安装版本目录：$target"
  echo "[2/4] 复用已安装版本: $target"
else
  rm -rf "$next"
  mkdir -p "$next" "$mnt" || fail "准备安装目录失败：$next"

  hdiutil attach "$pkg" -nobrowse -readonly -mountpoint "$mnt" -quiet || fail "挂载安装包失败：$pkg"

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
  ditto "$src" "$next" || fail "解包安装包失败：$pkg"

  rm -rf "$target"
  mv "$next" "$target" || fail "写入版本目录失败：$target"
fi
chflags nohidden "$target" >/dev/null 2>&1 || true

shopt -s nullglob
for dir in "$work"/aether_*; do
  [ -d "$dir" ] || continue
  chflags nohidden "$dir" >/dev/null 2>&1 || true
done
shopt -u nullglob

chmod +x "$target/aether" "$target/Aether.command"
uv="$(find "$target/wechat-bridge/runtime/uv" -name 'uv-*apple-darwin*/uv' -type f 2>/dev/null | head -1)"
if [ -f "$uv" ]; then
  chmod +x "$uv"
fi
xattr -cr "$target/aether" "$target/Aether.command" >/dev/null 2>&1 || true
if [ -n "$uv" ] && [ -f "$uv" ]; then
  xattr -cr "$uv" >/dev/null 2>&1 || true
fi
printf "%s\n" "$ver" >"$target/.aether_web_version"
rm -f "$work/.aether_web_version" >/dev/null 2>&1 || true

rm -rf "$work/current" >/dev/null 2>&1 || true
prune_versions "$work" 5 "$target"

copy_target=""
copy_note=""
mirror_prune=""
if in_work "$work"; then
  copy_note="当前运行位置已在 WorkDir 中，已跳过 mirror"
elif copy_target="$(mirror_dir || true)" && [ -n "$copy_target" ]; then
  copy_note="已复制新版本到当前软件目录附近：$copy_target"
  mirror_root_dir="$(mirror_root || true)"
  if [ -n "$mirror_root_dir" ]; then
    prune_versions "$mirror_root_dir" 5 "$copy_target"
    mirror_prune="$prune"
  fi
else
  fail "复制新版本到当前软件目录附近失败：${AETHER_CURRENT_DIR:-当前软件}" mirror
fi
final_target="$target"
if [ -n "$copy_target" ]; then
  final_target="$copy_target"
fi
write_launch "$final_target"

if [ "$restart" = "1" ]; then
  stop "$old"
  stop "$target"
  stop "${AETHER_CURRENT_DIR:-}"
  stop "$copy_target"
  if [ -n "$copy_target" ]; then
    if ! boot "$copy_target" && ! boot "$target"; then
      fail "重启失败：无法启动 $target/Aether.command"
    fi
  elif ! boot "$target"; then
    fail "重启失败：无法启动 $target/Aether.command"
  fi
fi

write_result "installed"

if [ "$prune" -gt 0 ]; then
  echo "[3/4] 保留最近 5 个版本，已清理 $prune 个旧版本目录"
else
  echo "[3/4] 保留最近 5 个版本，无需清理旧版本目录"
fi

echo "[4/4] 完成"
echo "当前版本: $ver"
echo "版本目录: $target"
if [ -n "$copy_target" ]; then
  echo "复制目录: $copy_target"
fi
if [ -n "$mirror_prune" ] && [ "$mirror_prune" -gt 0 ]; then
  echo "镜像目录清理: 已清理 $mirror_prune 个旧版本目录"
fi
echo "启动入口: $launch"
if [ -n "$launch_note" ]; then
  echo "$launch_note"
fi
if [ -n "$copy_note" ]; then
  echo "$copy_note"
fi
