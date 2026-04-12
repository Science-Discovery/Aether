#!/usr/bin/env bash

set -euo pipefail

base="https://aether.aiphys.cn/api/download2"
latest="latest/linux-x64.yml"
auth_name="x-download-admin-password"
auth_value="ZkTi123456"
default="$HOME/.local/share/applications/aether"
mode="init"
arg=""
path_arg=""
hold=0
nohold=0

ok=0
ready=10
manual_ready=11
latest_ok=20
miss=21
meta_err=30
dl_err=31
sum_err=32
run_err=33
dir_err=40
arg_err=50

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-pause)
      nohold=1
      ;;
    --path)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--path needs a value"
        exit "$arg_err"
      fi
      path_arg="$1"
      ;;
    init|auto|manual|help|-h|--help)
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

if [ "$mode" = "init" ] && [ "$nohold" = "0" ]; then
  hold=1
fi

work=""
cur=""
req=""
ver=""
pkg=""
sha=""
ins=""
note=""
pkg_url=""
ins_url=""
note_url=""
pkg_name=""
ins_name=""
pkg_file=""
ins_file=""
dl=""
manifest_url=""
res=""
res_file=""
fetch_http=""
fetch_tool=""
keep="3"
openssl_mode=""
openssl_checked=0
openssl_lib=""
lib_roots="/usr/lib/x86_64-linux-gnu /usr/lib64 /usr/lib /lib/x86_64-linux-gnu /lib64 /lib"

lib_exact() {
  local name="$1"
  local roots="${2:-$lib_roots}"
  for p in $roots; do
    if [ -f "$p/$name" ]; then
      printf "%s" "$p/$name"
      return 0
    fi
  done
  printf ""
}

lib_glob() {
  local pat="$1"
  local roots="${2:-$lib_roots}"
  for p in $roots; do
    local f
    f="$(find "$p" -maxdepth 1 -name "$pat" 2>/dev/null | head -1)"
    if [ -n "$f" ]; then
      printf "%s" "$f"
      return 0
    fi
  done
  printf ""
}

run_openssl() {
  if [ "$openssl_mode" = "compat" ] && [ -n "$openssl_lib" ]; then
    LD_LIBRARY_PATH="$openssl_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" openssl "$@"
    return $?
  fi
  openssl "$@"
}

repair_openssl() {
  local ssl
  local crypto
  ssl="$(lib_exact "libssl.so.1.1")"
  if [ -z "$ssl" ]; then
    ssl="$(lib_glob "libssl.so.1.*")"
  fi
  crypto="$(lib_exact "libcrypto.so.1.1")"
  if [ -z "$crypto" ]; then
    crypto="$(lib_glob "libcrypto.so.1.*")"
  fi
  if [ -z "$ssl" ] || [ -z "$crypto" ]; then
    return 1
  fi

  local dir
  if [ -n "$work" ]; then
    dir="$work/.openssl_compat"
  else
    dir="${TMPDIR:-/tmp}/aether-openssl-compat"
  fi
  mkdir -p "$dir" 2>/dev/null || return 1
  ln -sf "$ssl" "$dir/libssl.so.3" 2>/dev/null || return 1
  ln -sf "$crypto" "$dir/libcrypto.so.3" 2>/dev/null || return 1

  if LD_LIBRARY_PATH="$dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" openssl version >/dev/null 2>&1; then
    openssl_lib="$dir"
    return 0
  fi

  return 1
}

pick_openssl() {
  if [ "$openssl_checked" = "1" ]; then
    return 0
  fi
  openssl_checked=1

  if ! command -v openssl >/dev/null 2>&1; then
    openssl_mode="none"
    return 0
  fi

  if openssl version >/dev/null 2>&1; then
    openssl_mode="system"
    return 0
  fi

  echo "[hash] openssl exists but cannot run (likely missing libssl.so.3)."
  echo "[hash] Trying local OpenSSL runtime compatibility shim..."
  if repair_openssl; then
    openssl_mode="compat"
    echo "[hash] OpenSSL shim enabled via LD_LIBRARY_PATH=$openssl_lib"
    return 0
  fi

  openssl_mode="broken"
  echo "[hash] OpenSSL runtime repair failed; will auto-fallback to non-openssl hashing."
}

