#!/usr/bin/env bash

set -euo pipefail

base="https://aether.aiphys.cn/download"
latest="latest/linux-x64.yml"
default="$HOME/Applications/Aether"
mode="${1:-init}"
arg="${2:-}"
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
dir_err=40
arg_err=50

if [ "${1:-}" = "--no-pause" ]; then
  nohold=1
  mode="${2:-init}"
  arg="${3:-}"
fi

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
  [ "$res" = "update_ready" ] && code="$ready"
  [ "$res" = "manual_ready" ] && code="$manual_ready"
  [ "$res" = "up_to_date" ] && code="$latest_ok"
  [ "$res" = "version_missing" ] && code="$miss"
  [ "$res" = "meta_error" ] && code="$meta_err"
  [ "$res" = "download_error" ] && code="$dl_err"
  [ "$res" = "checksum_error" ] && code="$sum_err"
  [ "$res" = "dir_error" ] && code="$dir_err"
  [ "$res" = "arg_error" ] && code="$arg_err"
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

abs() {
  local val="$1"
  if [ -z "$val" ]; then
    printf ""
    return 0
  fi
  case "$val" in
    http://*|https://*) printf "%s" "$val" ;;
    /*) printf "%s/%s" "$base" "${val#/}" ;;
    *) printf "%s/%s" "$base" "$val" ;;
  esac
}

prep() {
  mkdir -p "$1" 2>/dev/null
}

workdir() {
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ "$(basename "$dir")" == aether-* ]]; then
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
  fetch_http="$(curl --location --silent --show-error --connect-timeout 15 --max-time 1800 --retry 3 --retry-delay 2 --output "$out" --write-out "%{http_code}" "$url" || true)"
  [ "$fetch_http" = "200" ]
}

fetch_file() {
  curl --fail --location --progress-bar --connect-timeout 15 --max-time 1800 --retry 3 --retry-delay 2 --output "$2" "$1"
}

parse() {
  ver="$(awk -F': *' '/^version:/{print $2; exit}' "$1")"
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
  [ -n "$ver" ] && [ -n "$pkg" ] && [ -n "$ins" ]
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
  pkg_url="$(abs "$pkg")"
  ins_url="$(abs "$ins")"
  note_url="$(abs "$note")"
  pkg_name="$(basename "$pkg_url")"
  ins_name="$(basename "$ins_url")"
  rm -rf "$tmp"
}

grab() {
  dl="$work/downloads"
  mkdir -p "$dl" || return "$dir_err"
  pkg_file="$dl/$pkg_name"
  ins_file="$dl/$ins_name"
  echo "Downloading package:"
  echo "  $pkg_url"
  fetch_file "$pkg_url" "$pkg_file" || return "$dl_err"
  if [ -n "$sha" ]; then
    local sum
    sum="$(openssl dgst -sha512 -binary "$pkg_file" | openssl base64 -A)"
    [ "$sum" = "$sha" ] || return "$sum_err"
  fi
  echo "Downloading installer:"
  echo "  $ins_url"
  fetch_file "$ins_url" "$ins_file" || return "$dl_err"
}

help() {
  cat <<EOF
Aether Linux Installer

Usage:
  $(basename "$0") [--no-pause] init
  $(basename "$0") [--no-pause] auto <current-version>
  $(basename "$0") [--no-pause] manual <target-version>

Remote manifests:
  $base/$latest
  $base/1.2.3/linux-x64.yml

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
  echo "Default work directory:"
  echo "  $default"
  echo
  read -r -p "Press Enter to use default, or input another path: " work
  work="${work:-$default}"
  prep "$work" || {
    res="dir_error"
    result
    echo
    echo "Work directory failed."
    fail "$dir_err"
  }
  cp "$0" "$work/$(basename "$0")" 2>/dev/null || {
    res="dir_error"
    result
    echo
    echo "Failed to copy installer to $work"
    fail "$dir_err"
  }
  manifest_url="$base/$latest"
  manifest "$manifest_url" latest || {
    res="meta_error"
    result
    echo
    echo "Manifest check failed."
    fail "$meta_err"
  }
  grab || {
    code="$?"
    res="download_error"
    [ "$code" = "$sum_err" ] && res="checksum_error"
    result
    echo
    echo "Download failed."
    fail "$code"
  }
  res="init_ready"
  result
  echo
  echo "Download finished."
  echo "Version:   $ver"
  echo "Package:   $pkg_file"
  echo "Installer: $ins_file"
  echo "Result:    $res_file"
  echo
  echo "Next step:"
  echo "  Let Aether read last-result.yml and continue the installation flow."
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
