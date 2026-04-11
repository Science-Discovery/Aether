#!/usr/bin/env bash

set -euo pipefail

base="https://aether.aiphys.cn/download"
latest="latest/mac-arm64.yml"
default="$HOME/Applications/aether"
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
keep="3"

done_hold() {
  if [ "$hold" = "1" ]; then
    echo
    read -r -p "按回车关闭..." _
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
  [ "$res" = "run_error" ] && code="$run_err"
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

prep() {
  mkdir -p "$1" 2>/dev/null
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

installed() {
  local root name best best_ver dir ver
  root="$1"

  name="$(basename "$root")"
  if [[ "$name" =~ ^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$ ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
    return 0
  fi

  best=""
  best_ver=""
  shopt -s nullglob
  for dir in "$root"/aether_* "$root"/aether-*; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    if [[ "$name" =~ ^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$ ]]; then
      ver="${BASH_REMATCH[1]}"
      if [ -z "$best_ver" ] || [ "$(cmp "$best_ver" "$ver")" = "lt" ]; then
        best="$dir"
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
  pkg_file="$dl/aether-darwin-arm64-$ver$pkg_ext"
  ins_file=""
  if [ -n "$ins_url" ] && [ -n "$ins_name" ]; then
    ins_ext="${ins_name##*.}"
    if [ "$ins_ext" = "$ins_name" ]; then
      ins_ext=""
    else
      ins_ext=".$ins_ext"
    fi
    ins_file="$dl/update_darwin-$ver$ins_ext"
  fi
}

cached_ready() {
  [ -d "$work/downloads" ] || return 1
  cache_paths || return 1
  [ -f "$pkg_file" ] || return 1
  if [ -n "$sha" ]; then
    local sum
    sum="$(openssl dgst -sha512 -binary "$pkg_file" | openssl base64 -A || true)"
    [ "$sum" = "$sha" ] || return 1
  fi
  [ -n "$ins_file" ] || return 1
  [ -f "$ins_file" ] || return 1
  chmod +x "$ins_file" 2>/dev/null || true
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
  # fallback: parse files: list (electron-builder format)
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
  pkg_file="$dl/aether-darwin-arm64-$ver$pkg_ext"

  need_pkg=1
  if [ -f "$pkg_file" ]; then
    if [ -n "$sha" ]; then
      sum="$(openssl dgst -sha512 -binary "$pkg_file" | openssl base64 -A || true)"
      if [ "$sum" = "$sha" ]; then
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
    sum="$(openssl dgst -sha512 -binary "$pkg_file" | openssl base64 -A)"
    [ "$sum" = "$sha" ] || return "$sum_err"
  fi

  if [ -n "$ins_url" ] && [ -n "$ins_name" ]; then
    ins_ext="${ins_name##*.}"
    if [ "$ins_ext" = "$ins_name" ]; then
      ins_ext=""
    else
      ins_ext=".$ins_ext"
    fi
    ins_file="$dl/update_darwin-$ver$ins_ext"

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
  arr=("$dl"/aether-darwin-arm64-*.*)
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
  arr=("$dl"/update_darwin-*.command)
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
Aether macOS 安装器

用法:
  $(basename "$0") [--no-pause] [--path <dir>] init
  $(basename "$0") [--no-pause] auto <current-version>
  $(basename "$0") [--no-pause] manual <target-version>

远端清单:
  $base/$latest
  $base/1.2.3/mac-arm64.yml

结果文件:
  work_dir/downloads/last-result.yml

退出码:
  0   初始化安装成功完成
  10  最新更新已下载，等待安装
  11  指定版本已下载，等待安装
  20  已是最新版本
  21  未找到指定版本
  30  清单或网络错误
  31  下载失败
  32  校验和不匹配
  40  工作目录错误
  50  参数错误
EOF
}

if [ "$mode" = "help" ] || [ "$mode" = "--help" ] || [ "$mode" = "-h" ]; then
  help
  exit 0
fi

if [ "$mode" = "init" ]; then
  echo "Aether macOS 安装器"
  echo
  work="$(normalize_work "${path_arg:-$default}")"
  echo "安装目录:"
  echo "  $work"
  prep "$work" || {
    res="dir_error"
    result
    echo
    echo "工作目录处理失败。"
    fail "$dir_err"
  }
  local_self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  local_dst="$work/$(basename "$0")"
  if [ "$local_self" != "$local_dst" ]; then
    cp "$0" "$local_dst" 2>/dev/null || {
      res="dir_error"
      result
      echo
      echo "复制安装器到 $work 失败"
      fail "$dir_err"
    }
  fi
  manifest_url="$base/$latest"
  manifest "$manifest_url" latest || {
    res="meta_error"
    result
    echo
    echo "获取清单失败。"
    fail "$meta_err"
  }
  echo
  echo "最新版本: $ver"
  echo
  cur="$(installed "$work")"
  if [ -n "$cur" ] && [ "$(cmp "$cur" "$ver")" = "eq" ]; then
    res="up_to_date"
    result
    echo
    echo "当前版本: $cur"
    echo "远端版本: $ver"
    echo "已经是最新版本。"
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
      echo "下载失败。"
      fail "$code"
    }
  fi
  res="init_ready"
  result
  echo
  echo "下载完成。"
  echo "版本:     $ver"
  echo "安装包:   $pkg_file"
  echo "安装脚本: $ins_file"
  echo "结果文件: $res_file"
  echo
  if [ -n "$ins_file" ]; then
    echo "[init] 正在运行安装脚本..."
    if ! (cd "$work/downloads" && bash "$(basename "$ins_file")" "$ver"); then
      res="run_error"
      result
      echo
      echo "执行安装步骤失败: $ins_file"
      fail "$run_err"
    fi
  else
    res="run_error"
    result
    echo
    echo "执行安装步骤失败：清单中缺少安装脚本。"
    fail "$run_err"
  fi

  mkdir -p "$HOME/aether_Database" 2>/dev/null || true

  done_hold
  exit 0
fi

if [ "$mode" = "auto" ]; then
  [ -n "$arg" ] || {
    echo "auto 模式需要当前版本号。"
    echo "示例: $(basename "$0") auto 1.2.3"
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
    echo "工作目录处理失败。"
    exit "$dir_err"
  }
  manifest_url="$base/$latest"
  manifest "$manifest_url" latest || {
    res="meta_error"
    result
    echo
    echo "获取清单失败。"
    exit "$meta_err"
  }
  echo
  echo "最新版本: $ver"
  echo
  if [ "$(cmp "$cur" "$ver")" = "lt" ]; then
    echo "当前版本: $cur"
    echo "远端版本: $ver"
    grab || {
      code="$?"
      res="download_error"
      [ "$code" = "$sum_err" ] && res="checksum_error"
      result
      echo
      echo "下载失败。"
      exit "$code"
    }
    res="update_ready"
    result
    exit "$ready"
  fi
  echo "当前版本: $cur"
  echo "远端版本: $ver"
  echo "已经是最新版本。"
  res="up_to_date"
  result
  exit "$latest_ok"
fi

if [ "$mode" = "manual" ]; then
  [ -n "$arg" ] || {
    echo "manual 模式需要版本号。"
    echo "示例: $(basename "$0") manual 1.2.3"
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
    echo "工作目录处理失败。"
    exit "$dir_err"
  }
  manifest_url="$base/$req/mac-arm64.yml"
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
    echo "获取清单失败。"
    exit "$meta_err"
  fi
  echo "请求版本: $req"
  echo "解析版本: $ver"
  grab || {
    code="$?"
    res="download_error"
    [ "$code" = "$sum_err" ] && res="checksum_error"
    result
    echo
    echo "下载失败。"
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