compute_sha512_base64() {
  local file="$1"
  pick_openssl
  if [ "$openssl_mode" = "system" ] || [ "$openssl_mode" = "compat" ]; then
    local out
    if out="$(run_openssl dgst -sha512 -binary "$file" 2>/dev/null | run_openssl base64 -A 2>/dev/null)"; then
      printf "%s" "$out"
      return 0
    fi
  fi

  if command -v sha512sum >/dev/null 2>&1; then
    local hex
    hex="$(sha512sum "$file" | awk '{print $1}')"
    if command -v python3 >/dev/null 2>&1; then
      python3 -c "import base64,binascii;print(base64.b64encode(binascii.unhexlify('$hex')).decode(),end='')"
    elif command -v python >/dev/null 2>&1; then
      python -c "import base64,binascii;print(base64.b64encode(binascii.unhexlify('$hex')).decode(),end='')"
    elif command -v perl >/dev/null 2>&1; then
      perl -e "use MIME::Base64;print encode_base64(pack('H*','$hex'),'')"
    else
      echo "__NOBASE64__"
    fi
  else
    echo "__NOHASH__"
  fi
}

installed() {
  local root name best_ver dir ver
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
      ver="${BASH_REMATCH[1]}"
      if [ -z "$best_ver" ] || [ "$(cmp "$best_ver" "$ver")" = "lt" ]; then
        best_ver="$ver"
      fi
    fi
  done
  shopt -u nullglob
  printf "%s" "$best_ver"
}

cache_paths() {
  dl="$work/downloads"
  [ -n "$pkg_name" ] || return 1
  local pkg_ext ins_ext
  pkg_ext="${pkg_name##*.}"
  if [ "$pkg_ext" = "$pkg_name" ]; then
    pkg_ext=""
  else
    pkg_ext=".$pkg_ext"
  fi
  pkg_file="$dl/aether-linux-x64-$ver$pkg_ext"
  ins_file=""
  if [ -n "$ins_url" ] && [ -n "$ins_name" ]; then
    ins_ext="${ins_name##*.}"
    if [ "$ins_ext" = "$ins_name" ]; then
      ins_ext=""
    else
      ins_ext=".$ins_ext"
    fi
    ins_file="$dl/update_linux-$ver$ins_ext"
  fi
}

cached_ready() {
  [ -d "$work/downloads" ] || return 1
  cache_paths || return 1
  [ -f "$pkg_file" ] || return 1
  if [ -n "$sha" ]; then
    local sum
    sum="$(compute_sha512_base64 "$pkg_file" || true)"
    if [ "$sum" = "__NOHASH__" ] || [ "$sum" = "__NOBASE64__" ]; then
      :
    else
      [ "$sum" = "$sha" ] || return 1
    fi
  fi
  [ -n "$ins_file" ] || return 1
  [ -f "$ins_file" ] || return 1
  chmod +x "$ins_file" 2>/dev/null || true
}

