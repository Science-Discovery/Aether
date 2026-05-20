#!/usr/bin/env bash

set -euo pipefail

DEBUG_DIR="$HOME/.cache/aether/update_debug"
if [ -n "${AETHER_DEBUG_LOG:-}" ]; then
  DEBUG_LOG="$AETHER_DEBUG_LOG"
else
  DEBUG_TS="$(date +%Y%m%d_%H%M%S)"
  DEBUG_LOG="$DEBUG_DIR/update_${DEBUG_TS}.log"
fi
mkdir -p "$DEBUG_DIR" 2>/dev/null || true

debug_log() {
  printf '%s | %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$DEBUG_LOG" 2>/dev/null || true
}

debug_log "========== NEW UPDATE RUN =========="

ok=0
dl_err=31
run_err=33
arg_err=50

case "$(uname -m)" in
  aarch64|arm64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *)
    echo "Unsupported Linux architecture: $(uname -m)"
    exit "$arg_err"
    ;;
esac

pkg_base="aether-linux-$arch"

mode="install"
arg=""
tmp=""
next=""
prune="0"
restart="0"
res=""
mirror_only="${AETHER_MIRROR_ONLY:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    install|help|-h|--help)
      mode="$1"
      ;;
    --restart)
      restart="1"
      ;;
    *)
      if [ -z "$arg" ]; then
        arg="$1"
      else
        echo "Unsupported argument: $1"
        exit "$arg_err"
      fi
      ;;
  esac
  shift
done

_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
_sid="$(ps -o sid= -p $$ 2>/dev/null | tr -d ' ')"
debug_log "PGID | pid=$$ pgid=${_pgid:-unknown} ppid=$PPID bash=${BASH_VERSION:-unknown}"
_pparent_cmd="$(ps -o command= -p $PPID 2>/dev/null || true)"
debug_log "PGID | parent_cmd=${_pparent_cmd:-unknown}"
debug_log "PGID | sid=${_sid:-unknown} in_own_session=$([ -n "${_sid:-}" ] && [ "$_sid" = "$$" ] && echo yes || echo no)"

trap 'debug_log "SIGNAL | received SIGTERM, pid=$$, ppid=$PPID"; exit 1' SIGTERM
trap 'debug_log "SIGNAL | received SIGINT, pid=$$, ppid=$PPID"; exit 1' SIGINT
trap 'debug_log "SIGNAL | received SIGHUP, pid=$$, ppid=$PPID"; exit 1' SIGHUP
trap 'debug_log "SIGNAL | received SIGQUIT, pid=$$, ppid=$PPID"; exit 1' SIGQUIT
trap 'debug_log "SIGNAL | received SIGPIPE, pid=$$, ppid=$PPID"; exit 1' SIGPIPE
trap 'debug_log "EXIT | code=$?"' EXIT

help() {
  cat <<EOF
Aether Linux Local Installer

Usage:
  $(basename "$0") install <version>
  $(basename "$0") <version>

Behavior:
  - Local install only; no network download
  - Installs to a versioned directory: aether_<version>
  - Marks the latest installed version in .aether_web_version

Package name pattern:
  $pkg_base-<version>.*

Exit codes:
  0   install finished successfully
  31  local package not found
  33  extract/install failed
  50  argument error
EOF
}

