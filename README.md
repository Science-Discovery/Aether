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

Aether is a feature-rich AI research assistant platform, running on a local client/server architecture. It offers two usage modes:

- **Web Browser Version**: Starts a local HTTP server and provides a full interactive interface through the browser — more stable
- **Electron Desktop Version**: Native desktop window with a smoother experience (may still have some instability)

Both modes share the same local data and sessions. Mobile access (WeChat / Feishu / QQ) is also supported.

### Key Features

- **Ready to use**: Download the installer script from the official website, or download the archive from Releases — built-in default model settings included
- **Full coding capabilities**: Fully inherits OpenCode's coding capabilities — code execution, LSP code intelligence, file and terminal operations, covering the entire daily development workflow
- **25+ AI providers**: Supports Anthropic, OpenAI, Google Gemini, AIhubmix, DeepSeek, Z\.AI, Kimi, Qwen, and other mainstream platforms, plus any OpenAI-compatible API
- **20+ built-in Skills**: Literature review, paper writing, deep research, arXiv search, peer review, research grant writing, document generation, and more — ready to use out of the box
- **Skill self-evolution**: After completing a task, the Agent automatically reviews the conversation history and solidifies successful experiences into reusable Skills (copy-on-write writes, security scanning, version snapshots), forming a continuous learning loop
- **MCP protocol support**: Integrates Model Context Protocol — connect local or remote MCP servers to extend the toolset
- **Knowledge base (RAG)**: Vector-index PDF and text documents, with semantic search that injects only relevant context, significantly reducing token usage
- **PDF reading mode**: Read PDFs directly in the Web UI with highlights, bookmarks, notes, and AI-assisted translation and Q&A
- **PDF to Markdown**: AI-driven multi-stage pipeline that converts PDF papers into high-quality editable Markdown (with formula and image extraction)
- **Markdown translation**: AI-powered Markdown document translation that automatically preserves LaTeX formulas
- **Voice input**: Speech-to-text powered by multimodal models, automatically removing filler words and correcting technical terms
- **Git integration**: View branches, commit history, diffs, and file changes in the UI
- **Scheduled tasks**: Supports cron expressions, fixed intervals, and one-time scheduled tasks for automating research workflows
- **Memory mechanism**: AI automatically persists user preferences and interaction experiences to a local memory file, reused across sessions without repetition
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
aether              ← CLI binary (aether.exe on Windows)
web/                ← Frontend static assets (must stay alongside the binary)
install.sh/.command/.bat  ← Installation script (‼️ creates desktop shortcuts, app entries, etc.)
Aether.sh / .command / .vbs  ← Launchers
aether-icon.*       ← App icon
```

It is recommended to run the installation script first. After installation, you can launch Aether from your system applications:

**Windows**: Right-click `install.bat` → Run as administrator (or run it in a terminal). After installation, launch from the desktop shortcut or Start Menu.

**macOS**:
In the extracted directory:

```bash
chmod +x install.command   # first time only
./install.command
```

If prompted with "cannot be opened because the developer cannot be verified" or "is damaged":

```bash
xattr -cr ./install.command ./aether ./Aether.command
```

Then right-click `install.command` and select "Open" to proceed with installation. After installation, launch from `/Applications/Aether.app` or Launchpad.

**Linux**:

```bash
chmod +x install.sh   # first time only
./install.sh
```

After installation, launch Aether from the system application launcher. (⚠️ Note: The shell script shortcut previously created on the desktop is now deprecated.)

If you prefer not to use the installation script, you can also launch directly (not recommended):

**Windows**: Double-click `Aether.vbs`. If blocked by antivirus software, choose to allow it.

**macOS**: Double-click `Aether.command` (requires `chmod +x` first).

**Linux**: Run `./Aether.sh` or `./aether web`.

After `aether web` starts, it displays local and network access URLs, and the browser opens automatically.

(If you encounter other issues during installation, please check [Troubleshooting](#troubleshooting) first, or contact us via the official website.)

<!-- Supported options:

```bash
./aether web --port 8080              # specify port
./aether web --hostname 0.0.0.0       # allow network access
./aether web --idle-timeout 120       # idle timeout in seconds, 0 for always-on
AETHER_IDLE_TIMEOUT=15 ./Aether.sh    # deployment idle timeout override in seconds
``` -->

#### Electron Desktop Version

Download the installer for your platform from the [Releases page](https://github.com/Science-Discovery/Aether/releases) (make sure to select the Desktop version, not the Web version archive).

| Platform | File |
|---|---|
| Windows | `aether-desktop-win-x64.exe` (NSIS installer) |
| macOS Apple Silicon | `aether-desktop-mac-arm64.dmg` |
| macOS Intel | `aether-desktop-mac-x64.dmg` |
| Linux | `.AppImage` / `.deb` / `.rpm` |

**Windows**: Double-click the `.exe` installer and follow the setup wizard. After installation, launch from the Start Menu or desktop shortcut. If antivirus software warns about risks, confirm the file is from the official GitHub Release and choose to keep it.

**macOS**: Open the `.dmg` and drag `Aether Desktop.app` into `Applications`. If prompted that the developer cannot be verified, go to "Settings → Privacy & Security", find the message about Aether Desktop, and click "Open Anyway". If prompted "is damaged", run in Terminal:

```bash
xattr -cr /Applications/Aether\ Desktop.app
```

**Linux**:

AppImage:

```bash
chmod +x ./aether-*.AppImage
./aether-*.AppImage
```

deb:

```bash
sudo dpkg -i ./aether-desktop*.deb
```

rpm:

```bash
sudo dnf install ./aether-desktop*.rpm
```

> **Note**: The desktop version shares the same data directory (`~/.local/share/aether`) with Web/CLI — existing users can switch seamlessly. The desktop version is currently unsigned; macOS updates are manual (check and open the GitHub Release page to download), while Windows and Linux AppImage support in-app updates. Linux deb and rpm packages do not yet support automatic updates — similar to macOS, you need to manually download the latest installer and reinstall after being prompted.
<!-- >
> For more details, see [Desktop User Guide](docs/desktop-electron-user-guide.zh-CN.md) | [Uninstall Instructions](docs/desktop-electron-uninstall.zh-CN.md) -->

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

### Desktop Development Mode

```bash
# Terminal 1: start the API server
bun dev serve

