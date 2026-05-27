# Aether Desktop Persistence Plan

跨平台对齐 Aether Desktop 与 Web/CLI 持久化目录的总体方案。覆盖 Windows / macOS / Linux 三平台。

## 背景与决策

- Aether Desktop（Electron 版）尚未对外发布过；不存在历史 Electron 用户，因此无需为旧 Electron 数据目录做迁移。
- Aether Web/CLI 已有大量在用用户，Web/CLI 的持久化路径必须视为"已锁定"，Desktop 端必须无副作用地对齐到它，绝不能反向修改 Web/CLI 行为。
- Web/CLI 通过 `xdg-basedir` + 应用名 `aether` 解析持久化目录，三平台默认值如下（节选自 `packages/opencode/src/persist/naming.ts` 与 `node_modules/.bun/xdg-basedir@5.1.0/.../index.js`）：

```text
data   -> $XDG_DATA_HOME   ?? <home>/.local/share         + /aether
config -> $XDG_CONFIG_HOME ?? <home>/.config              + /aether
cache  -> $XDG_CACHE_HOME  ?? <home>/.cache               + /aether
state  -> $XDG_STATE_HOME  ?? <home>/.local/state         + /aether
log    -> data/log
```

`xdg-basedir@5.1.0` 在 Windows 上不读 `%APPDATA%` / `%LOCALAPPDATA%`，只走 `os.homedir() + .local/share` 等。因此**三平台下 Web/CLI 的默认数据根都是 `<home>/.local/share/aether`**。

Desktop 端的指导原则：

```text
Web/CLI 的 Aether 用户数据根（aetherDataDir）就是真理。
Aether Desktop 在三平台上都无条件对齐到它。
Desktop 私有数据放在 aetherDataDir/desktop 子目录内，避免与 Web/CLI 文件冲突。
```

## 三平台统一目标布局

```text
<home>/.local/share/aether/                        # 由 Web/CLI 与 Desktop 共享
  aether.db                                        # Web/CLI 拥有
  auth.json                                        # Web/CLI 拥有
  mcp-auth.json                                    # Web/CLI 拥有
  storage/ reading-mode/ latest/ cron/ worktree/   # Web/CLI 拥有
  log/                                             # Web/CLI 拥有
  aether.global.dat                                # Electron UI 全局 store（共享）
  aether.settings                                  # Electron UI（共享，跨入口）
  default.dat                                      # Electron UI（共享，跨入口）
  aether.workspace.*.dat                           # Electron UI（共享，跨入口）
  desktop/                                         # Electron 私有
    sidecar.pid
    window-state.json
    logs/
    （未来还可能放其它 Electron 进程级状态）

<home>/.config/aether/                             # Web/CLI 拥有
  config.json
  aether.jsonc
  AGENTS.md
  update-config.jsonc

<home>/.cache/aether/                              # Web/CLI 拥有
  bin/
  models.json
  skills/

<home>/.local/state/aether/                        # Web/CLI 拥有
  model.json
  kv.json
  prompt-history.jsonl
  prompt-stash.jsonl
  frecency.jsonl
  migration-v1.json
```

**禁止使用的目录**（任何平台、任何场景）：

```text
Windows:
  %APPDATA%\ai.aether.desktop
  %APPDATA%\Aether Desktop
  %LOCALAPPDATA%\aether
  %LOCALAPPDATA%\Aether Desktop

macOS:
  ~/Library/Application Support/ai.aether.desktop
  ~/Library/Application Support/Aether Desktop

Linux:
  ~/.config/Aether Desktop          # electron 默认 userData
  ~/.config/ai.aether.desktop
```

这些 Electron 默认目录绝不持有 Aether Desktop 任何长期数据。

## Shared vs Desktop-Private 划分

**Shared（与 Web/CLI 共享，放在 aetherDataDir 根）**：

- 后端 DB（`aether.db` 及其 `-wal` / `-shm`）
- `auth.json`、`mcp-auth.json`
- `storage/`、`reading-mode/`、`latest/`、`cron/`、`worktree/`、`log/`
- 跨入口的 Electron UI store：`aether.global.dat`、`aether.settings`、`default.dat`、`aether.workspace.*.dat`

**Desktop-Private（仍在共享数据根下，但放进 `desktop/` 子目录）**：

```text
<aetherDataDir>/desktop/
  sidecar.pid
  window-state.json
  logs/
```

这些文件绑定到 Electron 进程 / 窗口生命周期，与 Web 服务无关，因此隔到子目录，避免触发 Web 端工具的扫描或误清理逻辑。

## 跨平台代码改动清单（P1–P7）

下列改动**三平台同步生效**，不再为 macOS / Linux 单独保留旧行为。

