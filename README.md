<h1 align="center">Aether</h1>
<p align="center"><em>Autonomous Engine for Theoretical & Hands-on Exploration in Research</em></p>
<p align="center">An AI research assistant for researchers, built on <a href="https://github.com/anomalyco/opencode">OpenCode</a>.</p>
<p align="center"><a href="https://aether.aiphys.cn/">🌐 aether.aiphys.cn</a></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a>
</p>

---

## Overview

Aether is a feature-rich AI research assistant platform. It runs with a client/server architecture — the CLI starts a local HTTP server, providing a full interactive interface through the browser. Mobile access (WeChat / Feishu / QQ) is also supported. Desktop client (Electron) support is planned for the future.

### Key Features

- **Ready to use**: Download and double-click to launch; built-in default model settings
- **Full coding capabilities**: Code execution, LSP code intelligence, file and terminal operations — covering the entire daily development workflow
- **25+ AI providers**: Supports Anthropic, OpenAI, Google Gemini, AIhubmix, DeepSeek, Z.AI, Kimi, Qwen, and other mainstream platforms, plus any OpenAI-compatible API
- **10+ built-in research Skills**: Literature review, paper writing, deep research, arXiv search, peer review, research grant writing, and more — ready to use out of the box
- **Skill self-evolution**: After completing a task, the Agent automatically reviews the conversation history and solidifies successful experiences into reusable Skills (copy-on-write writes, security scanning, version snapshots), forming a continuous learning loop
- **MCP protocol support**: Integrates Model Context Protocol — connect local or remote MCP servers to extend the toolset
- **Knowledge base (RAG)**: Vector-index PDF and text documents, with semantic search that injects only relevant context, significantly reducing token usage
- **PDF reading mode**: Read PDFs directly in the Web UI with highlights, bookmarks, notes, and AI-assisted translation and Q&A
- **PDF to Markdown**: AI-driven multi-stage pipeline that converts PDF papers into high-quality editable Markdown (with formula and image extraction)
- **Markdown translation**: AI-powered Markdown document translation that automatically preserves LaTeX formulas
- **Voice input**: Speech-to-text powered by multimodal models, automatically removing filler words and correcting technical terms
- **Git integration**: View branches, commit history, diffs, and file changes in the UI
- **Scheduled tasks**: Supports cron expressions, fixed intervals, and one-time scheduled tasks for automating research workflows
- **Memory mechanism**: AI automatically persists user preferences and interaction experiences to `memory.instruction.md`, reused across sessions without repetition
- **Session sharing**: Generate shareable links with real-time conversation sync

---

## Installation & Launch

### Installer Script (Recommended)

