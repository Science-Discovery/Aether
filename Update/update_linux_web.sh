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
  - Updates current symlink to the latest installed version

Package name pattern:
  aether-linux-x64-web-<version>.*

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

set_current() {
  local work="$1"
  local target="$2"
  local link="$work/current"

  ln -sfn "$(basename "$target")" "$link" 2>/dev/null || true
  if [ -f "$link/Aether.sh" ]; then
    return 0
  fi

  rm -rf "$link" 2>/dev/null || true
  mkdir -p "$link"
  cp -R "$target"/. "$link" || return 1
  [ -f "$link/Aether.sh" ]
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
  local app="$work/current/Aether.sh"

  [ -f "$app" ] || return 1
  mkdir -p "$desk" || return 1

  cat > "$launch" <<EOF
#!/usr/bin/env bash
exec "$app" "\$@"
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

shopt -s nullglob
arr=("$dl"/aether-linux-x64-web-"$ver".*)
shopt -u nullglob
if [ "${#arr[@]}" -eq 0 ]; then
  echo "[install] Package not found for version $ver in $dl"
  exit "$dl_err"
fi

pkg="${arr[0]}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/aether-web-install.XXXXXX")"
ex="$tmp/extract"
mkdir -p "$ex" || exit "$run_err"

echo "[install] Installing version $ver"
echo "  Package: $pkg"
echo "  Target:  $target"

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

rm -rf "$next" "$target" 2>/dev/null || true
mkdir -p "$next" || exit "$run_err"
cp -R "$src"/. "$next" || exit "$run_err"
mv "$next" "$target" || exit "$run_err"

chmod +x "$target/aether" "$target/Aether.sh" 2>/dev/null || true
printf "%s\n" "$ver" > "$target/.aether_web_version"
printf "%s\n" "$ver" > "$work/.aether_web_version"

set_current "$work" "$target" || {
  echo "[install] Failed to update current link"
  exit "$run_err"
}

fix_libssl "$target"

  launch="$(write_launch "$work" || true)"
  if [ -n "$launch" ]; then
    echo "[install] Desktop launcher: $launch"
    echo "[install] To start Aether, right-click the Aether.sh file on your desktop and choose Run as a Program."
  else
    echo "[install] Warning: failed to create Desktop launcher."
    echo "[install] To start Aether, open $work/current, right-click Aether.sh, and choose Run as a Program."
  fi

echo "[install] Current: $work/current"
echo "[install] Done."
exit "$ok"
