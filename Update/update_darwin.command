#!/usr/bin/env bash

set -euo pipefail

want="${1:-}"
self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="$(basename "$self")"
work="$(dirname "$self")"
launch=""
launch_note=""
restart="0"
prune="0"

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

latest_dir() {
  local root best best_ver dir ver
  root="$1"
  best=""
  best_ver=""
  shopt -s nullglob
  for dir in "$root"/aether_*; do
    [ -d "$dir" ] || continue
    [ -f "$dir/.aether_web_version" ] || continue
    ver="$(tr -d '[:space:]' <"$dir/.aether_web_version")"
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
  local root dir v
  root="$1"
  if [ -f "$root/.aether_web_version" ]; then
    v="$(tr -d '[:space:]' <"$root/.aether_web_version")"
    if [ -n "$v" ] && [ -d "$root/aether_$v" ]; then
      printf "%s" "$root/aether_$v"
      return 0
    fi
  fi
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
    [ -f "$dir/.aether_web_version" ] || continue
    ver="$(tr -d '[:space:]' <"$dir/.aether_web_version")"
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

write_launch() {
  local root target
  root="$1"
build_app() {
    local dir app bin
    dir="$1"
    app="$dir/Aether.app"
    bin="$app/Contents/MacOS/Aether"
    rm -rf "$app"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    cat >"$bin" <<EOF
#!/usr/bin/env bash
set -euo pipefail

root="$root"
cmp() {
  local a="\${1#v}"
  local b="\${2#v}"
  a="\${a%%-*}"
  b="\${b%%-*}"
  local aa bb i x y
  IFS=. read -r -a aa <<<"\$a"
  IFS=. read -r -a bb <<<"\$b"
  for i in 0 1 2 3; do
    x="\${aa[\$i]:-0}"
    y="\${bb[\$i]:-0}"
    x=\$((10#\$x))
    y=\$((10#\$y))
    if [ "\$x" -lt "\$y" ]; then
      echo lt
      return 0
    fi
    if [ "\$x" -gt "\$y" ]; then
      echo gt
      return 0
    fi
  done
  echo eq
}

pick() {
  local dir ver best best_ver item
  if [ -f "\$root/.aether_web_version" ]; then
    ver="\$(tr -d '[:space:]' <"\$root/.aether_web_version")"
    if [ -n "\$ver" ] && [ -f "\$root/aether_\$ver/Aether.command" ]; then
      printf "%s" "\$root/aether_\$ver"
      return 0
    fi
  fi
  shopt -s nullglob
  for item in "\$root"/aether_*; do
    [ -d "\$item" ] || continue
    [ -f "\$item/.aether_web_version" ] || continue
    ver="\$(tr -d '[:space:]' <"\$item/.aether_web_version")"
    [ -n "\$ver" ] || continue
    if [ -z "\${best:-}" ] || [ "\$(cmp "\$best_ver" "\$ver")" = "lt" ]; then
      best="\$item"
      best_ver="\$ver"
    fi
  done
  shopt -u nullglob
  printf "%s" "\${best:-}"
}

app="\$(pick)"
if [ -n "\$app" ] && [ -f "\$app/Aether.command" ]; then
  nohup "\$app/Aether.command" >/dev/null 2>&1 &
  exit 0
fi

echo "No active version found under: $root"
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

  target="/Applications"
  if build_app "$target" 2>/dev/null; then
    launch="$target/Aether.app"
    launch_note="从 app 启动器中运行Aether。"
    return 0
  fi

  target="$HOME/Applications"
  mkdir -p "$target"
  build_app "$target"
  launch="$target/Aether.app"
  launch_note="无法写入 /Applications，已回退到 $launch。手动复制该 App 到 /Applications后，从 app 启动器中运行Aether，或在\"$HOME/Applications\"文件夹中双击Aether.app运行。"
}

if [ "$base" != "downloads" ]; then
  fail "规范错误：update_darwin.command 必须放在 .../aether/downloads 目录。当前: $self"
fi
if [ "$(basename "$work")" != "aether" ]; then
  fail "规范错误：工作目录必须是 .../aether。当前: $work"
fi
if [ ! -f "$work/aether_darwin_installer.command" ]; then
  fail "规范错误：缺少 .../aether/aether_darwin_installer.command"
fi

echo "[0/4] 工作目录: $work"

pick="$(pick_pkg "$self" "$want" || true)"
[ -n "$pick" ] || fail "未在 .../aether/downloads 找到可用 dmg（文件名需包含版本号）"

pkg="${pick%%|*}"
ver="${pick##*|}"
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

rm -rf "$target"
mv "$next" "$target"
chflags nohidden "$target" >/dev/null 2>&1 || true

shopt -s nullglob
for dir in "$work"/aether_*; do
  [ -d "$dir" ] || continue
  chflags nohidden "$dir" >/dev/null 2>&1 || true
done
shopt -u nullglob

chmod +x "$target/aether" "$target/Aether.command"
uv="$target/wechat-bridge/runtime/uv/uv-0.6.14-aarch64-apple-darwin/uv"
if [ -f "$uv" ]; then
  chmod +x "$uv"
fi
xattr -cr "$target/aether" "$target/Aether.command" >/dev/null 2>&1 || true
if [ -f "$uv" ]; then
  xattr -cr "$uv" >/dev/null 2>&1 || true
fi
printf "%s\n" "$ver" >"$target/.aether_web_version"
printf "%s\n" "$ver" >"$work/.aether_web_version"

rm -rf "$work/current" >/dev/null 2>&1 || true
write_launch "$work"
prune_versions "$work" 5 "$target"

if [ "$restart" = "1" ]; then
  if [ -n "$old" ]; then
    pkill -f "$old/Aether.command" >/dev/null 2>&1 || true
    pkill -f "$old/aether web" >/dev/null 2>&1 || true
    pkill -f "$old/aether serve" >/dev/null 2>&1 || true
  fi
  pkill -f "$target/Aether.command" >/dev/null 2>&1 || true
  pkill -f "$target/aether web" >/dev/null 2>&1 || true
  pkill -f "$target/aether serve" >/dev/null 2>&1 || true
  nohup "$target/Aether.command" >/dev/null 2>&1 &
fi

if [ "$prune" -gt 0 ]; then
  echo "[3/4] 保留最近 5 个版本，已清理 $prune 个旧版本目录"
else
  echo "[3/4] 保留最近 5 个版本，无需清理旧版本目录"
fi

echo "[4/4] 完成"
echo "当前版本: $ver"
echo "版本目录: $target"
echo "启动入口: $launch"
if [ -n "$launch_note" ]; then
  echo "$launch_note"
fi
