#!/usr/bin/env bash

set -euo pipefail

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
}

fail() {
  local msg="$1"
  local action="${2:-recover}"
  write_result "failed" "$action" "$msg"
  echo "$msg"
  clean
  exit "$run_err"
}

pick_home() {
  local home="$HOME"
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
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
    mkdir -p "${AETHER_MIRROR_ROOT}" || return 1
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
  cur="$(cd "$cur" 2>/dev/null && pwd)" || return 1
  root="$(cd "$root" 2>/dev/null && pwd)" || return 1
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

  if has_ssl3; then
    return 0
  fi

  local ssl=""
  local crypto=""
  if ! pick_pair "$dir" ssl crypto; then
    echo "[install] Warning: libssl.so.3 is missing, and no usable libssl/libcrypto pair was found."
    echo "[install] Please install libssl3 (preferred) or a compatible OpenSSL runtime and retry."
    return 0
  fi

  local lib="$dir/lib"
  mkdir -p "$lib"
  ln -sf "$ssl" "$lib/libssl.so.3"
  ln -sf "$crypto" "$lib/libcrypto.so.3"
  echo "[install] Added compatibility symlinks in $lib"
  echo "[install]   libssl.so.3 -> $ssl"
  echo "[install]   libcrypto.so.3 -> $crypto"

  local launch="$dir/Aether.sh"
  local real="$dir/Aether.sh.real"
  if [ -f "$launch" ] && [ ! -f "$real" ]; then
    mv "$launch" "$real"
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
    echo "[install] Patched Aether.sh with compatibility wrapper."
  fi
}

write_launch() {
  local app="$1/Aether.sh"
  local home
  home="$(pick_home)"
  local desk="$home/Desktop"
  local launch="$desk/Aether.sh"
  mkdir -p "$desk" || return 1

  cat > "$launch" <<EOF
#!/usr/bin/env bash
set -euo pipefail

app="$app"
[ -x "\$app" ] || exit 1
exec "\$app" "\$@"
EOF
  chmod +x "$launch" || return 1
  printf "%s" "$launch"
}

stop() {
  local dir="$1"
  [ -n "$dir" ] || return 0
  pkill -f "$dir/Aether.sh" >/dev/null 2>&1 || true
  pkill -f "$dir/aether web" >/dev/null 2>&1 || true
  pkill -f "$dir/aether serve" >/dev/null 2>&1 || true
}

boot() {
  local app="$1/Aether.sh"
  [ -x "$app" ] || return 1
  if command -v setsid >/dev/null 2>&1; then
    setsid "$app" >/dev/null 2>&1 < /dev/null &
    return 0
  fi
  nohup "$app" >/dev/null 2>&1 < /dev/null &
}

mirror_dir() {
  local root dst tmp
  root="$(mirror_root || true)"
  [ -n "$root" ] || return 1
  dst="$(mirror_target "$root")"
  tmp="${dst}.copy"
  rm -rf "$tmp" "$dst" 2>/dev/null || true
  mkdir -p "$tmp" || return 1
  cp -R "$target"/. "$tmp" || {
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  }
  mv "$tmp" "$dst" || {
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  }
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

rm -f "$res" 2>/dev/null || true

echo "[0/4] Work directory: $work"

shopt -s nullglob
arr=("$dl"/"$pkg_base"-"$ver".*)
shopt -u nullglob
if [ "$mirror_only" != "1" ] && [ "${#arr[@]}" -eq 0 ]; then
  fail "[install] Package not found for version $ver in $dl"
fi

pkg=""
for f in "${arr[@]}"; do
  case "$f" in *.zip) pkg="$f"; break ;; esac
done
[ -n "$pkg" ] || pkg="${arr[0]:-}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/aether-install.XXXXXX")"
ex="$tmp/extract"
mkdir -p "$ex" || fail "[install] Failed to prepare extract directory"

echo "[1/4] Package: $(basename "$pkg")"
echo "      Target version: $ver"

old="$(active_dir "$work")"
if [ "$mirror_only" = "1" ]; then
  [ -d "$target" ] || fail "[install] Installed version directory not found for mirror retry: $target"
  echo "[2/4] Reusing installed version at: $target"
else
  case "$pkg" in
    *.zip)
      unzip -o "$pkg" -d "$ex" || fail "[install] Failed to extract $pkg"
      ;;
    *.tar.gz|*.tgz)
      tar -xzf "$pkg" -C "$ex" || fail "[install] Failed to extract $pkg"
      ;;
    *.tar.bz2)
      tar -xjf "$pkg" -C "$ex" || fail "[install] Failed to extract $pkg"
      ;;
    *)
      fail "[install] Unknown package format: $pkg"
      ;;
  esac

  src="$(pick_src "$ex")"
  [ -n "$src" ] || fail "[install] Missing app files (aether/Aether.sh) in package"

  echo "[2/4] Extracting and installing to: $target"
  rm -rf "$next" "$target" 2>/dev/null || true
  mkdir -p "$next" || fail "[install] Failed to prepare version directory: $next"
  cp -R "$src"/. "$next" || fail "[install] Failed to copy files into $next"
  mv "$next" "$target" || fail "[install] Failed to finalize install into $target"
fi

chmod +x "$target/aether" "$target/Aether.sh" 2>/dev/null || true
printf "%s\n" "$ver" > "$target/.aether_web_version"
rm -f "$work/.aether_web_version" 2>/dev/null || true

rm -rf "$work/current" 2>/dev/null || true

fix_libssl "$target"
prune_versions "$work" 5 "$target"

copy_target=""
mirror_prune=""
if in_work "$work"; then
  copy_note="[install] Current app already runs inside WorkDir; skipped mirror."
elif copy_target="$(mirror_dir || true)" && [ -n "$copy_target" ]; then
  copy_note="[install] Copied the new version near the current app location: $copy_target"
  mirror_root_dir="$(mirror_root || true)"
  if [ -n "$mirror_root_dir" ]; then
    prune_versions "$mirror_root_dir" 5 "$copy_target"
    mirror_prune="$prune"
  fi
else
  fail "[install] Failed to copy the new version near ${AETHER_CURRENT_DIR:-the current app}" mirror
fi
start_target="$target"
if [ -n "$copy_target" ]; then
  start_target="$copy_target"
fi
launch="$(write_launch "$start_target" || true)"
if [ -n "$launch" ]; then
  echo "[install] Desktop launcher: $launch"
  echo "[install] To start Aether, right-click the Aether.sh file on your desktop and choose Run as a Program."
else
  echo "[install] Warning: failed to create Desktop launcher."
  echo "[install] To start Aether, open $start_target, right-click Aether.sh, and choose Run as a Program."
fi

if [ "$prune" -gt 0 ]; then
  echo "[3/4] Keeping the latest 5 versions; removed $prune older version directories."
else
  echo "[3/4] Keeping the latest 5 versions; no older version directories needed removal."
fi

if [ "$restart" = "1" ]; then
  stop "$old"
  stop "$target"
  stop "${AETHER_CURRENT_DIR:-}"
  stop "$copy_target"
  if [ -n "$copy_target" ]; then
    if ! boot "$copy_target" && ! boot "$target"; then
      fail "[install] Failed to restart Aether from $target/Aether.sh"
    fi
  elif ! boot "$target"; then
    fail "[install] Failed to restart Aether from $target/Aether.sh"
  fi
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
exit "$ok"
