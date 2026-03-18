<p align="center">
  <strong>Aether（以太）</strong>
</p>
<p align="center"><em>Autonomous Engine for Theoretical & Hands-on Exploration in Research</em></p>
<p align="center">基于 <a href="https://github.com/anomalyco/opencode">OpenCode</a> 深度定制的 AI 编程 Agent。</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## 项目简介

Aether 是在 OpenCode 基础上修改的 AI 编程助手，支持终端、浏览器和桌面三种使用方式。核心特点：

- **不绑定特定提供商**：支持 Claude、OpenAI、本地模型或任何兼容 OpenAI 协议的私有 API
- **三种运行模式**：TUI 终端界面、Web 浏览器界面、Electron 桌面应用
- **客户端/服务器架构**：CLI 内置 HTTP 服务，可在本机运行，同时用浏览器或移动设备远程访问
- **内置 LSP 支持**：代码感知能力

---

## 从源码启动

**依赖：** [Bun](https://bun.sh/) 1.3+

```bash
bun install
```

### TUI 终端模式

```bash
# 在 packages/opencode 目录下运行
bun dev

# 在仓库根目录运行
bun dev .

# 在指定目录运行（推荐：新开一个窗口并打开目标项目文件夹，再运行此命令）
bun dev <path>
```

内置两种 Agent，`Tab` 键切换：
- **build**：默认模式，具备完整权限，适合开发
- **plan**：只读模式，适合代码分析与规划

### Web 浏览器模式

需要两个终端：

```bash
# 终端 1：启动 API Server
bun dev serve

# 终端 2：启动前端
bun run --cwd packages/app dev
```

然后打开终端 2 中显示的 `http://localhost:xxxx`。

### 接入自定义 API

在 `~/.opencode.json` 中配置（以私有 Claude 兼容接口为例）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "my-claude": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://你的IP地址/v1",
        "apiKey": "sk-你的KEY"
      },
      "models": {
        "claude-opus-4-5-20251101": {},
        "claude-haiku-4-5-20251001": {}
      }
    }
  },
  "model": "my-claude/claude-opus-4-5-20251101"
}
```

WSL 环境需要额外指定配置文件路径：

```bash
echo 'export OPENCODE_CONFIG="$HOME/.opencode.json"' >> ~/.bashrc
source ~/.bashrc
```

验证：`openresearch models` 能看到自定义模型即配置生效。

详细调试指南见 [DEBUG.md](DEBUG.md)。

---

## 从安装包启动

从 Releases 页面下载对应平台的压缩包，解压后按以下方式启动。

### Web 浏览器版（推荐）

解压后目录结构：

```
openresearch          ← CLI 二进制（Windows 为 openresearch.exe）
web/                  ← 前端静态资源（必须与二进制同目录）
OpenResearch.vbs      ← Windows 启动器
OpenResearch.command  ← macOS 启动器
```

**Windows**：双击 `OpenResearch.vbs`，浏览器自动打开界面，无黑色命令窗口。

**macOS**：双击 `OpenResearch.command`，或在终端运行：

```bash
chmod +x openresearch   # 首次需要
./openresearch web
```

**Linux**：

```bash
chmod +x openresearch   # 首次需要
./openresearch web
```

浏览器未自动打开时，手动访问终端中显示的 URL。按 `Ctrl+C` 停止服务。

### Electron 桌面版

解压（或安装）后直接双击运行：

| 平台 | 文件 |
|---|---|
| Linux | `openresearch-linux-x64.AppImage` / `.deb` / `.rpm` |
| macOS | `openresearch-mac-arm64.dmg`（Apple Silicon）/ `openresearch-mac-x64.dmg` |
| Windows | `openresearch-win-x64.exe` 安装程序 / `win-unpacked/` 便携版 |

---

## 常见问题

**API 返回 404**：检查 `baseURL` 是否遗漏了 `/v1`。

**API 返回 429**：Key 填错，或被旧的 `auth.json` 覆盖，删除 `~/.local/share/opencode/auth.json` 后重试。

**浏览器未自动打开**：手动访问终端中显示的 URL（依赖 `xdg-open`）。

**提示找不到前端资源**：确认 `openresearch` 二进制和 `web/` 目录在同一目录下。
