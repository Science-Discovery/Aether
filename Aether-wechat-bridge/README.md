# Aether WeChat Bridge

将 Aether AI 接入微信的桥接程序。

## 架构

```
微信消息 → wechat-agent-sdk → AetherAgent → Aether HTTP API → AI 响应
```

## 前置条件

1. **Python >= 3.11**
2. **Aether 已安装** - 从 [Releases](https://github.com/Science-Discovery/Aether/releases) 下载
3. **微信账号** - 用于扫码登录

## 安装

```bash
cd aether-wechat-bridge
pip install -r requirements.txt
```

需要 `Node.js >= 22` 和 `bun`，用于发送微信文件附件。

## 使用方法

### 第一步：配置 API 密钥

创建 `~/.opencode.json` 配置文件：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-20250514",
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "sk-ant-your-api-key"
      }
    }
  }
}
```

或使用其他支持的模型：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/gpt-4o",
  "provider": {
    "openai": {
      "options": {
        "apiKey": "sk-your-openai-key"
      }
    }
  }
}
```

### 第二步：启动 Aether 服务

```bash
在aether可执行文件下执行：
chmod +x aether
./aether serve
```

### 第三步：运行微信桥接

```bash
python aether_wechat_agent.py
```

终端会显示二维码，用微信扫码登录。

## 环境变量配置

| 变量              | 说明            | 默认值                  |
| ----------------- | --------------- | ----------------------- |
| `AETHER_URL`      | Aether 服务地址 | `http://127.0.0.1:4096` |
| `AETHER_WORK_DIR` | 工作目录        | 当前目录                |
| `AETHER_MODEL`    | 默认模型        | 配置文件中的模型        |
| `AETHER_AGENT`    | 默认 Agent      | `build`                 |

示例：

```bash
export AETHER_URL="http://127.0.0.1:4096"
export AETHER_WORK_DIR="$HOME/Projects"
export AETHER_MODEL="anthropic/claude-sonnet-4-20250514"
export AETHER_AGENT="build"

python aether_wechat_agent.py
```

## 注意事项

1. **首次登录**：首次运行需要扫码登录，登录凭证会保存在 `~/.wechat-agent-sdk/accounts.json`
2. **消息限制**：微信消息有长度限制，超长回复会被自动拆分
3. **API 费用**：使用 AI 模型会产生费用，请注意用量
4. **仅供学习**：本项目基于 iLink Bot API，仅供学习交流使用

### 文件操作卡住/无响应

**原因**：Aether 默认对敏感操作（文件编辑、执行命令、访问外部目录）需要权限确认。在微信非交互环境下无法弹出确认框，导致请求一直等待。

**解决方案**：配置 `~/.config/opencode/opencode.jsonc` 自动批准权限：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "external_directory": "allow",
    "edit": "allow",
    "bash": "allow",
    "read": "allow",
    "write": "allow",
    "glob": "allow",
    "grep": "allow"
  }
}
```

**权限说明**：

| 权限                 | 说明                 |
| -------------------- | -------------------- |
| `external_directory` | 访问工作目录外的目录 |
| `edit`               | 编辑文件             |
| `bash`               | 执行 shell 命令      |
| `read`               | 读取文件             |
| `write`              | 创建/写入文件        |
| `glob`               | 搜索文件             |
| `grep`               | 搜索文件内容         |

**手动批准待处理权限**：

如果有权限请求正在等待，可通过 API 手动批准：

```bash
# 查看待处理权限
curl http://127.0.0.1:4096/permission

# 批准指定权限（"always" 表示以后自动批准该类型）
curl -X POST http://127.0.0.1:4096/permission/<permission_id> \
  -H "Content-Type: application/json" \
  -d '{"reply": "always"}'
```

修改配置后需要**重启 Aether 服务**。

## 许可证

MIT
