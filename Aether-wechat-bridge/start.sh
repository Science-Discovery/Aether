#!/bin/bash
# Aether WeChat Bridge 启动脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 检查 Python 版本
PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}' | cut -d. -f1,2)
REQUIRED_VERSION="3.11"

if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$PYTHON_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then
    echo "错误: 需要 Python >= 3.11，当前版本: $PYTHON_VERSION"
    exit 1
fi

# 检查依赖
if ! python3 -c "import wechat_agent_sdk" 2>/dev/null; then
    echo "正在安装依赖..."
    pip install -r requirements.txt
fi

# 设置默认环境变量
export AETHER_URL="${AETHER_URL:-http://127.0.0.1:4096}"
export AETHER_WORK_DIR="${AETHER_WORK_DIR:-$HOME}"
export AETHER_MODEL="${AETHER_MODEL:-anthropic/claude-opus-4-6}"

echo "Aether URL: $AETHER_URL"
echo "工作目录: $AETHER_WORK_DIR"

# 启动
python3 aether_wechat_agent.py