clean() {
  debug_log "EXIT | code=$?"
  debug_log "CLEANUP | tmp=${tmp:-} next=${next:-}"
  if [ -n "$tmp" ] && [ -d "$tmp" ]; then
    rm -rf "$tmp"
  fi
  if [ -n "$next" ] && [ -d "$next" ]; then
    rm -rf "$next"
  fi
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

fail() {
  local msg="$1"
  local action="${2:-recover}"
  write_result "failed" "$action" "$msg"
  debug_log "FAIL | error=$msg action=$action"
  echo "$msg"
  clean
  exit "$run_err"
}

pick_home() {
  local home="$HOME"
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    debug_log "PICK_HOME | SUDO_USER=$SUDO_USER resolving home"
    if command -v getent >/dev/null 2>&1; then
      home="$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6)"
    else
      home=""
    fi
    if [ -z "$home" ]; then
      home="$(eval echo "~$SUDO_USER" 2>/dev/null || true)"
    fi
    [ -n "$home" ] || home="$HOME"
  fi
  debug_log "PICK_HOME | resolved=$home"
  printf "%s" "$home"
}

pick_src() {
  local ex="$1"
  if [ -f "$ex/aether" ] && [ -f "$ex/Aether.sh" ]; then
    printf "%s" "$ex"
    return 0
  fi

  shopt -s nullglob
  for d in "$ex"/*; do
    if [ -d "$d" ] && [ -f "$d/aether" ] && [ -f "$d/Aether.sh" ]; then
      printf "%s" "$d"
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  printf ""
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

mirror_root() {
  if [ -n "${AETHER_MIRROR_ROOT:-}" ]; then
    mkdir -p "${AETHER_MIRROR_ROOT}" 2>/dev/null || true
    cd "${AETHER_MIRROR_ROOT}" && pwd
    debug_log "MIRROR_ROOT | resolved via AETHER_MIRROR_ROOT: $(pwd)"
    return 0
  fi
  local cur
  cur="${AETHER_CURRENT_DIR:-}"
  [ -n "$cur" ] || { debug_log "MIRROR_ROOT | AETHER_CURRENT_DIR empty, returning 1"; return 1; }
  mkdir -p "$(dirname "$cur")" 2>/dev/null || true
  cd "$cur/.." && pwd
  debug_log "MIRROR_ROOT | resolved via AETHER_CURRENT_DIR: $(pwd)"
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

list_ssl() {
  {
    if command -v ldconfig >/dev/null 2>&1; then
      ldconfig -p 2>/dev/null | awk '/libssl\.so\./{print $NF}'
    fi
    for p in /lib /usr/lib /lib64 /usr/lib64 /usr/local/lib /usr/local/lib64 /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu /lib/aarch64-linux-gnu /usr/lib/aarch64-linux-gnu; do
      [ -d "$p" ] || continue
      find "$p" -maxdepth 2 -type f -name 'libssl.so.*' 2>/dev/null
    done
  } | awk 'NF && !seen[$0]++'
}

list_crypto() {
  {
    if command -v ldconfig >/dev/null 2>&1; then
      ldconfig -p 2>/dev/null | awk '/libcrypto\.so\./{print $NF}'
    fi
    for p in /lib /usr/lib /lib64 /usr/lib64 /usr/local/lib /usr/local/lib64 /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu /lib/aarch64-linux-gnu /usr/lib/aarch64-linux-gnu; do
      [ -d "$p" ] || continue
      find "$p" -maxdepth 2 -type f -name 'libcrypto.so.*' 2>/dev/null
    done
  } | awk 'NF && !seen[$0]++'
}

has_ssl3() {
  if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q '\blibssl\.so\.3\b'; then
    return 0
  fi
  list_ssl | grep -q '/libssl.so.3$'
}

probe_pair() {
  local dir="$1"
  local ssl="$2"
  local crypto="$3"
  local probe="$dir/.ssl_probe"

  rm -rf "$probe" 2>/dev/null || true
  mkdir -p "$probe" || return 1
  ln -sf "$ssl" "$probe/libssl.so.3" || return 1
  ln -sf "$crypto" "$probe/libcrypto.so.3" || return 1

  if ! command -v ldd >/dev/null 2>&1 || [ ! -x "$dir/aether" ]; then
    rm -rf "$probe" 2>/dev/null || true
    return 0
  fi

  local out
  out="$(LD_LIBRARY_PATH="$probe${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ldd "$dir/aether" 2>/dev/null || true)"
  rm -rf "$probe" 2>/dev/null || true
  if [ -z "$out" ]; then
    return 1
  fi

  if printf "%s\n" "$out" | grep -q 'libssl.so.3 => .*not found'; then
    return 1
  fi
  if printf "%s\n" "$out" | grep -q 'libcrypto.so.3 => .*not found'; then
    return 1
  fi
  return 0
}

pick_pair() {
  local dir="$1"
  local ssl_ref="$2"
  local crypto_ref="$3"
  local ssl=""
  local crypto=""
  local c=""

  mapfile -t _ssl < <(list_ssl)
  mapfile -t _crypto < <(list_crypto)

  for ssl in "${_ssl[@]}"; do
    [ -f "$ssl" ] || continue
    local sdir
    sdir="$(dirname "$ssl")"

    crypto=""
    if [ -f "$sdir/libcrypto.so.1.1" ]; then
      crypto="$sdir/libcrypto.so.1.1"
    fi
    if [ -z "$crypto" ]; then
      crypto="$(find "$sdir" -maxdepth 1 -type f -name 'libcrypto.so.1.*' 2>/dev/null | head -1)"
    fi
    if [ -z "$crypto" ]; then
      for c in "${_crypto[@]}"; do
        if [[ "$c" == "$sdir"/* ]]; then
          crypto="$c"
          break
        fi
      done
    fi
    if [ -z "$crypto" ]; then
      for c in "${_crypto[@]}"; do
        crypto="$c"
        break
      done
    fi
    [ -n "$crypto" ] || continue
    if probe_pair "$dir" "$ssl" "$crypto"; then
      printf -v "$ssl_ref" '%s' "$ssl"
      printf -v "$crypto_ref" '%s' "$crypto"
      return 0
    fi
  done

  return 1
}

fix_libssl() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  debug_log "SSL | checking libssl.so.3 in $dir"

  if has_ssl3; then
    debug_log "SSL | libssl.so.3 found on system, no fix needed"
    return 0
  fi
  debug_log "SSL | libssl.so.3 NOT found on system, searching for compatible pair"

  local ssl=""
  local crypto=""
  if ! pick_pair "$dir" ssl crypto; then
    debug_log "SSL | no usable libssl/libcrypto pair found"
    echo "[install] Warning: libssl.so.3 is missing, and no usable libssl/libcrypto pair was found."
    echo "[install] Please install libssl3 (preferred) or a compatible OpenSSL runtime and retry."
    return 0
  fi
  debug_log "SSL | found pair ssl=$ssl crypto=$crypto"

  local lib="$dir/lib"
  mkdir -p "$lib"
  ln -sf "$ssl" "$lib/libssl.so.3"
  ln -sf "$crypto" "$lib/libcrypto.so.3"
  debug_log "SSL | symlink $lib/libssl.so.3 -> $ssl"
  debug_log "SSL | symlink $lib/libcrypto.so.3 -> $crypto"
  echo "[install] Added compatibility symlinks in $lib"
  echo "[install]   libssl.so.3 -> $ssl"
  echo "[install]   libcrypto.so.3 -> $crypto"

  local launch="$dir/Aether.sh"
  local real="$dir/Aether.sh.real"
  if [ -f "$launch" ] && [ ! -f "$real" ]; then
    mv "$launch" "$real"
    debug_log "SSL | moved Aether.sh -> Aether.sh.real, writing wrapper"
    cat > "$launch" <<'EOF'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export LD_LIBRARY_PATH="$DIR/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if [ -x "$DIR/Aether.sh.real" ]; then
  exec "$DIR/Aether.sh.real" "$@"
fi
exec "$DIR/aether" web "$@"
EOF
    chmod +x "$launch"
    debug_log "SSL | patched Aether.sh with compatibility wrapper"
    echo "[install] Patched Aether.sh with compatibility wrapper."
  fi
}

write_launch() {
  local target="$1"
  local app="$target/Aether.sh"
  local icon="$target/aether-icon.png"
  local home
  home="$(pick_home)"
  local apps="$home/.local/share/applications"
  mkdir -p "$apps" || return 1
  debug_log "LAUNCH | writing desktop entry apps=$apps/aether.desktop app=$app"

  local icon_line=""
  if [ -f "$icon" ]; then
    icon_line="Icon=$icon"
  fi

  cat > "$apps/aether.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Aether
Comment=AI-powered development tool
Exec="$app"
$icon_line
Categories=Development;IDE;
Terminal=false
StartupNotify=true
EOF
  chmod +x "$apps/aether.desktop" || true

  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$apps" 2>/dev/null || true
    debug_log "LAUNCH | update-desktop-database ran"
  fi

  local desk="$home/Desktop"
  mkdir -p "$desk" || return 1
  if [ -f "$apps/aether.desktop" ]; then
    cp "$apps/aether.desktop" "$desk/aether.desktop" 2>/dev/null || true
    chmod +x "$desk/aether.desktop" || true
    debug_log "LAUNCH | copied desktop entry to $desk/aether.desktop"
  fi

  printf "%s" "$apps/aether.desktop"
}

stop() {
  local dir="$1"
  [ -n "$dir" ] || return 0
  pkill -f "$dir/Aether.sh" >/dev/null 2>&1 || true
  pkill -f "$dir/aether web" >/dev/null 2>&1 || true
  pkill -f "$dir/aether serve" >/dev/null 2>&1 || true
}

stop_roots=()

add_stop_root() {
  local dir item
  dir="${1:-}"
  debug_log "STOP_ROOT | call: input=${1:-}"
  [ -n "$dir" ] || { debug_log "STOP_ROOT | skip: empty input"; return 0; }
  [ -d "$dir" ] || { debug_log "STOP_ROOT | skip: not a dir: $dir"; return 0; }
  dir="$(cd "$dir" 2>/dev/null && pwd)" || { debug_log "STOP_ROOT | skip: cd failed: ${1:-}"; return 0; }
  if [ ${#stop_roots[@]} -gt 0 ]; then
    for item in "${stop_roots[@]}"; do
      [ "$item" = "$dir" ] && { debug_log "STOP_ROOT | skip: duplicate: $dir"; return 0; }
    done
  fi
  stop_roots+=("$dir")
  debug_log "STOP_ROOT | added: $dir"
}

collect_stop_roots() {
  local dir root
  stop_roots=()
  debug_log "COLLECT | old=${old:-} target=${target:-} AETHER_CURRENT_DIR=${AETHER_CURRENT_DIR:-} copy_target=${copy_target:-}"
  add_stop_root "$old"
  add_stop_root "$target"
  add_stop_root "${AETHER_CURRENT_DIR:-}"
  add_stop_root "$copy_target"
  shopt -s nullglob
  for dir in "$work"/aether_*; do
    add_stop_root "$dir"
  done
  root="$(mirror_root || true)"
  if [ -n "$root" ]; then
    debug_log "COLLECT | mirror_root=$root"
    for dir in "$root"/aether_*; do
      add_stop_root "$dir"
    done
  else
    debug_log "COLLECT | mirror_root: empty or failed"
  fi
  shopt -u nullglob
  if [ ${#stop_roots[@]} -gt 0 ]; then
    debug_log "COLLECT | stop_roots count=${#stop_roots[@]} roots=${stop_roots[*]}"
  else
    debug_log "COLLECT | stop_roots count=0 roots=(empty)"
  fi
}

runtime_pids() {
  local pid cmd root matched
  debug_log "PIDS | scanning processes, stop_roots count=${#stop_roots[@]}"
  ps -axo pid=,command= | while read -r pid cmd; do
    [ -n "$pid" ] || continue
    [ "$pid" = "$$" ] && continue
    case "$cmd" in
      *update_linux.sh*) continue ;;
    esac
    matched=""
    for root in "${stop_roots[@]}"; do
      case "$cmd" in
        *"$root/"*)
          case "$cmd" in
            *"/aether "*|*"/aether"|*"Aether.command"*|*"Aether.sh"*|*"Aether.sh.real"*)
              debug_log "PIDS | matched: pid=$pid root=$root cmd=$cmd"
              echo "$pid"
              matched="1"
              break
              ;;
            *)
              debug_log "PIDS | path_hit_cmd_miss: pid=$pid root=$root cmd=$cmd"
              ;;
          esac
          ;;
      esac
    done
    if [ -z "$matched" ]; then
      case "$cmd" in
        */aether*|*Aether.command*|*Aether.sh*) debug_log "PIDS | aether_no_root: pid=$pid cmd=$cmd" ;;
      esac
    fi
  done | sort -u
}

