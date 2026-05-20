<h1 align="center">Aether（以太）</h1>
<p align="center"><em>Autonomous Engine for Theoretical & Hands-on Exploration in Research</em></p>
<p align="center">面向科研人员的 AI 研究助手，基于 <a href="https://github.com/anomalyco/opencode">OpenCode</a> 深度定制。</p>
<p align="center"><a href="https://aether.aiphys.cn/">🌐 aether.aiphys.cn</a></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a>
</p>

---

## 项目简介

Aether 是一个功能丰富的 AI 研究助手平台。它以客户端/服务器架构运行——CLI 在本地启动 HTTP 服务，通过浏览器提供完整的交互界面。支持移动端（微信 / 飞书 / QQ）接入。未来预计支持桌面客户端（Electron）。

### 核心特性

- **开箱即用**：下载安装包双击即可启动，内置默认模型配置
- **完整编程能力**：代码运行、LSP 代码感知、文件和终端操作，覆盖日常开发全流程
- **25+ AI 提供商**：支持 Anthropic、OpenAI、Google Gemini、AIhubmix、DeepSeek、Z\.AI、Kimi、Qwen 等主流平台，以及任何 OpenAI 兼容接口
- **10+ 个内置科研 Skills**：文献综述、论文写作、深度研究、arXiv 搜索、同行评审、研究基金撰写等，开箱即用
- **Skill 自进化**：Agent 在完成任务后自动评审对话历史，将成功经验固化为可复用的 Skill（copy-on-write 写入、安全扫描、版本快照），形成持续学习闭环
- **MCP 协议支持**：集成 Model Context Protocol，可连接本地或远程 MCP 服务器扩展工具集
- **知识库（RAG）**：将 PDF 和文本文档向量化索引，支持语义搜索，按相关性注入上下文，大幅节省 Token
- **PDF 阅读模式**：在 Web 界面中直接阅读 PDF，支持高亮标注、书签、笔记，以及 AI 辅助翻译和问答
- **PDF 转 Markdown**：AI 驱动的多阶段处理流水线，将 PDF 论文高质量转换为可编辑的 Markdown（含公式和图片提取）
- **Markdown 翻译**：AI 翻译 Markdown 文档，自动保护 LaTeX 公式不被破坏
- **语音输入**：基于多模态模型的语音转文字，自动去除语气词并纠正专业术语
- **Git 集成**：在界面中查看分支、提交历史、Diff 和文件变更等
- **定时任务**：支持 Cron 表达式、固定间隔和一次性定时任务，可自动执行研究流程
- **Memory 机制**：AI 自动将用户偏好和交互经验持久化到 `memory.instruction.md`，跨会话复用，无需重复说明
- **会话分享**：生成分享链接，实时同步对话内容

---

## 安装与启动

### Installer 脚本安装（推荐）

