#!/bin/bash
# Aether + WeChat Bridge 启动脚本 (macOS)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AETHER_DIR="$(dirname "$SCRIPT_DIR")"
AETHER_BIN="$AETHER_DIR/bin/aether"
WECHAT_BRIDGE="$AETHER_DIR/wechat-bridge"
PORT="${AETHER_PORT:-4096}"

AETHER_PID=""

cleanup() {
    echo ""
    echo "[清理] 正在关闭服务..."
    if [ -n "$AETHER_PID" ] && kill -0 "$AETHER_PID" 2>/dev/null; then
        kill "$AETHER_PID" 2>/dev/null
        echo "[清理] Aether 服务已停止 (PID: $AETHER_PID)"
    fi
    exit 0
}

trap cleanup SIGINT SIGTERM

echo "=========================================="
echo "  Aether + WeChat Bridge (macOS)"
echo "=========================================="
echo ""

if [ ! -f "$AETHER_BIN" ]; then
    echo "错误: 找不到 Aether 二进制文件"
    echo "路径: $AETHER_BIN"
    echo ""
    echo "请确保目录结构正确:"
    echo "  aether-darwin-arm64/"
    echo "  ├── bin/aether"
    echo "  └── wechat-bridge/"
    exit 1
fi

if [ ! -d "$WECHAT_BRIDGE" ]; then
    echo "错误: 找不到微信桥接目录"
    echo "路径: $WECHAT_BRIDGE"
    exit 1
fi

if ! command -v python3 &> /dev/null; then
    echo "错误: 需要安装 Python 3.11+"
    echo "建议: brew install python@3.11"
    exit 1
fi

PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}' | cut -d. -f1,2)
echo "[检查] Python 版本: $PYTHON_VERSION"

if [ ! -d "$WECHAT_BRIDGE/venv" ]; then
    echo "[创建] Python 虚拟环境..."
    python3 -m venv "$WECHAT_BRIDGE/venv"
    if [ $? -ne 0 ]; then
        echo "错误: 虚拟环境创建失败"
        exit 1
    fi
fi

source "$WECHAT_BRIDGE/venv/bin/activate"

if ! python3 -c "import wechat_agent_sdk" 2>/dev/null; then
    echo "[安装] 正在安装微信桥接依赖..."
    pip install -r "$WECHAT_BRIDGE/requirements.txt"
    if [ $? -ne 0 ]; then
        echo "错误: 依赖安装失败"
        exit 1
    fi
fi

echo ""

echo "[启动] Aether 服务 (端口: $PORT)..."
"$AETHER_BIN" serve --port $PORT > /dev/null 2>&1 &
AETHER_PID=$!

echo "[等待] Aether 服务启动中..."
for i in {1..15}; do
    if curl -s "http://127.0.0.1:$PORT/path" > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

if ! curl -s "http://127.0.0.1:$PORT/path" > /dev/null 2>&1; then
    echo "错误: Aether 服务启动失败"
    kill "$AETHER_PID" 2>/dev/null
    exit 1
fi

echo "[成功] Aether 服务已启动 (PID: $AETHER_PID)"
echo ""

export AETHER_WORK_DIR="$AETHER_DIR"

echo "[启动] 微信桥接..."
echo "[提示] 请用微信扫描下方二维码登录"
echo ""
echo "----------------------------------------"

cd "$WECHAT_BRIDGE"
python3 aether_wechat_agent.py

cleanup