wait_runtime() {
  local tries pids
  tries="$1"
  debug_log "WAIT | entering wait_runtime, max tries=$tries"
  while [ "$tries" -gt 0 ]; do
    pids="$(runtime_pids)"
    [ -z "$pids" ] && { debug_log "WAIT | all processes gone, returning 0"; return 0; }
    debug_log "WAIT | tries left=$tries, remaining pids: $pids"
    sleep 1
    tries=$((tries - 1))
  done
  debug_log "WAIT | timed out, returning 1"
  return 1
}

stop_all_runtime() {
  local pids
  collect_stop_roots
  pids="$(runtime_pids)"
  debug_log "STOP_ALL | initial pids: ${pids:-none}"
  [ -n "$pids" ] || { debug_log "STOP_ALL | no processes found, returning"; return 0; }
  echo "[install] Stopping old Aether processes..."
  debug_log "STOP_ALL | SIGTERM to pids: $pids"
  kill $pids >/dev/null 2>&1 || true
  debug_log "STOP_ALL | waiting up to 5s after SIGTERM"
  wait_runtime 5 && { debug_log "STOP_ALL | all exited after SIGTERM"; return 0; }
  pids="$(runtime_pids)"
  debug_log "STOP_ALL | remaining pids after SIGTERM+wait: ${pids:-none}"
  if [ -n "$pids" ]; then
    debug_log "STOP_ALL | SIGKILL to pids: $pids"
    kill -9 $pids >/dev/null 2>&1 || true
  fi
  debug_log "STOP_ALL | waiting up to 3s after SIGKILL"
  if ! wait_runtime 3; then
    debug_log "STOP_ALL | WARNING: processes still alive after SIGKILL+wait"
    echo "[install] Warning: old Aether processes are still running; starting the new version anyway."
  else
    debug_log "STOP_ALL | all exited after SIGKILL"
  fi
}