### P1：`paths.ts` 重写 `aetherDataDir()`

去掉 `process.platform` 分支，统一返回 `xdgData / aether`，与 Web/CLI 完全一致（同样尊重 `XDG_DATA_HOME`）：

```ts
function home() {
  return process.env.OPENCODE_TEST_HOME || app.getPath("home")
}

export function aetherDataDir() {
  const root = process.env.XDG_DATA_HOME || join(home(), ".local", "share")
  return join(root, "aether")
}
```

**关键点**：不再调用 `app.getPath("appData")` 或读取 `%LOCALAPPDATA%`，三平台都走 XDG 默认值。

### P2：`paths.ts` 重写 `userDataDir()`

三平台都派生自 `aetherDataDir()`，不再使用 Electron 默认 appData：

```ts
export function userDataDir() {
  return join(aetherDataDir(), "desktop")
}
```

`paths.ts` 模块末尾仍调用 `app.setPath("userData", userDataDir())`，使得后续 `app.getPath("userData")`、`electron-store` 默认目录、日志默认目录都自动指向 `aetherDataDir()/desktop`。

### P3：`store.ts` 用统一的 cwd 路由

无平台分支：

```ts
const cwd = nextName === GLOBAL_STORE_NAME ? aetherDataDir() : userDataDir()
```

即：

- `aether.global.dat`、`aether.settings`、`default.dat`、`aether.workspace.*.dat` → `aetherDataDir()`（共享）
- 其它 store → `userDataDir()` = `aetherDataDir()/desktop`（Electron 私有）

注意：现有 `persist-names.ts::storeName()` 会把 `aether.settings`、`default.dat`、`aether.workspace.*.dat` 都视作 Global-Like 命名（参见 `aether.global.dat` 的分支判定），P3 的实施需要复核 `store.ts` 中 GLOBAL_LIKE 判定的实际名单：默认行为应保证上文 "Shared" 列表中所有 store 都落到 `aetherDataDir()`。

### P4：`cli.ts` 在 `spawnCommand` 内向 sidecar 注入 XDG 默认值

三平台统一，**仅当用户未显式设置时**才填默认值，确保从 GUI（Dock / Start Menu / .desktop）启动 Electron 时 sidecar 看到的 XDG 与 Web/CLI 完全一致：

```ts
const xdgDefaults = {
  XDG_DATA_HOME:   process.env.XDG_DATA_HOME   ?? join(home(), ".local", "share"),
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(home(), ".config"),
  XDG_CACHE_HOME:  process.env.XDG_CACHE_HOME  ?? join(home(), ".cache"),
  XDG_STATE_HOME:  process.env.XDG_STATE_HOME  ?? join(home(), ".local", "state"),
}
```

**为什么三平台都要注入**：

- Windows：`xdg-basedir` 在 Windows 默认就用 `os.homedir() + .local/share`，但显式注入能防止用户在 PowerShell 配置文件里改了 XDG 后两端不一致。
- macOS：从 Finder/Dock 启动的 Electron 不继承用户 shell 环境（`.zshrc`/`.bash_profile`），如果用户在 shell 里改了 `XDG_DATA_HOME`，CLI 直连和 Desktop sidecar 会看到不同的 XDG，导致 Web/CLI 与 Desktop 数据分裂。
- Linux：从 `.desktop` 启动同理。

**注入位置**：放在 `spawnCommand` 的 `envs` 组装处，在 `OPENCODE_EXPERIMENTAL_*` 等环境变量旁边，但要在 `...extraEnv` 之前（不要覆盖更高优先级的覆写）。

`buildCommand` 的 WSL 分支需要单独处理：WSL 是独立的 Linux 用户环境，**不**注入 Windows 的 XDG 默认；WSL 内 sidecar 自然走 WSL 的 `$HOME/.local/share/aether`。WSL 模式按"独立 Linux 环境"处理，不承诺与 Windows Web/CLI 数据共享。

### P5：`persist.ts` 移除 legacy 扫描

`ensureDesktopPersist()`、`storeSources()`、`pidFiles()` 三平台都不再读 `legacyUserDataDir()`：

```ts
export function ensureDesktopPersist() {
  if (ready) return
  mkdirSync(userDataDir(), { recursive: true })
  ready = true
}

function storeSources(name: string) {
  const cur = userDataDir()
  const aether = aetherDataDir()
  const next = storeName(name)
  const prev = legacyStoreName(name)
  const cwd = next === "aether.global.dat" ? aether : cur
  return [
    join(cwd, next),
    ...(prev ? [join(cwd, prev)] : []),
  ]
}

export function pidFiles() {
  return [join(userDataDir(), "sidecar.pid")]
}
```

