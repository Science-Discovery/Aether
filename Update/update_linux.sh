#!/usr/bin/env bash

set -euo pipefail

ok=0
dl_err=31
run_err=33
arg_err=50

mode="install"
arg=""
tmp=""
next=""
prune="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    install|help|-h|--help)
      mode="$1"
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
  aether-linux-x64-<version>.*

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
  local root dir ver
  root="$1"
  if [ -f "$root/.aether_web_version" ]; then
    ver="$(tr -d '[:space:]' <"$root/.aether_web_version")"
    if [ -n "$ver" ] && [ -d "$root/aether_$ver" ]; then
      printf "%s" "$root/aether_$ver"
      return 0
    fi
  fi
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

list_ssl() {
  {
    if command -v ldconfig >/dev/null 2>&1; then
      ldconfig -p 2>/dev/null | awk '/libssl\.so\./{print $NF}'
    fi
    for p in /lib /usr/lib /lib64 /usr/lib64 /usr/local/lib /usr/local/lib64 /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu; do
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
    for p in /lib /usr/lib /lib64 /usr/lib64 /usr/local/lib /usr/local/lib64 /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu; do
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
  local work="$1"
  local home
  home="$(pick_home)"
  local desk="$home/Desktop"
  local launch="$desk/Aether.sh"
  mkdir -p "$desk" || return 1

  cat > "$launch" <<EOF
#!/usr/bin/env bash
set -euo pipefail

root="$work"

cmp() {
  local a="\${1#v}"
  local b="\${2#v}"
  local aa bb i x y
  a="\${a%%-*}"
  b="\${b%%-*}"
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
    if [ -n "\$ver" ] && [ -f "\$root/aether_\$ver/Aether.sh" ]; then
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
[ -n "\$app" ] || exit 1
exec "\$app/Aether.sh" "\$@"
EOF
  chmod +x "$launch" || return 1
  printf "%s" "$launch"
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

echo "[0/4] Work directory: $work"

shopt -s nullglob
arr=("$dl"/aether-linux-x64-"$ver".*)
shopt -u nullglob
if [ "${#arr[@]}" -eq 0 ]; then
  echo "[install] Package not found for version $ver in $dl"
  exit "$dl_err"
fi

pkg="${arr[0]}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/aether-install.XXXXXX")"
ex="$tmp/extract"
mkdir -p "$ex" || exit "$run_err"

echo "[1/4] Package: $(basename "$pkg")"
echo "      Target version: $ver"

case "$pkg" in
  *.zip)
    unzip -o "$pkg" -d "$ex" || {
      echo "[install] Failed to extract $pkg"
      exit "$run_err"
    }
    ;;
  *.tar.gz|*.tgz)
    tar -xzf "$pkg" -C "$ex" || {
      echo "[install] Failed to extract $pkg"
      exit "$run_err"
    }
    ;;
  *.tar.bz2)
    tar -xjf "$pkg" -C "$ex" || {
      echo "[install] Failed to extract $pkg"
      exit "$run_err"
    }
    ;;
  *)
    echo "[install] Unknown package format: $pkg"
    exit "$run_err"
    ;;
esac

src="$(pick_src "$ex")"
if [ -z "$src" ]; then
  echo "[install] Missing app files (aether/Aether.sh) in package"
  exit "$run_err"
fi

echo "[2/4] Extracting and installing to: $target"
rm -rf "$next" "$target" 2>/dev/null || true
mkdir -p "$next" || exit "$run_err"
cp -R "$src"/. "$next" || exit "$run_err"
mv "$next" "$target" || exit "$run_err"

chmod +x "$target/aether" "$target/Aether.sh" 2>/dev/null || true
printf "%s\n" "$ver" > "$target/.aether_web_version"
printf "%s\n" "$ver" > "$work/.aether_web_version"

rm -rf "$work/current" 2>/dev/null || true

fix_libssl "$target"
prune_versions "$work" 5 "$target"

launch="$(write_launch "$work" || true)"
if [ -n "$launch" ]; then
  echo "[install] Desktop launcher: $launch"
  echo "[install] To start Aether, right-click the Aether.sh file on your desktop and choose Run as a Program."
else
  echo "[install] Warning: failed to create Desktop launcher."
  echo "[install] To start Aether, open $target, right-click Aether.sh, and choose Run as a Program."
fi

if [ "$prune" -gt 0 ]; then
  echo "[3/4] Keeping the latest 5 versions; removed $prune older version directories."
else
  echo "[3/4] Keeping the latest 5 versions; no older version directories needed removal."
fi

echo "[4/4] Done"
echo "Version directory: $target"
exit "$ok"