boot() {
  local app="$1/Aether.sh"
  debug_log "BOOT | dir=$1 app=$app"
  [ -x "$app" ] || { debug_log "BOOT | Aether.sh not executable: $app"; return 1; }
  if command -v setsid >/dev/null 2>&1; then
    debug_log "BOOT | launching via setsid"
    AETHER_WEB_OPEN_FALLBACK_MS="${AETHER_WEB_OPEN_FALLBACK_MS:-3000}" setsid "$app" >/dev/null 2>&1 < /dev/null &
    debug_log "BOOT | setsid pid=$!"
    return 0
  fi
  debug_log "BOOT | setsid unavailable, launching via nohup"
  AETHER_WEB_OPEN_FALLBACK_MS="${AETHER_WEB_OPEN_FALLBACK_MS:-3000}" nohup "$app" >/dev/null 2>&1 < /dev/null &
  debug_log "BOOT | nohup pid=$!"
}

register_protocol() {
  local target="$1"
  local handler="$target/aether-protocol-handler.sh"
  [ -f "$handler" ] || { debug_log "REG | no protocol handler at $handler"; return 0; }
  debug_log "REG | registering protocol handler=$handler"
  local icon="$target/aether-icon.png"
  local apps="$HOME/.local/share/applications"
  mkdir -p "$apps" || return 0
  local desk="$apps/aether-url-handler.desktop"

  local icon_line=""
  if [ -f "$icon" ]; then
    icon_line="Icon=$icon"
  fi

  cat > "$desk" <<DEOF
[Desktop Entry]
Type=Application
Name=Aether URL Handler
Exec="$handler" %u
MimeType=x-scheme-handler/aether;
NoDisplay=true
$icon_line
DEOF
  chmod +x "$desk" || return 0
  debug_log "REG | wrote desktop entry=$desk"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$apps" 2>/dev/null || true
    debug_log "REG | update-desktop-database ran"
  fi
  if command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime default aether-url-handler.desktop x-scheme-handler/aether 2>/dev/null || true
    debug_log "REG | xdg-mime default ran"
  fi
}

