# Aether Super-agent

English | [简体中文](README.zh-CN.md)

An opt-in research coordinator: discuss and assign work in a native Aether conversation, then track milestones, evidence and blockers in a separate research panel. The coordinator selects an existing worker session or creates a task with its own Git worktree. Workers report progress through an authenticated plugin tool; significant results return to the main conversation through a durable queue.

This directory is self-contained and excluded from the root workspace. Adding it to the repository does not enable Super-agent or change the default Aether UI. Its optional installer adds reversible source mounts; it is not a runtime UI extension API.

![Research panel with a synthetic task](docs/images/research-panel.png)

## Try it

Requires Linux/macOS, Bun 1.3.10+, Git, an Aether source checkout with dependencies installed, and a configured Aether model. The coordinator runs on the same machine as Aether. No research repository is required during setup or startup.

From this directory (or a standalone copy of it):

```sh
bun install --frozen-lockfile
bun run setup --aether http://127.0.0.1:19527
bun run install:aether --aether /absolute/path/to/Aether --config config.local.json
bun start config.local.json
```

Build/run Aether from the modified source checkout. Existing packaged binaries do not load these source changes; existing backend instances may need to reload plugin configuration. Refresh the browser after an upgrade. Open **研究工作台** (Research workspace) from the sidebar, then **打开主控会话** (Open coordinator conversation). The prototype's panel labels are currently Chinese. Settings → Super-agent provides enable/disable, scheduled check-ins (off by default), and guarded uninstall.

The default coordinator data and workspace root is `$XDG_DATA_HOME/aether/superagent` (`~/.local/share/aether/superagent` when unset). Run setup, the installer and the coordinator with the same XDG environment as Aether. Setup saves the resolved path, and existing explicit `config.state` paths remain valid.

In Settings → Super-agent → Working directory (工作目录), save an absolute server-side path or restore the default. The new root applies immediately to newly created worker worktrees and managed native sessions. Existing sessions and tasks keep their original paths, and the coordinator database and bridge stay at the original data location. Keep the workspace outside research repositories.

Model credentials stay in Aether. Use `setup --model provider/model` to choose a model, and `AETHER_AUTHORIZATION` if the backend requires Basic authentication. Never commit `config.local.json`, tokens, installation receipts or research state.

## Add a project through conversation

Tell the coordinator, for example: “Monitor `/home/user/research/project-a` and report the current calculation progress.” It passes that directory when dispatching a new task. No Git repository is created by setup, startup, ordinary chat or status checks.

On first execution, Super-agent reuses the selected directory's existing Git repository (including a containing repository or linked worktree). If no repository exists, it initializes Git there and creates an empty baseline commit. An existing repository without commits also receives an empty baseline. It never automatically stages or commits your project files or changes your Git identity settings. The directory must already exist; the agent asks for a path when the intended project is unclear.

Each task retains its source directory, repository and base commit across follow-ups and restarts. Different projects can be coordinated together. Workers still have isolated worktrees, but monitoring reads the **live source directory**, including untracked files and ongoing outputs. An empty baseline does not copy those files into a task worktree. Git initialization is not a backup or an import of research data.

The state directory must stay outside project repositories. An optional `setup --repo /path/to/project` remains available as a default; existing configurations and task worktrees remain compatible. Omitting a default does not detach old tasks from their original projects.

The panel also shows the coordinator's actual conversation status: processing, idle, not yet linked, or unavailable. A conversation without dispatch is not a research task; ordinary discussion does not manufacture progress cards. Selecting the Super-agent role in an existing native session links that conversation when its user turn starts. Filesystem investigation is routed through registered tasks, including when the coordinator session has Full permissions. Supplied attachment content may still be discussed directly. Preparation failures remain visible on the task card with their error instead of appearing as an empty workspace.

## Integration and boundaries

The installer supports `Science-Discovery/Aether dev@a0926a8260e407338a2b7f21b9e27316599bca4e`. It validates anchors before writing, copies the add-on UI and bridge, installs a plugin and two agent presets, and adds marked blocks to five source files: the sidebar, app router, layout, settings dialog and server router. It leaves provider, prompt and database implementations alone. The browser uses Aether's authenticated bridge and never receives the coordinator token.

Task trust is explicit and revocable. It grants full permission to that worker session, including operations outside its worktree; it is not an OS sandbox. Other tasks stay subject to their own approvals. Approvals are available on demand in a native dialog. Reload/reconnect synchronizes confirmed task permissions with Aether's native UI cache, avoiding transient prompts for trusted work without suppressing other permission notifications.

SQLite records dispatch intent before network calls. Unknown delivery is reconciled using message identity instead of blindly repeated. Research progress is agent-reported evidence, not scientific acceptance. A finished model turn or stopped session does not prove a background calculation finished. The optional scheduler checks existing tasks in a separate conversation and reports only meaningful updates.

The settings uninstall checks running work and managed trust first, then removes only recorded files and marked blocks. Research data and sessions remain. The CLI below only restores files: revoke task trust, disable dispatch and confirm workers are idle before using it.

```sh
bun run uninstall:aether --aether /absolute/path/to/Aether
```

Edited integration files cause a conflict rather than being overwritten. Upgrade by uninstalling the old integration and installing the new version. See the [detailed guide](README.zh-CN.md) for recovery, API and installation limits.

## Verification

Run from this directory, never the repository root:

Plugin guard tests use an Aether source checkout with dependencies installed. The in-repository checkout or a sibling `Aether` directory is detected automatically; otherwise run `AETHER_SOURCE=/absolute/path/to/Aether bun test`.

```sh
bun test
bun typecheck
bun run test:permission-cache
bun test/native-v2-e2e.ts /absolute/path/to/Aether
bun test/native-permissions-e2e.ts /absolute/path/to/Aether
```

The browser scripts require `agent-browser` and its browser, plus installed Aether dependencies. They create isolated checkouts and services, use a local deterministic model, and do not require a paid API key. Pass the Aether checkout explicitly; the legacy default expects a standalone sibling checkout. `NATIVE_E2E_CRON=1` adds two real scheduler cycles to the native-v2 check. `NATIVE_E2E_PROJECTS=1` exercises repository-free startup, on-demand Git initialization, two projects and continuation. Desktop binaries are not covered by these Web tests.

Real-model verification is opt-in: `DEEPSEEK_API_KEY=... bun test/native-live.ts /absolute/path/to/Aether`. It checks a small Python repair and a read-only CSV summary, not scientific discovery quality.
