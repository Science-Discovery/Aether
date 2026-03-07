# OpenCode 开发指南

## 环境准备

依赖：[Bun](https://bun.sh/) 1.3+，VSCode 插件 `oven.bun-vscode`

```bash
# WSL / 网络受限环境推荐
npm install -g bun

# 安装项目依赖
bun install
```

---

## 项目结构

```
opencode/
├── packages/
│   ├── opencode/   # 核心逻辑、API Server、TUI（SolidJS + opentui）
│   ├── app/        # Web UI（SolidJS + Vite）
│   ├── desktop/    # 桌面端（Tauri）
│   └── plugin/     # 插件包
```

---

## 启动与预览

改了代码想看效果，直接运行对应命令，保存后自动热重载。

**TUI 模式（最常用）：**

```bash
bun dev          # 在 packages/opencode 目录下运行
bun dev .        # 在当前仓库根目录运行
bun dev <path>   # 在指定目录运行
```

注意：
1. 要想在新文件夹中试用openresearch，需要开一个新窗口并先打开目标文件夹（如~/code/openresearch/test），然后在opencode项目(不是test项目)的终端运行bun dev ~/code/openresearch/test，此时会在opencode项目的终端显示opencode的对话框，在里面对话创建的代码文件会在test项目中出现。


**Web UI 模式（需要两个终端）：**

```bash
# 终端 1
bun dev serve

# 终端 2（然后打开 http://localhost:5173）
bun run --cwd packages/app dev
```

**修改了 Server API 后，需重新生成 SDK：**

```bash
./script/generate.ts
```

---

## 断点调试

> Bun 调试支持尚不完善，建议只用 **attach 模式**，不要用 launch 模式。

### 第一步：复制 VSCode 配置

```bash
cp .vscode/launch.example.json .vscode/launch.json
cp .vscode/settings.example.json .vscode/settings.json
```

### 第二步：以 inspect 模式启动

**调试 TUI + Server（推荐）：** 用 `spawn` 让 Server 跑在主进程而非 Worker 线程，断点才能命中。

```bash
bun run --inspect=ws://localhost:6499/ --cwd packages/opencode --conditions=browser src/index.ts spawn
```

**只调试 Server：** 另开终端用 `opencode attach` 连接 TUI。

```bash
# 终端 1
bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts serve --port 4096

# 终端 2
opencode attach http://localhost:4096
```

**调试 Web App：** 启动后直接用浏览器 F12 DevTools，无需 attach。

### 第三步：在 VSCode 中 Attach

按 `F5`，选择 **"opencode (attach)"**。

**小技巧：** 将下面这行加入 `.bashrc` / `.zshrc`，之后 `bun dev` 自动带上 inspect 参数：

```bash
export BUN_OPTIONS="--inspect=ws://localhost:6499/"
```

---

## 内置 debug 子命令

```bash
bun dev debug config    # 查看当前配置
bun dev debug file      # 调试文件读取
bun dev debug lsp       # 调试 LSP
bun dev debug ripgrep   # 调试搜索
bun dev debug agent     # 调试 Agent
bun dev debug snapshot  # 查看快照
bun dev debug skill     # 调试 Skill
```

---

## WSL 接入自定义 API

在 WSL 里接入自己的 API（如私有部署的 Claude），按以下步骤配置。

### 第一步：创建配置文件

直接在 WSL 终端创建，不要在 Windows 文件夹里新建（路径权限问题）：

```bash
nano ~/.opencode.json
```

填入以下内容（以接入 Claude 兼容接口为例）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "my-claude": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://你的IP地址/v1",
        "apiKey": "sk-你的真实KEY"
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

> **注意：** `baseURL` 结尾必须带 `/v1`，否则接口找不到，是最常见的报错原因。

### 第二步：设置环境变量

WSL 不会自动读取配置文件路径，需要手动指定：

```bash
echo 'export OPENCODE_CONFIG="$HOME/.opencode.json"' >> ~/.bashrc
source ~/.bashrc
```

### 第三步：清理旧的认证缓存

如果之前运行过 `opencode auth login`，会生成加密的 `auth.json` 并覆盖配置文件里的 Key，导致 429 报错。删除它：

```bash
rm ~/.local/share/opencode/auth.json
```

### 验证配置

```bash
opencode models   # 能看到 my-claude/claude-opus... 说明配置生效
```

---

## 常见问题

**断点没有命中：** 确认用的是 `attach` 模式，进程带了 `--inspect` 参数；调试 Server 代码要用 `spawn` 子命令。

**端口被占用：** 换个端口，同步修改 `.vscode/launch.json` 中的 `url` 字段。

**桌面应用无法启动：** 需要 Rust 工具链，参考 [Tauri 先决条件文档](https://v2.tauri.app/start/prerequisites/)。

**404 错误：** 检查 `baseURL` 是否遗漏了 `/v1`。

**429 频率限制：** Key 填错，或被旧的 `auth.json` 干扰，参考上方"清理旧的认证缓存"。

**模型列表为空：** 检查环境变量 `OPENCODE_CONFIG` 路径是否正确。