ensure_libssl() {
  local app_dir="$1"
  local ssl1_path=""

  if [ -n "$(lib_exact "libssl.so.3")" ]; then
    return 0
  fi

  echo
  echo "[compat] libssl.so.3 not found on this system."

  ssl1_path="$(lib_exact "libssl.so.1.1")"
  if [ -z "$ssl1_path" ]; then
    ssl1_path="$(lib_glob "libssl.so.1.*")"
  fi

  if [ -z "$ssl1_path" ]; then
    echo "[compat] WARNING: No libssl.so.1.x found either. The application may not start."
    echo "[compat] Try: sudo apt install libssl-dev"
    return 0
  fi

  local crypto1_path=""
  local ssl1_dir
  ssl1_dir="$(dirname "$ssl1_path")"
  crypto1_path="$(lib_exact "libcrypto.so.1.1" "$ssl1_dir")"
  if [ -z "$crypto1_path" ]; then
    crypto1_path="$(lib_glob "libcrypto.so.1.*" "$ssl1_dir")"
  fi

  echo "[compat] Found: $ssl1_path"

  local compat_dir="$app_dir/ssl_compat"
  mkdir -p "$compat_dir" 2>/dev/null || return 0

  ln -sf "$ssl1_path" "$compat_dir/libssl.so.3" 2>/dev/null || true
  if [ -n "$crypto1_path" ]; then
    ln -sf "$crypto1_path" "$compat_dir/libcrypto.so.3" 2>/dev/null || true
    echo "[compat] Symlinked $crypto1_path -> $compat_dir/libcrypto.so.3"
  fi
  echo "[compat] Symlinked $ssl1_path -> $compat_dir/libssl.so.3"

  local wrapper=""
  shopt -s nullglob
  for f in "$app_dir"/aether "$app_dir"/Aether "$app_dir"/aether-*/aether "$app_dir"/resources/../aether; do
    if [ -x "$f" ] && [ ! -d "$f" ]; then
      wrapper="$f"
      break
    fi
  done
  shopt -u nullglob

  if [ -n "$wrapper" ]; then
    local wrapper_dir
    wrapper_dir="$(dirname "$wrapper")"
    local wrapper_name
    wrapper_name="$(basename "$wrapper")"
    local real_bin="$wrapper_dir/${wrapper_name}.real"
    if [ ! -f "$real_bin" ]; then
      mv "$wrapper" "$real_bin"
      cat > "$wrapper" <<EOWRAP
#!/usr/bin/env bash
export LD_LIBRARY_PATH="$compat_dir\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "$real_bin" "\$@"
EOWRAP
      chmod +x "$wrapper"
      echo "[compat] Created wrapper: $wrapper"
      echo "[compat] LD_LIBRARY_PATH will include: $compat_dir"
    fi
  else
    echo "[compat] NOTE: Set LD_LIBRARY_PATH=$compat_dir before running Aether."
    echo "[compat] Example: LD_LIBRARY_PATH=$compat_dir aether"
  fi

  echo "[compat] WARNING: libssl 1.x -> 3 symlinks may not be fully ABI-compatible."
  echo "[compat] If the app crashes, consider installing OpenSSL 3:"
  echo "[compat]   Ubuntu 22.04+: sudo apt install libssl3"
  echo "[compat]   Older Ubuntu:  install from a PPA or build from source."
  echo
}

done_hold() {
  if [ "$hold" = "1" ]; then
    echo
    read -r -p "Press Enter to close..." _
  fi
}

fail() {
  local code="$1"
  done_hold
  exit "$code"
}

quote() {
  printf "'%s'" "${1//\'/\'\'}"
}

result() {
  [ -n "$work" ] || return 0
  dl="${dl:-$work/downloads}"
  mkdir -p "$dl" || return 0
  res_file="$dl/last-result.yml"
  local code="$ok"
  case "$res" in
    update_ready) code="$ready" ;;
    manual_ready) code="$manual_ready" ;;
    up_to_date) code="$latest_ok" ;;
    version_missing) code="$miss" ;;
    meta_error) code="$meta_err" ;;
    download_error) code="$dl_err" ;;
    checksum_error) code="$sum_err" ;;
    run_error) code="$run_err" ;;
    dir_error) code="$dir_err" ;;
    arg_error) code="$arg_err" ;;
  esac
  {
    echo "mode: $(quote "$mode")"
    echo "status: $(quote "$res")"
    echo "code: $code"
    echo "current_version: $(quote "$cur")"
    echo "target_version: $(quote "$ver")"
    echo "requested_version: $(quote "$req")"
    echo "work_dir: $(quote "$work")"
    echo "download_dir: $(quote "$dl")"
    echo "package_path: $(quote "$pkg_file")"
    echo "installer_path: $(quote "$ins_file")"
    echo "manifest_url: $(quote "$manifest_url")"
    echo "notes_url: $(quote "$note_url")"
  } >"$res_file"
}

origin() {
  local src="$1"
  local scheme rest host
  scheme="${src%%://*}"
  rest="${src#*://}"
  host="${rest%%/*}"
  printf "%s://%s" "$scheme" "$host"
}

