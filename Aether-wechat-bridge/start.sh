#!/bin/bash
# Aether WeChat Bridge 启动脚本

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

REQ="3.11"
VENV="$DIR/.venv"
PY=""

has_py() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1
}

pick_py() {
  if [ -x "$VENV/bin/python" ] && has_py "$VENV/bin/python"; then
    PY="$VENV/bin/python"
    return 0
  fi

  for c in python3.13 python3.12 python3.11 python3; do
    if command -v "$c" >/dev/null 2>&1 && has_py "$c"; then
      PY="$(command -v "$c")"
      return 0
    fi
  done

  return 1
}

need_optin() {
  echo "[AETHER_INSTALL_REQUIRED]"
  echo "未检测到 Python >= $REQ。"
  echo "将下载并安装开发工具（pyenv/Python），需要联网与管理员权限，可能耗时。"
  echo "请在前端弹窗让用户确认后，使用 AETHER_AUTO_INSTALL=1 重新执行此脚本。"
}

root_run() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    if sudo -n "$@"; then
      return 0
    fi

    echo "[AETHER_ADMIN_REQUIRED]"
    echo "自动安装需要管理员权限，当前会话无法无交互提权。"
    echo "请在终端手动执行安装命令后重试。"
    exit 21
  fi

  echo "错误: 需要管理员权限，但系统中没有 sudo。"
  exit 1
}

install_mac() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "错误: macOS 未检测到 Homebrew，无法自动安装 Python。"
    echo "请先安装 Homebrew: https://brew.sh"
    exit 1
  fi

  echo "正在通过 Homebrew 安装 Python 3.11..."
  brew install python@3.11
}

install_linux() {
  if command -v apt-get >/dev/null 2>&1; then
    root_run apt-get update
    root_run apt-get install -y python3.11 python3.11-venv python3-pip
    return 0
  fi

  if command -v dnf >/dev/null 2>&1; then
    root_run dnf install -y python3.11
    return 0
  fi

  if command -v yum >/dev/null 2>&1; then
    root_run yum install -y python3.11
    return 0
  fi

  if command -v zypper >/dev/null 2>&1; then
    root_run zypper --non-interactive install python311
    return 0
  fi

  if command -v pacman >/dev/null 2>&1; then
    root_run pacman -Sy --noconfirm python
    return 0
  fi

  echo "错误: 当前 Linux 发行版包管理器不受支持。"
  echo "请手动安装 Python >= $REQ 后重试。"
  exit 1
}

install_py() {
  if [ "${AETHER_AUTO_INSTALL:-0}" != "1" ]; then
    need_optin
    exit 20
  fi

  os="$(uname -s)"
  if [ "$os" = "Darwin" ]; then
    install_mac
  elif [ "$os" = "Linux" ]; then
    install_linux
  else
    echo "错误: 仅支持 macOS 和 Linux，当前系统: $os"
    exit 1
  fi

  if pick_py; then
    return 0
  fi

  echo "错误: 自动安装已执行，但仍未找到 Python >= $REQ。"
  echo "请手动安装后重试。"
  exit 1
}

if ! pick_py; then
  install_py
fi

if [ ! -x "$VENV/bin/python" ]; then
  echo "正在创建虚拟环境: $VENV"
  "$PY" -m venv "$VENV"
fi

if ! "$VENV/bin/python" -c "import wechat_agent_sdk, httpx" >/dev/null 2>&1; then
  echo "正在安装依赖..."
  "$VENV/bin/python" -m pip install --upgrade pip
  "$VENV/bin/python" -m pip install -r requirements.txt
fi

# 设置默认环境变量
export AETHER_URL="${AETHER_URL:-http://127.0.0.1:4096}"
export AETHER_WORK_DIR="${AETHER_WORK_DIR:-$HOME}"

echo "Aether URL: $AETHER_URL"
echo "工作目录: $AETHER_WORK_DIR"
echo "Python: $($VENV/bin/python --version 2>&1)"

# 启动
exec "$VENV/bin/python" aether_wechat_agent.py