从 [官网](https://aether.aiphys.cn/) 下载对应平台的 Installer 脚本，一键安装并享受自动更新。安装完成后直接从系统应用程序中点击运行即可。

### 手动安装

从 [Releases 页面](https://github.com/Science-Discovery/Aether/releases)下载对应平台的压缩包。

#### Web 浏览器版

解压后目录结构：

```
aether          ← CLI 二进制（Windows 为 aether.exe）
web/            ← 前端静态资源（必须与二进制同目录）
Aether.vbs      ← Windows 启动器
Aether.command  ← macOS 启动器
```

**Windows**：双击 `Aether.vbs`（如果报错，先运行 `Aether.exe`），浏览器自动打开界面。

**macOS**：首次使用赋予执行权限后，双击 `Aether.command` 即可启动：

```bash
chmod +x Aether.command aether   # 首次需要
```

**Linux**：

```bash
chmod +x aether   # 首次需要
./aether web
```

`aether web` 启动后会显示本地和局域网访问地址，浏览器自动打开。

<!-- 支持以下选项：

```bash
./aether web --port 8080              # 指定端口
./aether web --hostname 0.0.0.0       # 允许局域网访问
./aether web --idle-timeout 120       # 空闲超时（秒），0 表示常驻运行
AETHER_IDLE_TIMEOUT=15 ./Aether.sh    # 部署时覆盖空闲超时（秒）
``` -->

### Electron 桌面版

敬请期待

<!-- 解压（或安装）后双击运行：

| 平台 | 文件 |
|---|---|
| Linux | `aether-linux-x64.AppImage` / `.deb` / `.rpm` |
| macOS | `aether-mac-arm64.dmg`（Apple Silicon）/ `aether-mac-x64.dmg` |
| Windows | `aether-win-x64.exe` 安装程序 / `win-unpacked/` 便携版 |

--- -->

## 从源码运行

适用于开发调试。**依赖：** [Bun](https://bun.sh/) 1.3+

```bash
bun install
```

### Web UI 开发模式

需要两个终端分别启动后端和前端：

```bash
# 终端 1：启动 API Server
bun dev serve

# 终端 2：启动前端（然后打开显示的 http://localhost:xxxx）
bun run --cwd packages/app dev
```
网页打开后如果发现资源加载失败，可以手动添加终端1中显示的 `http://localhost:xxxx` 到服务器列表中。

---

## 配置 AI 提供商

可使用预置免费提供商，也可通过设置界面添加AI提供商（推荐）。

## 功能详解

### 内置 Skills

Aether 预置了 16 个面向科研场景的 Skills，通过描述自动触发，无需手动调用：

| 类别 | Skill | 功能 |
|---|---|---|
| 开发工具 | `skill-creator` | 创建和优化 Agent Skills |
| | `skill-manager` | 扫描、分类和管理 Skills 集合 |
| | `code-reviewer` | 代码审查（安全、性能、最佳实践） |
| | `project-signpost` | 生成项目目录导航文件 |
| 学术研究 | `academic-researcher` | 文献综述、论文分析、公式推导 |
| | `literature-review` | 多数据库系统文献综述 |
| | `peer-review` | 同行评审工具包 |
| | `write-paper` | 从研究项目文件生成 LaTeX 论文 |
| | `deep-research` | 多源综合深度研究 |
| | `arxiv-search` | 搜索 arXiv 预印本 |
| | `read-arxiv-paper` | 阅读和分析 arXiv 论文 |
| | `research-grants` | 撰写研究基金申请书 |
| | `scientific-critical-thinking` | 科学证据质量评估 |
| | `scientific-brainstorming` | 科研假设生成与跨学科探索 |
| | `response-to-referee` | 逐条回复审稿人意见 |
| 通用 | `brainstorming` | 在实现之前将想法转化为设计方案 |

学术 Skills 可串联使用：`arxiv-search` → `read-arxiv-paper` → `literature-review` → `write-paper`

### 知识库

将 PDF 论文或文本文档（`.md`、`.txt`、`.json`、`.yaml`、`.csv`、`.tex`）批量向量化索引：

- **三种嵌入方式**：OpenAI API、本地模型 `all-MiniLM-L6-v2`（无需 API Key）、自定义接口
- **语义搜索**：基于余弦相似度检索最相关段落，只注入必要的上下文，而非整篇文献
- **自动同步**：检测文件增删改，自动更新索引

### PDF 阅读模式

在 Web 界面中直接阅读 PDF：

- **标注系统**：高亮（四种颜色）、书签、笔记
- **AI 辅助翻译**：保留专业术语的英中翻译
- **AI 问答**：基于当前页及上下文页面的内容回答问题
- **首次阅读摘要**：打开文档时自动生成全文摘要

### PDF 转 Markdown

AI 驱动的多阶段处理流水线：

1. 页面渲染 → 文本提取 → 图片定位 → 公式识别
2. LaTeX 语法校验和内容完整性检查
3. 自动修复和跨页面质量校验

### MCP 工具集成

支持连接外部 MCP（Model Context Protocol）服务器扩展 AI 能力：

```bash
aether mcp add <name> <command>    # 添加本地 MCP 服务器
aether mcp list                     # 列出已配置的服务器
aether mcp auth <name>              # OAuth 认证
aether mcp debug                    # 调试 MCP 连接
```

### 移动端

通过微信、飞书、QQ 机器人从手机端与 Aether 对话。在 Web 界面的设置中配置对应平台的凭证即可启用。

---

## 其他命令

```bash
aether web            # 启动 Web 服务并打开浏览器
aether serve          # 启动无头 API 服务器
aether run <message>  # 非交互式执行指令
aether models         # 列出可用模型
aether providers      # 查看提供商
aether mcp            # 管理 MCP 服务器
aether session        # 会话管理
aether stats          # 查看使用统计
aether upgrade        # 自更新
aether debug config   # 查看当前配置
```

---

## 常见问题

**API 返回 404**：检查 `baseURL` 是否遗漏了 `/v1`。

**API 返回 429**：Key 填错，或被旧的 `auth.json` 覆盖。删除 `~/.local/share/opencode/auth.json` 后重试。

**浏览器未自动打开**：手动访问终端中显示的 URL（依赖 `xdg-open`）。

**提示找不到前端资源**：确认 `aether` 二进制和 `web/` 目录在同一目录下。

**模型列表为空**：检查环境变量 `OPENCODE_CONFIG` 路径是否正确。

---