abs() {
  local src="$1"
  local val="$2"
  local dir
  if [ -z "$val" ]; then
    printf ""
    return 0
  fi
  case "$val" in
    http://*|https://*) printf "%s" "$val" ;;
    /*) printf "%s%s" "$(origin "$src")" "$val" ;;
    *)
      dir="${src%/*}"
      printf "%s/%s" "$dir" "$val"
      ;;
  esac
}

pick_fetch() {
  if [ -n "$fetch_tool" ]; then
    return 0
  fi
  if command -v curl >/dev/null 2>&1; then
    fetch_tool="curl"
    return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    fetch_tool="wget"
    return 0
  fi
  if command -v busybox >/dev/null 2>&1 && busybox wget --help >/dev/null 2>&1; then
    fetch_tool="busybox"
    return 0
  fi
  echo "No downloader found. Install curl or wget (busybox wget also works)."
  return 1
}

prep() {
  mkdir -p "$1" 2>/dev/null
}

desktop_hint() {
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

  local launch="$home/Desktop/Aether.sh"
  if [ -f "$launch" ]; then
    echo "[init] Desktop launcher: $launch"
    return 0
  fi
  echo "[init] NOTE: Desktop launcher not found: $launch"
  echo "[init] The local installer should create it; check Desktop permissions if missing."
}

normalize_work() {
  local dir base
  dir="$1"
  base="$(basename "$dir")"
  if [ "$base" = "aether" ]; then
    printf "%s" "$dir"
    return 0
  fi
  printf "%s/aether" "$dir"
}

workdir() {
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ "$(basename "$dir")" == aether_* ]]; then
    cd "$dir/.." && pwd
    return 0
  fi
  printf "%s" "$dir"
}

cmp() {
  local a="${1#v}"
  local b="${2#v}"
  a="${a%%-*}"
  b="${b%%-*}"
  local aa bb i
  IFS=. read -r -a aa <<<"$a"
  IFS=. read -r -a bb <<<"$b"
  for i in 0 1 2 3; do
    local x="${aa[$i]:-0}"
    local y="${bb[$i]:-0}"
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

fetch_meta() {
  local url="$1"
  local out="$2"
  pick_fetch || {
    fetch_http="000"
    return 1
  }
  if [ "$fetch_tool" = "curl" ]; then
    fetch_http="$(curl --location --silent --show-error --connect-timeout 15 --max-time 1800 --retry 3 --retry-delay 2 -H "$auth_name: $auth_value" --output "$out" --write-out "%{http_code}" "$url" || true)"
    [ "$fetch_http" = "200" ]
    return 0
  fi

  local err
  err="$(mktemp "${TMPDIR:-/tmp}/aether-fetch.XXXXXX")"
  if [ "$fetch_tool" = "wget" ]; then
    wget --server-response --header="$auth_name: $auth_value" --tries=3 --timeout=15 --read-timeout=1800 --output-document "$out" "$url" 2>"$err" && {
      fetch_http="200"
      rm -f "$err"
      return 0
    }
  else
    busybox wget --header "$auth_name: $auth_value" -S -T 15 -O "$out" "$url" 2>"$err" && {
      fetch_http="200"
      rm -f "$err"
      return 0
    }
  fi

  fetch_http="$(awk '/^  HTTP\//{c=$2} /^HTTP\//{c=$2} END{print c}' "$err")"
  [ -n "$fetch_http" ] || fetch_http="000"
  rm -f "$err"
  return 1
}

fetch_file() {
  pick_fetch || return 1
  if [ "$fetch_tool" = "curl" ]; then
    curl --fail --location --progress-bar --connect-timeout 15 --max-time 1800 --retry 3 --retry-delay 2 -H "$auth_name: $auth_value" --output "$2" "$1"
    return 0
  fi
  if [ "$fetch_tool" = "wget" ]; then
    wget --header="$auth_name: $auth_value" --tries=3 --timeout=15 --read-timeout=1800 --output-document "$2" "$1"
    return 0
  fi
  busybox wget --header "$auth_name: $auth_value" -T 15 -O "$2" "$1"
}

parse() {
  ver="$(awk -F': *' '/^version:/{print $2; exit}' "$1" | tr -d "'\"")"
  note="$(awk -F': *' '/^notes_url:/{print $2; exit}' "$1")"
  pkg="$(awk '
    /^package:[[:space:]]*$/ { sec="package"; next }
    /^[^[:space:]]/ { sec="" }
    sec=="package" && /^[[:space:]]+url:[[:space:]]*/ { sub(/^[[:space:]]+url:[[:space:]]*/, ""); print; exit }
  ' "$1")"
  sha="$(awk '
    /^package:[[:space:]]*$/ { sec="package"; next }
    /^[^[:space:]]/ { sec="" }
    sec=="package" && /^[[:space:]]+sha512:[[:space:]]*/ { sub(/^[[:space:]]+sha512:[[:space:]]*/, ""); print; exit }
  ' "$1")"
  ins="$(awk '
    /^installer:[[:space:]]*$/ { sec="installer"; next }
    /^[^[:space:]]/ { sec="" }
    sec=="installer" && /^[[:space:]]+url:[[:space:]]*/ { sub(/^[[:space:]]+url:[[:space:]]*/, ""); print; exit }
  ' "$1")"
  if [ -z "$pkg" ]; then
    pkg="$(awk '
      /^files:[[:space:]]*$/ { sec="files"; next }
      sec=="files" && /^[[:space:]]*-[[:space:]]*url:[[:space:]]*/ { sub(/^[[:space:]]*-[[:space:]]*url:[[:space:]]*/, ""); print; exit }
    ' "$1")"
    sha="$(awk '
      /^files:[[:space:]]*$/ { sec="files"; next }
      sec=="files" && /^[[:space:]]*sha512:[[:space:]]*/ { sub(/^[[:space:]]*sha512:[[:space:]]*/, ""); print; exit }
    ' "$1")"
  fi
  [ -n "$ver" ] && [ -n "$pkg" ]
}