# Terminal 2: start the desktop app
bun run --cwd packages/desktop-electron dev
```

---

## Configuring AI Providers

You can use the built-in free providers, or add AI providers through the settings UI (recommended).

## Feature Details

### Built-in Skills

Aether includes 20+ Skills for research and daily scenarios that auto-trigger based on their descriptions — no manual invocation needed:

| Category | Skill | Function |
|---|---|---|
| Dev Tools | `skill-creator` | Create and optimize Agent Skills |
| | `skill-manager` | Scan, classify, and manage Skills collections |
| | `skill-security-auditor` | AI Skill security audit and vulnerability scanning |
| | `code-reviewer` | Code review (security, performance, best practices) |
| | `project-signpost` | Generate project directory navigation files |
| | `prepare-for-git-commit` | Pre-commit code checks and commit message writing |
| Academic Research | `academic-researcher` | Literature review, paper analysis, equation derivation |
| | `literature-review` | Multi-database systematic literature review |
| | `peer-review` | Peer review toolkit |
| | `write-paper` | Generate LaTeX papers from research project files |
| | `deep-research` | Multi-source synthesis and deep research |
| | `arxiv-search` | Search arXiv for preprints |
| | `read-arxiv-paper` | Read and analyze arXiv papers |
| | `research-grants` | Write research grant proposals |
| | `research-grants-ch` | Write Chinese research grant proposals (NSFC, China Postdoctoral Science Foundation, etc.) |
| | `scientific-critical-thinking` | Scientific evidence quality assessment |
| | `scientific-brainstorming` | Research hypothesis generation and interdisciplinary exploration |
| | `response-to-referee` | Point-by-point responses to reviewer comments |
| General | `brainstorming` | Turn ideas into designs before implementation |
| | `clawhub` | Search and install Agent Skills from ClawHub |
| | `docx` | Create and edit Word documents |
| | `excel-analysis` | Analyze Excel spreadsheets |
| | `ppt-generation` | Generate PowerPoint presentations |

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

Chat with Aether from your phone via WeChat, Feishu, or QQ bots. Configure credentials for the respective platforms in Settings (supported in both Web and Desktop versions).

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

**macOS says "cannot be opened because the developer cannot be verified"**: The app is unsigned. Right-click the app and select "Open", then go to "Settings → Privacy & Security", find the related message, and select "Open Anyway". The app will be remembered as trusted and won't prompt again. (This needs to be repeated after each update.)

**macOS says "is damaged and cannot be opened"**: This is a false positive caused by macOS quarantine attributes. Run `xattr -cr /Applications/Aether\ Desktop.app` (Desktop version) or `xattr -cr ./aether ./Aether.command` (Web version) in Terminal.

**Can't find the launch entry after installing the Linux Web version**: Run `install.sh` (after `chmod +x`) from the extracted directory. After installation, you'll find the Aether icon in the system application launcher. *The `Aether.sh` shortcut previously created on the desktop is now deprecated.*

**Can both Desktop and Web versions be installed at the same time?**: Yes. Both share the same data and sessions. However, you should avoid running both versions simultaneously to prevent resource conflicts and instability.