Download the installer script for your platform from the [official website](https://aether.aiphys.cn/) for one-click installation with automatic updates. After installation, simply launch from your system applications.

### Manual Installation

Download the archive for your platform from the [Releases page](https://github.com/Science-Discovery/Aether/releases).

#### Web Browser Version

Extracted directory layout:

```
aether          ← CLI binary (aether.exe on Windows)
web/            ← Frontend static assets (must stay alongside the binary)
Aether.vbs      ← Windows launcher
Aether.command  ← macOS launcher
```

**Windows**: Double-click `Aether.vbs` (if it errors, run `Aether.exe` first) — the browser opens automatically.

**macOS**: Grant execute permission on first use, then double-click `Aether.command` to launch:

```bash
chmod +x Aether.command aether   # first time only
```

**Linux**:

```bash
chmod +x aether   # first time only
./aether web
```

After `aether web` starts, it displays local and network access URLs, and the browser opens automatically.

<!-- Supported options:

```bash
./aether web --port 8080              # specify port
./aether web --hostname 0.0.0.0       # allow network access
./aether web --idle-timeout 120       # idle timeout in seconds, 0 for always-on
``` -->

### Electron Desktop Version

Coming soon

<!-- Extract (or install) and double-click to run:

| Platform | File |
|---|---|
| Linux | `aether-linux-x64.AppImage` / `.deb` / `.rpm` |
| macOS | `aether-mac-arm64.dmg` (Apple Silicon) / `aether-mac-x64.dmg` |
| Windows | `aether-win-x64.exe` installer / `win-unpacked/` portable |

--- -->

## Running from Source

For development and debugging. **Requires:** [Bun](https://bun.sh/) 1.3+

```bash
bun install
```

### Web UI Development Mode

Requires two terminals to start the backend and frontend separately:

```bash
# Terminal 1: start the API server
bun dev serve

# Terminal 2: start the frontend (then open the displayed http://localhost:xxxx)
bun run --cwd packages/app dev
```
If resources fail to load after the page opens, manually add the `http://localhost:xxxx` URL shown in Terminal 1 to the server list.

---

## Configuring AI Providers

You can use the built-in free providers, or add AI providers through the settings UI (recommended).

## Feature Details

### Built-in Skills

Aether includes 16 research-oriented Skills that auto-trigger based on their descriptions — no manual invocation needed:

| Category | Skill | Function |
|---|---|---|
| Dev Tools | `skill-creator` | Create and optimize Agent Skills |
| | `skill-manager` | Scan, classify, and manage Skills collections |
| | `code-reviewer` | Code review (security, performance, best practices) |
| | `project-signpost` | Generate project directory navigation files |
| Academic Research | `academic-researcher` | Literature review, paper analysis, equation derivation |
| | `literature-review` | Multi-database systematic literature review |
| | `peer-review` | Peer review toolkit |
| | `write-paper` | Generate LaTeX papers from research project files |
| | `deep-research` | Multi-source synthesis and deep research |
| | `arxiv-search` | Search arXiv for preprints |
| | `read-arxiv-paper` | Read and analyze arXiv papers |
| | `research-grants` | Write research grant proposals |
| | `scientific-critical-thinking` | Scientific evidence quality assessment |
| | `scientific-brainstorming` | Research hypothesis generation and interdisciplinary exploration |
| | `response-to-referee` | Point-by-point responses to reviewer comments |
| General | `brainstorming` | Turn ideas into designs before implementation |

Academic Skills can be chained: `arxiv-search` → `read-arxiv-paper` → `literature-review` → `write-paper`

### Knowledge Base

Vector-index PDF papers or text documents (`.md`, `.txt`, `.json`, `.yaml`, `.csv`, `.tex`) in bulk:

- **Three embedding options**: OpenAI API, local model `all-MiniLM-L6-v2` (no API key needed), or custom endpoints
- **Semantic search**: Cosine similarity-based retrieval of the most relevant passages, injecting only necessary context rather than entire documents
- **Auto-sync**: Detects file additions, modifications, and deletions, automatically updating the index

### PDF Reading Mode

Read PDFs directly in the Web UI:

- **Annotation system**: Highlights (four colors), bookmarks, notes
- **AI-assisted translation**: English-to-Chinese translation that preserves technical terms
- **AI Q&A**: Answer questions based on the current page and surrounding context pages
- **First-read summary**: Automatically generates a full-document summary when opening a document

### PDF to Markdown

AI-driven multi-stage pipeline:

1. Page rendering → text extraction → figure localization → formula recognition
2. LaTeX syntax validation and content integrity checks
3. Automated fixes and cross-page quality verification

### MCP Tool Integration

Connect external MCP (Model Context Protocol) servers to extend AI capabilities:

```bash
aether mcp add <name> <command>    # Add a local MCP server
aether mcp list                     # List configured servers
aether mcp auth <name>              # OAuth authentication
aether mcp debug                    # Debug MCP connections
```

### Mobile Access

Chat with Aether from your phone via WeChat, Feishu, or QQ bots. Configure credentials for the respective platforms in the Web UI settings.

---

## Other Commands

```bash
aether web            # Start web server and open browser
aether serve          # Start headless API server
aether run <message>  # Non-interactive command execution
aether models         # List available models
aether providers      # View providers
aether mcp            # Manage MCP servers
aether session        # Session management
aether stats          # View usage statistics
aether upgrade        # Self-update
aether debug config   # View current configuration
```

---

## Troubleshooting

**API returns 404**: Check that `baseURL` ends with `/v1`.

**API returns 429**: Wrong key, or overridden by a stale `auth.json` — delete `~/.local/share/opencode/auth.json` and retry.

**Browser doesn't open automatically**: Visit the URL shown in the terminal manually (requires `xdg-open`).

**Frontend assets not found**: Ensure the `aether` binary and `web/` directory are in the same folder.

**Model list is empty**: Check that the `OPENCODE_CONFIG` environment variable path is correct.