manifest() {
  local url="$1"
  local kind="$2"
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/aether-installer.XXXXXX")"
  local file="$tmp/manifest.yml"
  if ! fetch_meta "$url" "$file"; then
    rm -rf "$tmp"
    if [ "$kind" = "version" ] && [ "$fetch_http" = "404" ]; then
      return "$miss"
    fi
    return "$meta_err"
  fi
  if ! parse "$file"; then
    rm -rf "$tmp"
    return "$meta_err"
  fi
  pkg_url="$(abs "$url" "$pkg")"
  ins_url="$(abs "$url" "$ins")"
  note_url="$(abs "$url" "$note")"
  pkg_name="$(basename "$pkg_url")"
  ins_name="$(basename "$ins_url")"
  rm -rf "$tmp"
}

grab() {
  dl="$work/downloads"
  mkdir -p "$dl" || return "$dir_err"
  local pkg_ext ins_ext need_pkg need_ins sum

  pkg_ext="${pkg_name##*.}"
  if [ "$pkg_ext" = "$pkg_name" ]; then
    pkg_ext=""
  else
    pkg_ext=".$pkg_ext"
  fi
  pkg_file="$dl/aether-linux-x64-$ver$pkg_ext"

  need_pkg=1
  if [ -f "$pkg_file" ]; then
    if [ -n "$sha" ]; then
      sum="$(compute_sha512_base64 "$pkg_file" || true)"
      if [ "$sum" = "$sha" ]; then
        need_pkg=0
      elif [ "$sum" = "__NOHASH__" ] || [ "$sum" = "__NOBASE64__" ]; then
        echo "Warning: cannot verify checksum (no openssl/sha512sum/base64 tool found)"
        need_pkg=0
      fi
    else
      need_pkg=0
    fi
  fi

  if [ "$need_pkg" = "1" ]; then
    echo "Downloading package:"
    echo "  $pkg_url"
    fetch_file "$pkg_url" "$pkg_file" || return "$dl_err"
  else
    echo "Using cached package:"
    echo "  $pkg_file"
  fi

  if [ -n "$sha" ]; then
    sum="$(compute_sha512_base64 "$pkg_file")"
    if [ "$sum" = "__NOHASH__" ] || [ "$sum" = "__NOBASE64__" ]; then
      echo "Warning: cannot verify checksum (no openssl/sha512sum/base64 tool found), skipping verification"
    else
      [ "$sum" = "$sha" ] || return "$sum_err"
    fi
  fi

  if [ -n "$ins_url" ] && [ -n "$ins_name" ]; then
    ins_ext="${ins_name##*.}"
    if [ "$ins_ext" = "$ins_name" ]; then
      ins_ext=""
    else
      ins_ext=".$ins_ext"
    fi
    ins_file="$dl/update_linux-$ver$ins_ext"

    need_ins=1
    if [ -f "$ins_file" ]; then
      need_ins=0
    fi

    if [ "$need_ins" = "1" ]; then
      echo "Downloading installer:"
      echo "  $ins_url"
      fetch_file "$ins_url" "$ins_file" || return "$dl_err"
    else
      echo "Using cached installer:"
      echo "  $ins_file"
    fi
    chmod +x "$ins_file" 2>/dev/null || true
  else
    ins_file=""
  fi

  prune
}

