#!/usr/bin/env bash

set -euo pipefail

DEBUG_DIR="$HOME/.cache/aether/update_debug"
if [ -n "${AETHER_DEBUG_LOG:-}" ]; then
  DEBUG_LOG="$AETHER_DEBUG_LOG"
else
  DEBUG_TS="$(date +%Y%m%d_%H%M%S)"
  DEBUG_LOG="$DEBUG_DIR/install_${DEBUG_TS}.log"
fi
mkdir -p "$DEBUG_DIR" 2>/dev/null || true

debug_log() {
  [ -d "$DEBUG_DIR" ] || return 0
  printf '%s | %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$DEBUG_LOG" 2>/dev/null || true
}

debug_log "========== NEW GITHUB INSTALL RUN =========="

pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
debug_log "PGID | pid=$$ pgid=${pgid:-unknown} ppid=$PPID bash=${BASH_VERSION:-unknown}"
if [ "${AETHER_REEXECED:-0}" != "1" ] && [ "${pgid:-}" != "$$" ] && [ -n "${pgid:-}" ]; then
  if command -v python3 >/dev/null 2>&1; then
    export AETHER_REEXECED=1 AETHER_DEBUG_LOG="$DEBUG_LOG"
    exec python3 -c "import os,sys; os.setsid(); os.execvp('bash', ['bash'] + sys.argv[1:])" "$0" "$@"
  fi
fi

ok=0
latest_ok=20
run_err=33
dir_err=40
arg_err=50

case "$(uname -m)" in
  arm64) arch="arm64" ;;
  x86_64) arch="x64" ;;
  *)
    echo "Unsupported macOS architecture: $(uname -m)"
    exit "$arg_err"
    ;;
esac

default="$HOME/Applications/aether"
work="$HOME/.local/share/aether/update/aether"
path=""
restart="1"
pkg="aether-darwin-$arch"
next=""
res=""
prune="0"
launch=""
launch_note=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --path)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--path needs a value"
        exit "$arg_err"
      fi
      path="$1"
      ;;
    --no-restart)
      restart="0"
      ;;
    help|-h|--help)
      cat <<EOF
Aether macOS GitHub Release Installer

Usage:
  $(basename "$0") [--path <dir>] [--no-restart]

Options:
  --path <dir>    Install target directory (default $default)
  --no-restart    Do not restart Aether after install
EOF
      exit "$ok"
      ;;
    *)
      echo "Unsupported argument: $1"
      exit "$arg_err"
      ;;
  esac
  shift
done

trap 'debug_log "SIGNAL | received SIGTERM, pid=$$, ppid=$PPID"; exit 1' SIGTERM
trap 'debug_log "SIGNAL | received SIGINT, pid=$$, ppid=$PPID"; exit 1' SIGINT
trap 'debug_log "SIGNAL | received SIGHUP, pid=$$, ppid=$PPID"; exit 1' SIGHUP
trap 'debug_log "SIGNAL | received SIGQUIT, pid=$$, ppid=$PPID"; exit 1' SIGQUIT
trap 'debug_log "SIGNAL | received SIGPIPE, pid=$$, ppid=$PPID"; exit 1' SIGPIPE
trap 'debug_log "EXIT | code=$?"' EXIT

fail() {
  write_result "failed" "${2:-recover}" "$1"
  debug_log "FAIL | error=$1 action=${2:-recover}"
  echo "$1"
  clean
  exit "$run_err"
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
  debug_log "RESULT | status=$(flat "$1") version=$(flat "$ver") action=$(flat "${2:-}") error=$(flat "${3:-}")"
}

clean() {
  debug_log "CLEANUP | next=${next:-}"
  if [ -n "$next" ] && [ -d "$next" ]; then
    rm -rf "$next"
  fi
}

normalize() {
  local dir base
  dir="$1"
  base="$(basename "$dir")"
  if [ "$base" = "aether" ]; then
    printf "%s" "$dir"
    return 0
  fi
  printf "%s/aether" "$dir"
}

source_dir() {
  local dir="$1"
  local name
  name="$(basename "$dir")"
  if [ -f "$dir/aether" ] && [ -f "$dir/Aether.command" ]; then
    if [ "$name" != "$pkg" ]; then
      printf ""
      return 0
    fi
    printf "%s" "$dir"
    return 0
  fi
  if [ -d "$dir/$pkg" ] && [ -f "$dir/$pkg/aether" ] && [ -f "$dir/$pkg/Aether.command" ]; then
    printf "%s" "$dir/$pkg"
    return 0
  fi
  printf ""
}