mirror_dir() {
  local root dst tmp
  root="$(mirror_root || true)"
  [ -n "$root" ] || return 1
  dst="$(mirror_target "$root")"
  debug_log "MIRROR_DIR | root=$root dst=$dst"
  tmp="${dst}.copy"
  rm -rf "$tmp" "$dst" 2>/dev/null || true
  mkdir -p "$tmp" || return 1
  debug_log "MIRROR_DIR | cp -R target=$target tmp=$tmp"
  cp -R "$target"/. "$tmp" || {
    debug_log "MIRROR_DIR | cp -R failed: target=$target tmp=$tmp"
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  }
  debug_log "MIRROR_DIR | cp -R success, moving tmp to dst"
  mv "$tmp" "$dst" || {
    debug_log "MIRROR_DIR | mv failed: tmp=$tmp dst=$dst"
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  }
  debug_log "MIRROR_DIR | mirror complete: $dst"
  printf "%s" "$dst"
}

if [ "$mode" = "help" ] || [ "$mode" = "--help" ] || [ "$mode" = "-h" ]; then
  help
  exit "$ok"
fi

if [ "$mode" = "install" ] && [ -z "$arg" ]; then
  echo "install mode needs a version."
  echo "Example: $(basename "$0") install 0.3.0"
  exit "$arg_err"
