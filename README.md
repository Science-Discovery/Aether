<h1 align="center">Aether</h1>
<p align="center"><em>Autonomous Engine for Theoretical & Hands-on Exploration in Research</em></p>
<p align="center">An AI researching assistant for researchers, tailored for research-heavy workflows.</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## Overview

Aether is a research-focused AI assistant for terminal, browser, and desktop workflows. Key strengths include:

- **Ready to use**: Download and double-click to launch — no dev environment setup required; built-in default model settings so you can start immediately
- **Built-in research Skills**: Pre-configured prompts for literature review, experiment logging, paper writing, and more — no manual prompt engineering needed
- **PDF viewing**: Open PDF files directly in the Web UI for easy side-by-side reading while coding
- **Provider-agnostic**: Works with Gemini, Claude, OpenAI, local models, or any private API
- **Full coding capabilities**: Code execution, LSP code intelligence, and file/terminal operations — on par with a VS Code daily workflow
- **Client/server architecture**: CLI runs a built-in HTTP server accessible from a browser or mobile device

---

## Running from a Release Package

Download the archive for your platform from the [Releases page](https://github.com/Science-Discovery/Aether/releases) and extract it.

### Web Browser Version (Recommended)

Extracted directory layout:

```
aether          ← CLI binary (aether.exe on Windows)
web/            ← Frontend static assets (must stay alongside the binary)
Aether.vbs      ← Windows launcher
Aether.command  ← macOS launcher
```

**Windows:** Double-click `Aether.vbs` (if it errors, run `Aether.exe` first) — browser opens automatically, no console window.

**macOS:** Double-click `Aether.command`, or run in terminal:

```bash
chmod +x aether   # first time only
./aether web
```

**Linux:**

```bash
chmod +x aether   # first time only
./aether web
```

If the browser doesn't open automatically, visit the URL shown in the terminal. Press `Ctrl+C` to stop.

### Electron Desktop Version

Extract (or install) and double-click to run:

| Platform | File                                                          |
| -------- | ------------------------------------------------------------- |
| Linux    | `aether-linux-x64.AppImage` / `.deb` / `.rpm`                 |
| macOS    | `aether-mac-arm64.dmg` (Apple Silicon) / `aether-mac-x64.dmg` |
| Windows  | `aether-win-x64.exe` installer / `win-unpacked/` portable     |

---

## Running from Source

**Requires:** [Bun](https://bun.sh/) 1.3+

```bash
bun install
```

### TUI Mode

```bash
# Run from the packages/opencode directory
bun dev

# Run from the repo root
bun dev .

# Run against a specific project directory
# (recommended: open the target folder in a new window first, then run this command)
bun dev <path>
```

Two built-in agents, switch with `Tab`:

- **build**: Default mode with full permissions, for active development
- **plan**: Read-only mode for code analysis and planning

### Web Browser Mode

Requires two terminals:

```bash
# Terminal 1: start the API server
bun dev serve

# Terminal 2: start the frontend
bun run --cwd packages/app dev
```

Then open the `http://localhost:xxxx` URL shown in terminal 2.

### Custom API Configuration

Create `~/.opencode.json` (example using a private Claude-compatible endpoint):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "my-claude": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://your-ip/v1",
        "apiKey": "sk-your-key"
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

> **Note:** `baseURL` must end with `/v1`.

On WSL, explicitly set the config path:

```bash
echo 'export OPENCODE_CONFIG="$HOME/.opencode.json"' >> ~/.bashrc
source ~/.bashrc
```

Verify: `aether models` should list your custom models.

See [DEBUG.md](DEBUG.md) for the full development guide.

---

## Troubleshooting

**API returns 404:** Check that `baseURL` ends with `/v1`.

**API returns 429:** Wrong key, or overridden by a stale `auth.json` — delete `~/.local/share/opencode/auth.json` and retry.

**Browser doesn't open automatically:** Visit the URL shown in the terminal manually (requires `xdg-open`).

**Frontend assets not found:** Ensure the `aether` binary and `web/` directory are in the same folder.
