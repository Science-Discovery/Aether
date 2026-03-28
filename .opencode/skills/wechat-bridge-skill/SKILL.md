---
name: wechat-bridge
description: '将 Aether AI 接入微信，实现微信机器人功能。触发条件: 微信接入 Aether、wechat bridge、启动微信桥接、微信机器人、微信扫码登录 Aether。支持 macOS、Linux、Windows 三平台。'
---

# Aether 微信桥接

通过微信桥接功能，在微信中使用 Aether AI 研究助手的全部能力。

## 功能特性

- 私聊和群聊消息处理
- 显示 AI 思考过程和回复
- 文件创建、编辑和执行代码
- 支持所有 Aether Skills

## 目录结构

```
aether-<platform>/
├── bin/
│   └── aether (或 aether.exe)
└── wechat-bridge-skill/
    ├── SKILL.md
    ├── scripts/
    │   ├── start-darwin.sh
    │   ├── start-linux.sh
    │   ├── start-windows.ps1
    │   └── start-windows.bat
    ├── assets/
    │   └── wechat-bridge/
    │       ├── aether_wechat_agent.py
    │       └── requirements.txt
    └── references/
        └── troubleshooting.md
```

## 快速开始

### 步骤 1: 运行启动脚本

根据你的操作系统选择对应脚本：

**macOS:**
```bash
cd aether-darwin-arm64/wechat-bridge-skill
chmod +x scripts/start-darwin.sh
./scripts/start-darwin.sh
```

**Linux:**
```bash
cd aether-linux-x64/wechat-bridge-skill
chmod +x scripts/start-linux.sh
./scripts/start-linux.sh
```

**Windows PowerShell:**
```powershell
cd aether-windows-x64\wechat-bridge-skill
.\scripts\start-windows.ps1
```

**Windows 批处理:**
```cmd
cd aether-windows-x64\wechat-bridge-skill
.\scripts\start-windows.bat
```

### 步骤 2: 扫码登录

终端显示二维码后，用微信扫描登录。登录成功后即可在微信中使用 Aether。

---

## 分步手动启动

如需手动控制每个步骤：

### 1. 创建虚拟环境并安装依赖

**macOS / Linux:**
```bash
cd wechat-bridge-skill/assets/wechat-bridge
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**Windows:**
```powershell
cd wechat-bridge-skill\assets\wechat-bridge
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 2. 启动 Aether 服务

**macOS / Linux:**
```bash
./bin/aether serve --port 4096
```

**Windows:**
```powershell
.\bin\aether.exe serve --port 4096
```

### 3. 启动微信桥接

```bash
cd wechat-bridge-skill/assets/wechat-bridge
python3 aether_wechat_agent.py  # macOS/Linux
python aether_wechat_agent.py   # Windows
```

---

## 权限配置

Aether 默认对敏感操作需要确认。在微信非交互环境下无法确认，会导致请求卡住。

### 配置文件

编辑 `~/.config/opencode/opencode.jsonc`:

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

### 权限说明

| 权限 | 说明 |
|------|------|
| `external_directory` | 访问工作目录外的目录 |
| `edit` | 编辑文件 |
| `bash` | 执行 shell 命令 |
| `read` | 读取文件 |
| `write` | 创建/写入文件 |
| `glob` | 搜索文件 |
| `grep` | 搜索文件内容 |

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AETHER_URL` | `http://127.0.0.1:4096` | Aether 服务地址 |
| `AETHER_WORK_DIR` | 当前目录 | 工作目录 |
| `AETHER_MODEL` | - | 默认模型 (格式: `provider/model`) |
| `AETHER_AGENT` | `build` | 默认 Agent |
| `AETHER_PORT` | `4096` | Aether 服务端口 |

---

## 使用方式

在微信中直接发送消息：

```
你好
当前工作目录是哪
帮我写一个 Python 脚本
创建一个 hello.py 文件
运行 python hello.py
```

---

## 故障排除

见 [troubleshooting.md](references/troubleshooting.md)

---

## 注意事项

1. **API 费用**: 使用 AI 模型会产生费用，请注意用量
2. **消息限制**: 微信消息有长度限制，超长回复会被自动拆分
3. **工作目录**: 默认为启动脚本时的当前目录
4. **仅供学习**: 微信桥接基于 iLink Bot API，仅供学习交流使用