fi

if [ "$mode" != "install" ] && [ -n "$arg" ]; then
  mode="install"
fi

if [ "$mode" != "install" ]; then
  echo "Unsupported mode: $mode"
  exit "$arg_err"
fi

trap clean EXIT

ver="$arg"
dl="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(cd "$dl/.." && pwd)"
target="$work/aether_$ver"
next="$work/.aether_$ver.next"
res="${AETHER_UPDATE_RESULT:-$work/downloads/web-update-result.env}"

debug_log "START | mode=$mode ver=$ver restart=$restart"
debug_log "START | dl=$dl work=$work target=$target"
debug_log "START | AETHER_CURRENT_DIR=${AETHER_CURRENT_DIR:-}"
debug_log "START | AETHER_WORK_DIR=${AETHER_WORK_DIR:-}"
debug_log "START | AETHER_UPDATE_RESULT=${AETHER_UPDATE_RESULT:-}"
debug_log "START | AETHER_MIRROR_ROOT=${AETHER_MIRROR_ROOT:-}"
debug_log "START | AETHER_MIRROR_ONLY=$mirror_only"
debug_log "START | AETHER_DEBUG_LOG=$DEBUG_LOG"
_disk_avail="$(df -h "$work" 2>/dev/null | tail -1 | awk '{print $4}' || true)"
debug_log "DISK | work=$work available=${_disk_avail:-unknown}"

rm -f "$res" 2>/dev/null || true

echo "[0/4] Work directory: $work"

shopt -s nullglob
arr=("$dl"/"$pkg_base"-"$ver".*)
shopt -u nullglob
debug_log "PICK | searching dl=$dl pattern=$pkg_base-$ver.* count=${#arr[@]}"
if [ "$mirror_only" != "1" ] && [ "${#arr[@]}" -eq 0 ]; then
  fail "[install] Package not found for version $ver in $dl"
fi

pkg=""
for f in "${arr[@]}"; do
  case "$f" in *.zip) pkg="$f"; break ;; esac
done
[ -n "$pkg" ] || pkg="${arr[0]:-}"
debug_log "PICK | selected pkg=${pkg:-none}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/aether-install.XXXXXX")"
ex="$tmp/extract"
mkdir -p "$ex" || fail "[install] Failed to prepare extract directory"
debug_log "EXTRACT | tmp=$tmp ex=$ex"

echo "[1/4] Package: $(basename "$pkg")"
echo "      Target version: $ver"

old="$(active_dir "$work")"
debug_log "ACTIVE | old=${old:-none} work=$work"
if [ "$mirror_only" = "1" ]; then
  [ -d "$target" ] || fail "[install] Installed version directory not found for mirror retry: $target"
  echo "[2/4] Reusing installed version at: $target"
  debug_log "MIRROR_ONLY | reusing installed version at $target"
else
  case "$pkg" in
    *.zip)
      debug_log "EXTRACT | method=unzip pkg=$pkg"
      unzip -o "$pkg" -d "$ex" || fail "[install] Failed to extract $pkg"
      ;;
    *.tar.gz|*.tgz)
      debug_log "EXTRACT | method=tar_gz pkg=$pkg"
      tar -xzf "$pkg" -C "$ex" || fail "[install] Failed to extract $pkg"
      ;;
    *.tar.bz2)
      debug_log "EXTRACT | method=tar_bz2 pkg=$pkg"
      tar -xjf "$pkg" -C "$ex" || fail "[install] Failed to extract $pkg"
      ;;
    *)
      fail "[install] Unknown package format: $pkg"
      ;;
  esac
  debug_log "EXTRACT | extraction complete"

  src="$(pick_src "$ex")"
  debug_log "EXTRACT | src=${src:-none}"
  [ -n "$src" ] || fail "[install] Missing app files (aether/Aether.sh) in package"

  echo "[2/4] Extracting and installing to: $target"
  rm -rf "$next" "$target" 2>/dev/null || true
  mkdir -p "$next" || fail "[install] Failed to prepare version directory: $next"
  debug_log "INSTALL | cp -R src=$src next=$next"
  cp -R "$src"/. "$next" || fail "[install] Failed to copy files into $next"
  debug_log "INSTALL | mv next=$next target=$target"
  mv "$next" "$target" || fail "[install] Failed to finalize install into $target"
  debug_log "INSTALL | mv success"