source_error() {
  local dir="$1"
  local name
  name="$(basename "$dir")"
  if [ -f "$dir/aether" ] && [ -f "$dir/Aether.command" ] && [ "$name" != "$pkg" ]; then
    printf "Package architecture mismatch: expected %s, got %s" "$pkg" "$name"
    return 0
  fi
  printf "Missing app files (aether/Aether.command) in %s" "$dir"
}

cmp() {
  local a b aa bb i x y
  a="${1#v}"
  b="${2#v}"
  a="${a%%-*}"
  b="${b%%-*}"
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

installed() {
  local root name best_ver dir v
  root="$1"
  name="$(basename "$root")"
  if [[ "$name" =~ ^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$ ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
    return 0
  fi
  best_ver=""
  shopt -s nullglob
  for dir in "$root"/aether_* "$root"/aether-*; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    if [[ "$name" =~ ^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$ ]]; then
      v="${BASH_REMATCH[1]}"
      if [ -z "$best_ver" ] || [ "$(cmp "$best_ver" "$v")" = "lt" ]; then
        best_ver="$v"
      fi
    fi
  done
  shopt -u nullglob
  printf "%s" "$best_ver"
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

dir_version() {
  local dir name v
  dir="$1"
  if [ -f "$dir/.aether_web_version" ]; then
    v="$(tr -d '[:space:]' <"$dir/.aether_web_version")"
    if [ -n "$v" ]; then
      printf "%s" "$v"
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
  local root best best_ver dir v
  root="$1"
  best=""
  best_ver=""
  shopt -s nullglob
  for dir in "$root"/aether_*; do
    [ -d "$dir" ] || continue
    v="$(dir_version "$dir")"
    [ -n "$v" ] || continue
    if [ -z "$best" ] || [ "$(cmp "$best_ver" "$v")" = "lt" ]; then
      best="$dir"
      best_ver="$v"
    fi
  done
  shopt -u nullglob
  printf "%s" "$best"
}

prune_versions() {
  local root keep hold dir v item tmp i j
  local -a items=()
  local -a keepers=()
  root="$1"
  keep="$2"
  hold="$3"
  prune="0"
  shopt -s nullglob
  for dir in "$root"/aether_*; do
    [ -d "$dir" ] || continue
    v="$(dir_version "$dir")"
    [ -n "$v" ] || continue
    items+=("$v|$dir")
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
  if [ -n "$hold" ]; then
    keepers+=("$hold")
  fi
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

in_work() {
  local cur root
  cur="${AETHER_CURRENT_DIR:-}"
  root="$1"
  [ -n "$cur" ] || return 1
  [ -n "$root" ] || return 1
  cur="$(cd "$(dirname "$cur")" && pwd)/$(basename "$cur")"
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

mirror_dir() {
  local root dst tmp
  root="$mirror"
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

build_app() {
  local dest final app bin cmd icon icon_name lsreg
  dest="$1"
  final="$2"
  app="$dest/Aether.app"
  bin="$app/Contents/MacOS/Aether"
  cmd="$final/Aether.command"
  icon="$final/aether-icon.icns"
  icon_name="appIcon-$ver.icns"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cat >"$bin" <<EOF
#!/usr/bin/env bash
set -euo pipefail

cmd="$cmd"
port=""
aether_dir="\$HOME/Library/Application Support/aether"
ch_dirs=()
for ch_dir in "\$aether_dir"/*/; do
  base="\$(basename "\$ch_dir")"
  if [ "\$base" = "prod" ]; then
    ch_dirs=("\$ch_dir" "\${ch_dirs[@]}")
  else
    ch_dirs+=("\$ch_dir")
  fi
done
for ch_dir in "\${ch_dirs[@]}"; do
  pf="\${ch_dir}serve-port"
  if [ -f "\$pf" ]; then
    p="\$(head -1 "\$pf" 2>/dev/null || true)"
    if [ -n "\$p" ]; then
      if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:\$p/" >/dev/null 2>&1; then
        port="\$p"
        break
      fi
    fi
  fi
done
if [ -n "\$port" ]; then
  open "http://127.0.0.1:\$port/"
  exit 0
fi

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
  cat >"$app/Contents/Info.plist" <<EOF
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
  <string>$ver</string>
  <key>CFBundleShortVersionString</key>
  <string>$ver</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>Aether</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>Aether</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>aether</string>
      </array>
    </dict>
  </array>
  <key>CFBundleIconFile</key>
  <string>$icon_name</string>
</dict>
</plist>
EOF
  if [ -f "$icon" ]; then
    cp "$icon" "$app/Contents/Resources/$icon_name"
    touch "$app/Contents/Resources/$icon_name" 2>/dev/null || true
  fi
  touch "$app/Contents/Info.plist" 2>/dev/null || true
  touch "$app"
  xattr -cr "$app" >/dev/null 2>&1 || true
  lsreg="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  if [ -x "$lsreg" ]; then
    "$lsreg" -f "$app" >/dev/null 2>&1 || true
  fi
}

write_launch() {
  local final dest
  final="$1"
  dest="/Applications"
  if build_app "$dest" "$final" 2>/dev/null; then
    launch="$dest/Aether.app"
    launch_note="Run Aether from the application launcher."
    return 0
  fi
  dest="$HOME/Applications"
  mkdir -p "$dest"
  build_app "$dest" "$final"
  launch="$dest/Aether.app"
  launch_note="Could not write /Applications; fell back to $launch."
}

stop_roots=()

add_stop_root() {
  local dir item
  dir="${1:-}"
  [ -n "$dir" ] || return 0
  [ -d "$dir" ] || return 0
  dir="$(cd "$dir" 2>/dev/null && pwd)" || return 0
  if [ ${#stop_roots[@]} -gt 0 ]; then
    for item in "${stop_roots[@]}"; do
      [ "$item" = "$dir" ] && return 0
    done
  fi
  stop_roots+=("$dir")
}

collect_stop_roots() {
  local dir
  stop_roots=()
  add_stop_root "$old"
  add_stop_root "$target"
  add_stop_root "${AETHER_CURRENT_DIR:-}"
  add_stop_root "$copy_target"
  shopt -s nullglob
  for dir in "$work"/aether_* "$mirror"/aether_*; do
    add_stop_root "$dir"
  done
  shopt -u nullglob
}

runtime_pids() {
  local pid cmd root matched
  ps -axo pid=,command= | while read -r pid cmd; do
    [ -n "$pid" ] || continue
    [ "$pid" = "$$" ] && continue
    case "$cmd" in
      *install.command*) continue ;;
    esac
    matched=""
    for root in "${stop_roots[@]}"; do
      case "$cmd" in
        *"$root/"*)
          case "$cmd" in
            *"/aether "*|*"/aether"|*"Aether.command"*|*"Aether.sh"*|*"Aether.sh.real"*)
              echo "$pid"
              matched="1"
              break
              ;;
          esac
          ;;
      esac
    done
    [ -n "$matched" ] || true
  done | sort -u
}

wait_runtime() {
  local tries pids
  tries="$1"
  while [ "$tries" -gt 0 ]; do
    pids="$(runtime_pids)"
    [ -z "$pids" ] && return 0
    sleep 1
    tries=$((tries - 1))
  done
  return 1
}

stop_all_runtime() {
  local pids
  collect_stop_roots
  pids="$(runtime_pids)"
  [ -n "$pids" ] || return 0
  echo "Stopping old Aether processes..."
  kill $pids >/dev/null 2>&1 || true
  wait_runtime 5 && return 0
  pids="$(runtime_pids)"
  if [ -n "$pids" ]; then
    kill -9 $pids >/dev/null 2>&1 || true
  fi
  wait_runtime 3 || echo "Warning: old Aether processes are still running; starting the new version anyway."
}

boot() {
  local dir="$1"
  [ -x "$dir/Aether.command" ] || return 1
  AETHER_WEB_OPEN_FALLBACK_MS="${AETHER_WEB_OPEN_FALLBACK_MS:-3000}" nohup "$dir/Aether.command" >/dev/null 2>&1 &
}

self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$(source_dir "$self")"
[ -n "$src" ] || fail "$(source_error "$self")"
[ -f "$src/.aether_web_version" ] || fail "Missing .aether_web_version in $src"
ver="$(tr -d '[:space:]' <"$src/.aether_web_version")"
[ -n "$ver" ] || fail "Empty .aether_web_version in $src"
mirror="$(normalize "${path:-$default}")"
target="$work/aether_$ver"
next="$work/.aether_$ver.next"
res="$work/downloads/web-update-result.env"
export AETHER_MIRROR_ROOT="$mirror"
export AETHER_CURRENT_DIR="$mirror/aether_$ver"
rm -f "$res" >/dev/null 2>&1 || true

echo "Aether macOS GitHub Release Installer"
echo
echo "Source directory:"
echo "  $src"
echo "Work directory:"
echo "  $work"
echo "Install directory:"
echo "  $mirror"
echo "Version:"
echo "  $ver"

mkdir -p "$work" "$work/downloads" "$mirror" || exit "$dir_err"

cur="$(installed "$mirror")"
if [ -n "$cur" ] && [ "$(cmp "$cur" "$ver")" = "eq" ]; then
  write_result "up_to_date"
  echo
  echo "Current version: $cur"
  echo "Package version: $ver"
  echo "Already up to date."
  exit "$latest_ok"
fi

old="$(latest_dir "$work")"
rm -rf "$next" "$target"
mkdir -p "$next" || fail "Failed to prepare version directory: $next"
ditto "$src" "$next" || fail "Failed to copy files into $next"
rm -f "$next/install.command"
mv "$next" "$target" || fail "Failed to finalize install into $target"

chflags nohidden "$target" >/dev/null 2>&1 || true
shopt -s nullglob
for dir in "$work"/aether_*; do
  [ -d "$dir" ] || continue
  chflags nohidden "$dir" >/dev/null 2>&1 || true
done
shopt -u nullglob

chmod +x "$target/aether" "$target/Aether.command"
uv=""
shopt -s nullglob
for file in "$target"/wechat-bridge/runtime/uv/uv-*apple-darwin*/uv; do
  [ -f "$file" ] || continue
  uv="$file"
  break
done
shopt -u nullglob
if [ -f "$uv" ]; then
  chmod +x "$uv"
fi
xattr -cr "$target/aether" "$target/Aether.command" >/dev/null 2>&1 || true
if [ -f "$uv" ]; then
  xattr -cr "$uv" >/dev/null 2>&1 || true
fi
printf "%s\n" "$ver" >"$target/.aether_web_version"
rm -f "$work/.aether_web_version" >/dev/null 2>&1 || true
rm -rf "$work/current" >/dev/null 2>&1 || true
prune_versions "$work" 1000 "$target"

copy_target=""
mirror_prune=""
if in_work "$work"; then
  copy_note="Current app already runs inside WorkDir; skipped mirror."
elif copy_target="$(mirror_dir || true)" && [ -n "$copy_target" ]; then
  copy_note="Copied the new version near the current app location: $copy_target"
  prune_versions "$mirror" 1000 "$copy_target"
  mirror_prune="$prune"
else
  fail "Failed to copy the new version near ${AETHER_CURRENT_DIR:-the current app}" mirror
fi

final_target="$target"
if [ -n "$copy_target" ]; then
  final_target="$copy_target"
fi
write_launch "$final_target"

if [ "$restart" = "1" ]; then
  stop_all_runtime
  if [ -n "$copy_target" ]; then
    boot "$copy_target" || boot "$target" || fail "Failed to restart Aether from $target/Aether.command"
  else
    boot "$target" || fail "Failed to restart Aether from $target/Aether.command"
  fi
fi

write_result "installed"

echo
echo "[4/4] Done"
echo "Current version: $ver"
echo "Version directory: $target"
if [ -n "$copy_target" ]; then
  echo "Mirror directory: $copy_target"
fi
if [ -n "$mirror_prune" ] && [ "$mirror_prune" -gt 0 ]; then
  echo "Mirror cleanup: removed $mirror_prune older version directories."
fi
echo "Launch entry: $launch"
if [ -n "$launch_note" ]; then
  echo "$launch_note"
fi
if [ -n "${copy_note:-}" ]; then
  echo "$copy_note"
fi

debug_log "END | ver=$ver target=$target copy_target=${copy_target:-} launch=$launch restart=$restart prune=$prune"
debug_log "========== GITHUB INSTALL RUN COMPLETE =========="
exit "$ok"