prune() {
  dl="${dl:-$work/downloads}"
  [ -d "$dl" ] || return 0
  local arr n cut i list item

  shopt -s nullglob
  arr=("$dl"/aether-linux-x64-*.*)
  shopt -u nullglob
  n="${#arr[@]}"
  if [ "$n" -gt "$keep" ]; then
    list="$(printf "%s\n" "${arr[@]}" | sort -V)"
    cut=$((n - keep))
    i=0
    while IFS= read -r item; do
      [ -n "$item" ] || continue
      if [ "$i" -lt "$cut" ]; then
        rm -f "$item"
      fi
      i=$((i + 1))
    done <<<"$list"
  fi

  shopt -s nullglob
  arr=("$dl"/update_linux-*.sh)
  shopt -u nullglob
  n="${#arr[@]}"
  if [ "$n" -gt "$keep" ]; then
    list="$(printf "%s\n" "${arr[@]}" | sort -V)"
    cut=$((n - keep))
    i=0
    while IFS= read -r item; do
      [ -n "$item" ] || continue
      if [ "$i" -lt "$cut" ]; then
        rm -f "$item"
      fi
      i=$((i + 1))
    done <<<"$list"
  fi
}

help() {
  cat <<EOF
Aether Linux Installer

Usage:
  $(basename "$0") [--no-pause] [--path <dir>] init
  $(basename "$0") [--no-pause] auto <current-version>
  $(basename "$0") [--no-pause] manual <target-version>

Remote manifests:
  $base/$latest
  $base/1.2.3/linux-x64.yml

Downloaders:
  curl (preferred), wget, or busybox wget

Result file:
  work_dir/downloads/last-result.yml

Exit codes:
  0   init finished successfully
  10  latest update downloaded and ready
  11  requested version downloaded and ready
  20  already up to date
  21  requested version not found
  30  manifest or network error
  31  download failed
  32  checksum mismatch
  33  init install run failed
  40  work directory error
  50  argument error
EOF
}

if [ "$mode" = "help" ] || [ "$mode" = "--help" ] || [ "$mode" = "-h" ]; then
  help
  exit 0
fi

