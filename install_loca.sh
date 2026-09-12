#!/usr/bin/env bash
# Install the LOCA workflow into a target project's .aether directory.
# Usage: ./install_loca.sh /path/to/target/project
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="${1:?用法: $0 <目标项目路径>}"

[ -d "$src/.aether/workflow/loca" ] || { echo "错误: 源仓库缺少 .aether/workflow/loca" >&2; exit 1; }
[ -d "$dest" ] || { echo "错误: 目标路径不存在: $dest" >&2; exit 1; }
dest="$(cd "$dest" && pwd)"

target="$dest/.aether"
if [ "$src/.aether" = "$target" ]; then
  echo "错误: 目标即源仓库自身，无需安装" >&2
  exit 1
fi

mkdir -p "$target/agent" "$target/command" "$target/plugins" "$target/skills" "$target/workflow"

cp "$src"/.aether/agent/loca*.md "$target/agent/"
cp "$src"/.aether/command/loca*.md "$target/command/"
cp "$src/.aether/plugins/loca.js" "$target/plugins/"
rsync -a --delete "$src/.aether/skills/loca-workflow/" "$target/skills/loca-workflow/"
rsync -a --delete --exclude .runtime/ --exclude results/ --exclude node_modules/ \
  "$src/.aether/workflow/loca/" "$target/workflow/loca/"

if [ ! -f "$target/.gitignore" ]; then
  cp "$src/.aether/.gitignore" "$target/.gitignore"
fi

echo "安装插件依赖 (zod)..."
bun install --cwd "$target/workflow/loca"

echo
echo "安装完成 -> $target"
echo "  agent/loca*.md            $(ls "$target/agent"/loca*.md | wc -l | tr -d ' ') 个角色定义"
echo "  command/loca*.md          $(ls "$target/command"/loca*.md | wc -l | tr -d ' ') 个命令"
echo "  plugins/loca.js           插件入口"
echo "  skills/loca-workflow/     使用技能"
echo "  workflow/loca/            工作流核心"
echo
echo "下一步: 重启该项目的 Aether 实例，然后在会话中输入 /loca <目标与验收标准>"