`ensureDefault()` 调用整体删除（其源是 legacy Tauri 的 `default.dat`，Electron 未发布则不存在）。

保留的 fallback：`storeSources()` 中 `legacyStoreName(name)`（处理 `opencode.*.dat → aether.*.dat` 命名迁移）—— 这是 Web/CLI 用户在 store 命名上的兼容路径，**不是** Electron 用户数据迁移，必须保留。

### P6：删除 `paths.ts` 中 `LEGACY_APP_IDS` 与 `legacyUserDataDir()`

`LEGACY_APP_IDS` 与 `legacyUserDataDir()` 在 P5 之后没有任何调用方，整体删除以避免后续误用。`persist-names.ts` 的 `LEGACY_APP = "opencode"` 与 `legacyStoreName()` 保留不动（与 Web/CLI 用户的 store 命名迁移有关）。

### P7：禁用 `migrate.ts` 在三平台的调用

`packages/desktop-electron/src/main/migrate.ts` 是当年 Tauri 时代的迁移代码，扫描 `%APPDATA%\ai.opencode.desktop`、macOS `~/Library/Application Support/ai.opencode.desktop`、Linux `~/.config/ai.opencode.desktop` 等路径。Electron 未发布过，这些路径里不会有数据。

`src/main/index.ts:106` 当前已经注释掉了 `// migrate()` 的调用，本计划只是把这一行删除并把 `migrate.ts` 整文件标记为 "removed"（或保留为 dead code 但带 README 说明）。**绝不再次启用**。

## 不做的事

- **不**迁移任何 `~/Library/Application Support/ai.aether.desktop*`、`%APPDATA%\ai.aether.desktop*`、`%LOCALAPPDATA%\aether*` 数据 —— Electron 未发布过，这些目录不会出现。
- **不**扫描 `ai.opencode.desktop*` 或任何上游 OpenCode 的 Electron / Tauri 历史目录。
- **不**修改 `packages/opencode/src/persist/naming.ts`、`packages/opencode/src/global/index.ts` 与 `xdg-basedir` 的解析逻辑 —— Web/CLI 用户的数据路径保持完全不变。
- **不**修改 `persist-names.ts` 中 `LEGACY_APP = "opencode"` 与 `legacyStoreName()` 命名迁移 —— 这是 Web/CLI 用户从老 `opencode.*.dat` 升级到 `aether.*.dat` 的兼容路径，删除会导致数据丢失。

## WSL 模式

Windows WSL 模式运行在独立的 Linux 用户环境，无法天然共享 Windows 端 Web 数据目录：

```text
WSL $HOME/.opencode/bin/opencode      # CLI 安装路径（暂保留 opencode 命名，与 sidecar 重命名一起处理）
WSL $HOME/.local/share/aether         # WSL Linux 端数据根
```

策略：

- WSL 模式按"独立 Linux 环境"处理。
- Electron 不向 WSL 内 sidecar 注入 Windows 的 XDG 默认值（保持 P4 的 WSL 分支跳过）。
- 后续 UI 文案需明确告诉用户："WSL 模式使用 WSL 内的独立数据，与 Windows 上的 Aether Web 数据**不**共享。"

## 验证清单

完成 P1–P7 后必须在三平台分别人工/CI 验证：

- [ ] Windows 全新 .deb / NSIS 安装后启动 Aether Desktop，确认数据写入 `%USERPROFILE%\.local\share\aether\`（含 `aether.db`、`aether.global.dat`、`desktop/sidecar.pid`）。
- [ ] Windows 用户已先用 Web CLI 跑过、再装 Desktop，确认 Desktop 直接读取已存在的 `aether.db`、`auth.json`、`mcp-auth.json`，不创建新副本。
- [ ] macOS 全新 DMG 安装后启动，确认数据落在 `~/.local/share/aether/`，**不**在 `~/Library/Application Support/` 下任何 `ai.aether.desktop*` 目录。
- [ ] macOS 用户已先用 Web CLI 跑过、再装 Desktop，确认共享数据库与 auth。
- [ ] Linux 全新 .deb 安装后启动，确认数据落在 `~/.local/share/aether/`，**不**在 `~/.config/Aether Desktop/` 下。
- [ ] Linux 用户已先用 Web CLI 跑过、再装 Desktop，确认共享数据库与 auth。
- [ ] `sidecar.pid`、`window-state.json` 三平台都落在 `<aetherDataDir>/desktop/`。
- [ ] 从 Dock（macOS）/`.desktop`（Linux）/桌面快捷方式（Windows）启动 Electron，sidecar 看到的 `XDG_DATA_HOME` 等环境变量与用户在 shell 里运行 `aether` CLI 时一致。