if [ "$mode" = "init" ]; then
  echo "Aether Linux Installer"
  echo
  work="$(normalize_work "${path_arg:-$default}")"
  echo "Install directory:"
  echo "  $work"
  prep "$work" || {
    res="dir_error"
    result
    echo
    echo "Work directory failed."
    fail "$dir_err"
  }
  local_self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  local_dst="$work/$(basename "$0")"
  if [ "$local_self" != "$local_dst" ]; then
    cp "$0" "$local_dst" 2>/dev/null || {
      res="dir_error"
      result
      echo
      echo "Failed to copy installer to $work"
      fail "$dir_err"
    }
  fi
  manifest_url="$base/$latest"
  manifest "$manifest_url" latest || {
    res="meta_error"
    result
    echo
    echo "Manifest check failed."
    fail "$meta_err"
  }
  echo "Latest version: $ver"
  cur="$(installed "$work")"
  if [ -n "$cur" ] && [ "$(cmp "$cur" "$ver")" = "eq" ]; then
    res="up_to_date"
    result
    echo
    echo "Current version: $cur"
    echo "Remote version: $ver"
    echo "Already up to date."
    done_hold
    exit "$latest_ok"
  fi
  if cached_ready; then
    echo "Using cached package:"
    echo "  $pkg_file"
    echo "Using cached installer:"
    echo "  $ins_file"
  else
    grab || {
      code="$?"
      res="download_error"
      [ "$code" = "$sum_err" ] && res="checksum_error"
      result
      echo
      echo "Download failed."
      fail "$code"
    }
  fi
  res="init_ready"
  result
  echo
  echo "Download finished."
  echo "Version:   $ver"
  echo "Package:   $pkg_file"
  echo "Installer: $ins_file"
  echo "Result:    $res_file"
  echo
  if [ -n "$ins_file" ]; then
    echo "[init] Running installer script..."
    if ! (cd "$work/downloads" && bash "$(basename "$ins_file")" install "$ver"); then
      res="run_error"
      result
      echo
      echo "Install step failed while running: $ins_file"
      fail "$run_err"
    fi
  else
    res="run_error"
    result
    echo
    echo "Install step failed: installer script missing in manifest."
    fail "$run_err"
  fi

  mkdir -p "$HOME/Aether_Database" 2>/dev/null || true

  ensure_libssl "$work/aether_$ver"

  desktop_hint

  done_hold
  exit 0
fi

if [ "$mode" = "auto" ]; then
  [ -n "$arg" ] || {
    echo "auto mode needs current version."
    echo "Example: $(basename "$0") auto 1.2.3"
    res="arg_error"
    work="$(workdir)"
    result
    help
    exit "$arg_err"
  }
  cur="$arg"
  work="$(workdir)"
  prep "$work" || {
    res="dir_error"
    result
    echo
    echo "Work directory failed."
    exit "$dir_err"
  }
  manifest_url="$base/$latest"
  manifest "$manifest_url" latest || {
    res="meta_error"
    result
    echo
    echo "Manifest check failed."
    exit "$meta_err"
  }
  echo "Latest version: $ver"
  if [ "$(cmp "$cur" "$ver")" = "lt" ]; then
    echo "Current version: $cur"
    echo "Remote version: $ver"
    grab || {
      code="$?"
      res="download_error"
      [ "$code" = "$sum_err" ] && res="checksum_error"
      result
      echo
      echo "Download failed."
      exit "$code"
    }
    res="update_ready"
    result
    exit "$ready"
  fi
  echo "Current version: $cur"
  echo "Remote version: $ver"
  echo "Already up to date."
  res="up_to_date"
  result
  exit "$latest_ok"
fi

if [ "$mode" = "manual" ]; then
  [ -n "$arg" ] || {
    echo "manual mode needs a version."
    echo "Example: $(basename "$0") manual 1.2.3"
    res="arg_error"
    work="$(workdir)"
    result
    help
    exit "$arg_err"
  }
  req="$arg"
  work="$(workdir)"
  prep "$work" || {
    res="dir_error"
    result
    echo
    echo "Work directory failed."
    exit "$dir_err"
  }
  manifest_url="$base/$req/linux-x64.yml"
  if ! manifest "$manifest_url" version; then
    code="$?"
    if [ "$code" = "$miss" ]; then
      ver="$req"
      res="version_missing"
      result
      exit "$miss"
    fi
    res="meta_error"
    result
    echo
    echo "Manifest check failed."
    exit "$meta_err"
  fi
  echo "Requested version: $req"
  echo "Resolved version:  $ver"
  grab || {
    code="$?"
    res="download_error"
    [ "$code" = "$sum_err" ] && res="checksum_error"
    result
    echo
    echo "Download failed."
    exit "$code"
  }
  res="manual_ready"
  result
  exit "$manual_ready"
fi

echo "Unsupported mode: $mode"
res="arg_error"
work="$(workdir)"
result
help
exit "$arg_err"