fi

chmod +x "$target/aether" "$target/Aether.sh" 2>/dev/null || true
debug_log "PERM | chmod +x aether Aether.sh in $target"
printf "%s\n" "$ver" > "$target/.aether_web_version"
debug_log "VERSION | wrote $target/.aether_web_version ver=$ver"
rm -f "$work/.aether_web_version" 2>/dev/null || true

rm -rf "$work/current" 2>/dev/null || true

fix_libssl "$target"
prune_versions "$work" 1000 "$target"
debug_log "PRUNE | work prune=$prune"

copy_target=""
mirror_prune=""
if in_work "$work"; then
  debug_log "IN_WORK | AETHER_CURRENT_DIR=${AETHER_CURRENT_DIR:-} is under work=$work, skipping mirror"
  copy_note="[install] Current app already runs inside WorkDir; skipped mirror."
elif copy_target="$(mirror_dir || true)" && [ -n "$copy_target" ]; then
  debug_log "MIRROR | copy_target=$copy_target"
  copy_note="[install] Copied the new version near the current app location: $copy_target"
  mirror_root_dir="$(mirror_root || true)"
  if [ -n "$mirror_root_dir" ]; then
    prune_versions "$mirror_root_dir" 1000 "$copy_target"
    mirror_prune="$prune"
    debug_log "PRUNE | mirror_root_dir=$mirror_root_dir mirror_prune=$prune"
  fi
else
  debug_log "MIRROR | mirror_dir failed, AETHER_CURRENT_DIR=${AETHER_CURRENT_DIR:-}"
  fail "[install] Failed to copy the new version near ${AETHER_CURRENT_DIR:-the current app}" mirror
fi
start_target="$target"
if [ -n "$copy_target" ]; then
  start_target="$copy_target"
fi
debug_log "LAUNCH | start_target=$start_target target=$target copy_target=${copy_target:-}"
launch="$(write_launch "$start_target" || true)"
debug_log "LAUNCH | launch=${launch:-none}"
register_protocol "$start_target"
if [ -n "$launch" ]; then
  echo "[install] Desktop launcher: $launch"
  echo "[install] To start Aether, click the Aether icon on your desktop or in your application menu."
else
  echo "[install] Warning: failed to create Desktop launcher."
  echo "[install] To start Aether, open $start_target and run Aether.sh."
fi

if [ "$prune" -gt 0 ]; then
  echo "[3/4] Keeping the latest 1000 versions; removed $prune older version directories."
else
  echo "[3/4] Keeping the latest 1000 versions; no older version directories needed removal."
fi

if [ "$restart" = "1" ]; then
  debug_log "RESTART | entering restart block, restart=1"
  stop_all_runtime
  if [ -n "$copy_target" ]; then
    debug_log "RESTART | booting copy_target=$copy_target (fallback target=$target)"
    if ! boot "$copy_target" && ! boot "$target"; then
      fail "[install] Failed to restart Aether from $target/Aether.sh"
    fi
  elif ! boot "$target"; then
    debug_log "RESTART | booting target=$target"
    fail "[install] Failed to restart Aether from $target/Aether.sh"
  fi
else
  debug_log "RESTART | restart=0, skipping kill+boot"
fi

write_result "installed"

echo "[4/4] Done"
echo "Version directory: $target"
if [ -n "$copy_target" ]; then
  echo "Mirror directory: $copy_target"
fi
if [ -n "$mirror_prune" ] && [ "$mirror_prune" -gt 0 ]; then
  echo "Mirror cleanup: removed $mirror_prune older version directories."
fi
if [ -n "$copy_note" ]; then
  echo "$copy_note"
fi

debug_log "END | ver=$ver target=$target copy_target=${copy_target:-} launch=${launch:-} restart=$restart prune=$prune"
debug_log "========== UPDATE RUN COMPLETE =========="
exit "$ok"
