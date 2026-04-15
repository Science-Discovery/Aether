# Aether 运行时持久化命名迁移方案

## 1. 背景

当前项目由 OpenCode fork 而来。程序内部与运行时持久化相关的目录名、文件名、应用标识仍然混杂着 `opencode`、`OpenCode`、`aether`、`Aether` 等历史命名。

如果要将项目彻底重命名为 Aether，则运行时持久化层必须同步完成命名切换。这里有两个硬约束：

1. 面向用户磁盘上的持久化路径和文件名时，统一使用全小写 `aether`。
2. 不能对用户原有的目录或文件做任何原地修改、重命名或删除。迁移只能遵循“新路径不存在时创建并从旧路径复制”的策略。

这份文档用于沉淀一套完整、稳健、可分阶段实施的持久化命名迁移方案。

## 2. 目标

本方案的目标是：

- 将新的运行时持久化根目录从 `opencode` 统一切换为 `aether`
- 将新的运行时配置文件名从 `opencode.*` 统一切换为 `aether.*`
- 保证老用户升级后数据可继续使用
- 保证迁移对旧数据只读、不破坏
- 保证首次启动失败时不会把用户状态迁移成半新半旧的分叉状态
- 将高风险迁移拆分成多个阶段，优先落地低风险、用户收益高的部分

非目标：

- 不在首阶段自动改写用户项目目录中的所有历史文件
- 不在首阶段自动迁移所有缓存、快照、日志和临时产物
- 不在首阶段静默迁移需要管理员权限的系统级目录

## 3. 当前现状

### 3.1 全局持久化根目录

`packages/opencode/src/global/index.ts` 当前将应用名硬编码为 `opencode`，再通过 `xdg-basedir` 派生：

- `data`
- `config`
- `cache`
- `state`
- `log`
- `bin`

也就是说，当前默认根目录实际是：

- `data = <XDG_DATA_HOME>/opencode`
- `config = <XDG_CONFIG_HOME>/opencode`
- `cache = <XDG_CACHE_HOME>/opencode`
- `state = <XDG_STATE_HOME>/opencode`

在未显式设置 `XDG_*` 环境变量时，默认会落到 XDG 风格目录，例如 Linux 上是：

- `~/.local/share/opencode`
- `~/.config/opencode`
- `~/.cache/opencode`
- `~/.local/state/opencode`

当前 `Global` 模块在 import 时就会立即创建这些目录，并在同一时机处理缓存版本清理。

### 3.2 当前全局持久化内容

#### `data`

主要包括：

- SQLite 数据库：`aether.db` 或 `aether-<channel>.db`（`storage/db.ts:43-45`）
- SQLite WAL 辅助文件：`*.db-wal`、`*.db-shm`
- `auth.json`（`auth/index.ts:10`）
- `mcp-auth.json`（`mcp/auth.ts:34`）
- `serve-port`（`cli/cmd/serve.ts:22`、`cli/cmd/web.ts:80`，运行时瞬时状态）
- `storage/`（`storage/storage.ts`、`storage/json-migration.ts:27`，JSON 历史数据）
- `reading-mode/`（`session/index.ts:53`、`server/routes/reading-mode.ts:22`）
- `worktree/`（`worktree/index.ts:221`）
- `snapshot/`（`snapshot/index.ts:85`）
- `tool-output/`（`tool/truncation-dir.ts:4`）
- `log/`（`global/index.ts` 中定义的日志目录）

注意：之前版本列出的 `plans/` 不在全局 data 目录下，而是在项目内的 `.opencode/plans/` 中（`session/index.ts:400`）。

其中数据库虽然已经使用 `aether*.db` 命名，但目录根仍然在 `.../opencode` 下。

#### `config`

主要包括：

- `config.json`
- `opencode.json`
- `opencode.jsonc`
- `tui.json`
- `tui.jsonc`
- `AGENTS.md`
- `agent/`
- `agents/`
- `command/`
- `commands/`
- `mode/`
- `modes/`
- `plugin/`
- `plugins/`

#### `state`

主要包括：

- `model.json`
- `kv.json`
- `prompt-history.jsonl`
- `prompt-stash.jsonl`
- `frecency.jsonl`
- `legacy-db.json`
- `legacy-db-merge.json`

#### `cache`

主要包括：

- `version`
- `models.json`
- `skills/`
- `bin/`
- `node_modules/`
- 运行时下载的 ripgrep、LSP、语言工具等

### 3.3 绕开全局根目录的特例

有一部分持久化路径并不经过 `Global.Path`，而是各模块自己按平台拼接：

#### WeChat

当前路径形态为：

- macOS: `~/Library/Application Support/opencode/wechat`
- Windows: `%APPDATA%/opencode/wechat`
- Linux: `~/.local/share/opencode/wechat`

主要文件：

- `qrcode.txt`
- `session.json`
- `pid.txt`
- `lock.json`
- `accounts.json`（存储 WeChat SDK token，在 `clearSession()` 时删除）

路径定义位置：`packages/opencode/src/wechat/manager.ts:17-26`。以上所有路径均为模块顶层 `const`，在 import 时固化，不经过 `Global.Path`。这意味着迁移层无法在 import 之前改变指向，必须将路径计算从 `const` 改为函数调用才能引入双读兼容。

#### Feishu

当前路径形态为：

- macOS: `~/Library/Application Support/opencode/feishu`
- Windows: `%APPDATA%/opencode/feishu`
- Linux: `~/.local/share/opencode/feishu`

主要文件：

- `config.json`
- `sessions.json`
- `hidden_projects.json`

路径定义位置：`packages/opencode/src/feishu/manager.ts:25-33`。与 WeChat 相同，以上所有路径均为模块顶层 `const`，不经过 `Global.Path`。

#### wechat-bridge 资源目录

当前还会额外查找（`packages/opencode/src/wechat/manager.ts:488-505`）：

1. Electron 打包资源目录：`join(resources, "wechat-bridge", target)`
2. 二进制同级目录：`join(dirname(process.execPath), "wechat-bridge", target)`
3. 用户安装目录：`join(homedir(), ".local", "share", "opencode", "wechat-bridge", target)`
4. 开发目录：`join(dir, "Aether-wechat-bridge", target)`

其中只有第 3 项属于用户侧持久化路径，需要纳入迁移范围。其余为只读的捆绑资源或开发路径，不需要迁移。

### 3.4 项目内持久化命名

项目目录内目前仍在使用旧命名：

- `.opencode`
- `.opencode-kb`
- `opencode.json`
- `opencode.jsonc`

这部分虽然也属于持久化命名的一部分，但它直接触碰用户工作区，风险明显高于用户私有目录。

#### `.opencode` 子目录结构

`.opencode` 目录内部包含多个有独立语义的子目录，需要分别处理：

| 子目录 | 用途 | 代码位置 |
|--------|------|----------|
| `plans/` | 存储用户的 plan 文件 | `session/index.ts:400`、`agent/agent.ts:135` |
| `skills/` | 技能发现与安装目标 | `config/config.ts:1373,1381,1454` |
| `agents/`、`agent/` | agent 配置 | `config/config.ts:443` |
| `commands/`、`command/` | 自定义命令 | `config/config.ts:404` |
| `modes/`、`mode/` | 模式配置 | 通过 `loadMode(dir)` 加载 |
| `plugins/`、`plugin/` | 插件加载 | 通过 `loadPlugin(dir)` 加载 |

#### 相关过滤规则

`packages/opencode/src/file/ripgrep.ts:295` 硬编码了 `if (file.includes(".opencode")) continue`，用于在 ripgrep 搜索结果中排除 `.opencode` 目录。迁移后需同时排除 `.aether`。

### 3.5 Electron 持久化命名

Electron 仍然使用 OpenCode 标识：

- `app id`: `ai.opencode.desktop*`（定义在 `packages/desktop-electron/src/main/index.ts:16-19`）
- `userData` 基于该 id（`index.ts:22`）
- `sidecar.pid`（`cli.ts:137,144`，存储在 `userData` 下）
- electron-store 文件名仍为 `opencode.settings`（`constants.ts:7`）
- Tauri 迁移产物 `opencode.global.dat`、`default.dat`（`migrate.ts:48-51`，注意 `migrate()` 调用目前在 `index.ts:120` 已被注释掉）

#### `sqliteFileExists()` 的特殊问题

`packages/desktop-electron/src/main/index.ts:375-380` 中 `sqliteFileExists()` 硬编码检查 `join(base, "opencode", file)`。此函数的唯一作用是判断是否需要显示 JSON→SQLite 迁移等待界面（`index.ts:148`）。如果只改成检查 `aether` 目录，但 sidecar 还没完成 persistence-rename 迁移，Electron 会误认为需要 JSON→SQLite 全量迁移并显示不必要的进度条。

#### Electron sidecar 的 `XDG_STATE_HOME` 覆盖

`packages/desktop-electron/src/main/cli.ts:208` 设置 `XDG_STATE_HOME: app.getPath("userData")`，这使得 sidecar 进程的 `Global.Path.state` 指向 `<userData>/opencode`（而非标准的 `~/.local/state/opencode`）。具体路径映射如下：

| 路径类型 | Web/CLI 模式 | Electron sidecar 模式 |
|---------|-------------|---------------------|
| `data` | `~/.local/share/opencode` | `~/.local/share/opencode`（不受影响） |
| `config` | `~/.config/opencode` | `~/.config/opencode`（不受影响） |
| `state` | `~/.local/state/opencode` | `<userData>/opencode`（被 `XDG_STATE_HOME` 覆盖） |
| `cache` | `~/.cache/opencode` | `~/.cache/opencode`（不受影响） |

其中 `<userData>` = `<appData>/ai.opencode.desktop[.dev|.beta]`。这意味着 Electron 模式下的 state 文件（model.json、kv.json 等）在一个完全不同的路径下，阶段一的标准 XDG 迁移不会覆盖到这些文件。

当前默认 CD 发布的是 Web 包，不是 Electron，因此 Electron 迁移可以单独分阶段处理。

## 4. 目标命名

新的命名统一如下：

### 4.1 全局根目录

- `data = <XDG_DATA_HOME>/aether`
- `config = <XDG_CONFIG_HOME>/aether`
- `cache = <XDG_CACHE_HOME>/aether`
- `state = <XDG_STATE_HOME>/aether`
- `log = <data>/log`
- `bin = <cache>/bin`

### 4.2 特例目录

- WeChat: `.../aether/wechat`
- Feishu: `.../aether/feishu`
- wechat-bridge: `.../aether/wechat-bridge`

### 4.3 项目内命名

- `.aether`
- `.aether-kb`
- `aether.json`
- `aether.jsonc`

### 4.4 Electron

- `app id`: `ai.aether.desktop*`
- `userData`: 基于新 id
- store 文件名改为 `aether.settings`、`aether.global.dat`
- sidecar state 子树从 `userData/opencode` 迁到 `userData/aether`

### 4.5 CLI 安装目录

后续可统一为：

- `~/.aether/bin/aether`

这部分不属于首阶段核心运行时持久化迁移，但应纳入总体命名收口。

## 5. 迁移原则

### 5.1 总原则

迁移必须满足以下不变量：

1. 旧路径只读，不改名，不删除，不覆盖。
2. 迁移以”逻辑资产”为单位，而不是一律整目录粗暴搬运。
3. **迁移判断一律以目标文件是否存在为准，不以目标目录是否存在为准。** 迁移前允许 `mkdir -p` 创建目标目录结构，但目录的存在不构成”已迁移”的判断依据。只有当某个目标文件本身存在时，才跳过该文件的复制。
4. 一旦某个逻辑资产已在新路径存在，则后续只使用新路径，不再双写。
5. 迁移必须可中断、可重试、可恢复。
6. 迁移必须具备跨进程互斥，避免多个实例同时复制。
7. rename 迁移与已有的 LegacyDB 合并逻辑职责正交、执行顺序明确（详见 §8）。

### 5.2 为什么不能简单全量重命名

如果直接把所有 `opencode` 路径一把改成 `aether`，会同时引入以下风险：

- 老用户升级后数据丢失，因为程序读不到旧路径
- 首次启动过程中同时创建空新目录，导致后续无法判断是否需要迁移
- 用户项目目录被静默改写
- Electron 与 Web/CLI 路径语义不一致，迁移顺序出错
- SQLite 在 WAL 模式下被不完整复制，造成库损坏或数据缺失

因此必须采用“命名抽象 + 显式迁移 + 分阶段落地”的方式。

## 6. 总体方案

### 6.1 先建立统一命名层

新增一个统一模块，例如：

- `packages/opencode/src/persist/naming.ts`

职责：

- 统一定义所有新的持久化命名常量
- 保留对应的 legacy 名称
- 禁止业务模块继续零散手写 `"opencode"`

建议常量：

```ts
export const APP = "aether"
export const LEGACY_APP = "opencode"
export const PROJECT_DIR = ".aether"
export const LEGACY_PROJECT_DIR = ".opencode"
export const KB_DIR = ".aether-kb"
export const LEGACY_KB_DIR = ".opencode-kb"
export const CFG = "aether"
export const LEGACY_CFG = "opencode"
```

### 6.2 再建立统一迁移层

新增一个迁移模块，例如：

- `packages/opencode/src/persist/migrate.ts`

职责：

- 计算新旧路径
- 加迁移锁
- 执行按资产的 copy-on-first-use
- 写入迁移 marker
- 提供调试信息

建议暴露的入口：

- `ensure_user()`
- `ensure_project()`
- `ensure_electron()`

命名可按仓库风格再收敛，但职责应保持独立。

### 6.3 将全局路径初始化改成显式流程（阻塞性前置条件）

当前 `packages/opencode/src/global/index.ts` 在 import 时就创建目录，这会让迁移时机失控。这是**阶段一的第一步**，必须首先完成，否则后续所有迁移逻辑都无法正确工作。

#### 问题根因

`global/index.ts:29-35` 是一段 top-level `await`：

```ts
await Promise.all([
  fs.mkdir(Global.Path.data, { recursive: true }),
  fs.mkdir(Global.Path.config, { recursive: true }),
  fs.mkdir(Global.Path.state, { recursive: true }),
  fs.mkdir(Global.Path.log, { recursive: true }),
  fs.mkdir(Global.Path.bin, { recursive: true }),
])
```

全仓库有 54+ 个文件直接 `import { Global } from "../global"`，且 `src/index.ts` 的静态 import 链（`import { Database } from "./storage/db"` → `import { Global } from "../global"`）在进入 `yargs.middleware()` 之前就会触发这段代码。一旦空的 `~/.local/share/aether` 被创建，迁移逻辑将无法正确判断是否需要迁移（参见 §5.1 第 3 条）。

#### 改造方案

将 `global/index.ts` 拆成两个阶段：

**阶段 A：路径常量（保持 top-level，零副作用）** — 只计算路径值，不创建目录：

```ts
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"

const app = "aether"

const data = path.join(xdgData!, app)
const cache = path.join(xdgCache!, app)
const config = path.join(xdgConfig!, app)
const state = path.join(xdgState!, app)

export namespace Global {
  export const Path = {
    get home() {
      return process.env.OPENCODE_TEST_HOME || os.homedir()
    },
    data,
    bin: path.join(cache, "bin"),
    log: path.join(data, "log"),
    cache,
    config,
    state,
  }
}
// 不再有 top-level await
```

**阶段 B：`Global.ensureDirs()` 显式函数** — 目录创建 + cache version 清理：

```ts
export namespace Global {
  // ... Path 定义 ...

  export async function ensureDirs() {
    await Promise.all([
      fs.mkdir(Path.data, { recursive: true }),
      fs.mkdir(Path.config, { recursive: true }),
      fs.mkdir(Path.state, { recursive: true }),
      fs.mkdir(Path.log, { recursive: true }),
      fs.mkdir(Path.bin, { recursive: true }),
    ])

    // cache version 清理逻辑
    const CACHE_VERSION = "21"
    const version = await Filesystem.readText(path.join(Path.cache, "version")).catch(() => "0")
    if (version !== CACHE_VERSION) {
      try {
        const contents = await fs.readdir(Path.cache)
        await Promise.all(
          contents.map((item) =>
            fs.rm(path.join(Path.cache, item), { recursive: true, force: true }),
          ),
        )
      } catch (e) {}
      await Filesystem.write(path.join(Path.cache, "version"), CACHE_VERSION)
    }
  }
}
```

#### 调用时机

在 `packages/opencode/src/index.ts` 的 yargs middleware 中，按以下顺序调用：

```
1. persist/migrate.ensureUser()   ← rename 迁移（旧目录 → 新目录）
2. Global.ensureDirs()            ← 创建新目录结构
3. LegacyDB.status() + copySource() ← 已有的 opencode*.db → aether-prod.db 合并
4. Database.Client() 初始化
```

#### 对其他文件的影响

所有其他 54 个 import Global 的文件**不需要修改** — 它们只使用 `Global.Path` 的路径常量，不依赖目录创建的副作用。

## 7. 按资产分类的迁移策略

### 7.1 首阶段自动迁移

以下内容是高价值、低争议、用户强依赖的数据，适合首次启动时自动迁移。

#### `data`

- SQLite 数据库文件
- 对应的 `-wal`、`-shm`
- `auth.json`
- `mcp-auth.json`
- `reading-mode/`
- `storage/`

#### `config`

首阶段迁移的文件：

- `config.json`（中性名字，不含 `opencode` 前缀，直接从旧目录复制到新目录即可，无需改名）
- `AGENTS.md`
- `tui.json`
- `tui.jsonc`

对于 `opencode.json*` / `aether.json*`，**不做强制复制，改为双读兼容**（与项目级配置采用相同策略）：

修改 `Config.global()`（`config/config.ts:1239-1244`），将读取顺序改为先 aether 后 opencode：

```ts
export const global = lazy(async () => {
  let result: Info = pipe(
    {},
    mergeDeep(await loadFile(path.join(Global.Path.config, "config.json"))),
    // 先读 aether.json*（新名字）
    mergeDeep(await loadFile(path.join(Global.Path.config, "aether.json"))),
    mergeDeep(await loadFile(path.join(Global.Path.config, "aether.jsonc"))),
    // 再回退读 opencode.json*（旧名字）
    mergeDeep(await loadFile(path.join(Global.Path.config, "opencode.json"))),
    mergeDeep(await loadFile(path.join(Global.Path.config, "opencode.jsonc"))),
  )
  // ...
})
```

同时修改以下位置：

- `config.ts:126`（project config）：在 `ConfigPaths.projectFiles("opencode", ...)` 之前增加 `ConfigPaths.projectFiles("aether", ...)`
- `config.ts:146`（`.opencode` 目录内）：文件扫描列表从 `["opencode.jsonc", "opencode.json"]` 改为 `["aether.jsonc", "aether.json", "opencode.jsonc", "opencode.json"]`
- `config.ts:212`（managed config 目录内）：同上
- `config.ts:1484-1492`（`globalConfigFile()` 写入时）：候选列表改为 `["aether.jsonc", "aether.json", "config.json"]`，写入时优先选 `aether.jsonc`

这样即使首次迁移中 copy 失败或用户从未迁移，旧配置文件仍可被读取。

#### `state`

- `model.json`
- `kv.json`
- `prompt-history.jsonl`
- `prompt-stash.jsonl`
- `frecency.jsonl`
- `legacy-db.json`
- `legacy-db-merge.json`

#### 特例目录

WeChat、Feishu、wechat-bridge 的路径不经过 `Global.Path`，需要单独处理。

**前置改造**：将 `wechat/manager.ts:17-26` 和 `feishu/manager.ts:25-33` 的模块顶层 `const` 路径定义改为函数调用。在 `persist/naming.ts` 中新增平台路径计算函数：

```ts
// persist/naming.ts
export function platformDataDir(sub: string): string {
  const app = "aether"
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", app, sub)
  if (process.platform === "win32")
    return join(process.env.APPDATA || homedir(), app, sub)
  return join(homedir(), ".local", "share", app, sub)
}

export function legacyPlatformDataDir(sub: string): string {
  const app = "opencode"
  // 同上结构，app 改为 "opencode"
}
```

`wechat/manager.ts` 和 `feishu/manager.ts` 中每个文件读取操作改为：先尝试新路径，不存在则回退旧路径。写操作一律写新路径。

**WeChat 迁移矩阵**（每个文件 × 3 个平台）：

| 文件 | 迁移策略 | 原因 |
|------|---------|------|
| `session.json` | copy-on-first-use | 包含用户登录态 |
| `accounts.json` | copy-on-first-use | 包含 SDK token |
| `lock.json` | **不迁移** | 运行时瞬时状态，不跨版本保留 |
| `pid.txt` | **不迁移** | 运行时瞬时状态 |
| `qrcode.txt` | **不迁移** | 运行时瞬时状态 |

**Feishu 迁移矩阵**（每个文件 × 3 个平台）：

| 文件 | 迁移策略 | 原因 |
|------|---------|------|
| `config.json` | copy-on-first-use | 包含 appId/appSecret |
| `sessions.json` | copy-on-first-use | 包含会话映射 |
| `hidden_projects.json` | copy-on-first-use | 包含用户偏好 |

**wechat-bridge**：

仅 `~/.local/share/opencode/wechat-bridge/` 属于用户侧持久化路径（`wechat/manager.ts:495`），其余搜索路径（Electron resources、二进制同级目录、开发目录）为只读，不需要迁移。对用户侧路径做 copy-on-first-use。

### 7.2 首阶段不自动迁移

以下内容不建议在首次启动时自动复制：

- `cache/`
- `log/`
- `serve-port`
- `snapshot/`
- `worktree/`
- `tool-output/`

原因：

- `cache` 可重建，而且当前逻辑本来就会按 `CACHE_VERSION` 清空
- `log` 没有保真价值
- `serve-port` 属于运行时瞬时状态（`cli/cmd/serve.ts:22`、`cli/cmd/web.ts:80`）
- `snapshot` 和 `worktree` 可能体积较大、语义复杂，不适合静默搬运
- `tool-output` 属于临时产物（`tool/truncation-dir.ts:4`）

注意：文档之前版本在 §3.2 data 条目中列出了 `plans/`，但经代码审查，全局 `data` 目录下并不存在 `plans/` 子目录。`plans/` 实际存在于项目内的 `.opencode/plans/` 中（`session/index.ts:400`），属于项目内持久化，在 §7.3 中处理。

### 7.3 项目内持久化的策略

项目目录内的 `.opencode`、`.opencode-kb`、`opencode.json*` 不建议首阶段自动整目录复制。

首阶段建议使用”双读兼容，单写新路径”：

1. 读取时优先找：
   - `.aether`
   - `.aether-kb`
   - `aether.jsonc`
   - `aether.json`
2. 若不存在，再回退读：
   - `.opencode`
   - `.opencode-kb`
   - `opencode.jsonc`
   - `opencode.json`
3. 新的写操作一律只写到新名字

这样可以保证：

- 老项目仍然可读
- 程序不会在首次启动时静默改写用户仓库
- 后续可以提供显式迁移命令，由用户自行决定是否复制项目内旧目录

#### `.opencode` / `.aether` 子目录的分类兼容策略

`.opencode` 内部的子目录有不同的语义，需要分类处理：

| 子目录 | 读取策略 | 写入策略 | 理由 |
|--------|---------|---------|------|
| `plans/` | 合并读取：同时搜索 `.aether/plans/` 和 `.opencode/plans/` | 只写 `.aether/plans/` | plans 是用户数据，文件名通常全局唯一（slug），合并不会冲突 |
| `skills/` | **只读新路径** `.aether/skills/`；首次启动时将 `.opencode/skills/` 整目录 copy 到 `.aether/skills/`（如果新目录不存在） | 只写 `.aether/skills/` | skills 包含 `node_modules` 等依赖，不适合合并读取两个目录，应一次性迁移 |
| `agents/`、`agent/` | 合并读取 | 只写 `.aether/` 下 | 与现有 `ConfigPaths.directories()` 的搜索逻辑一致 |
| `commands/`、`command/` | 合并读取 | 只写 `.aether/` 下 | 同上 |
| `modes/`、`mode/` | 合并读取 | 只写 `.aether/` 下 | 同上 |
| `plugins/`、`plugin/` | 合并读取 | 只写 `.aether/` 下 | 同上 |

#### 需要修改的代码位置

| 文件 | 行号 | 当前内容 | 改为 |
|------|------|---------|------|
| `config/paths.ts` | 32 | `targets: [“.opencode”]` | `targets: [“.aether”, “.opencode”]` |
| `config/paths.ts` | 40 | `targets: [“.opencode”]` | `targets: [“.aether”, “.opencode”]` |
| `config/paths.ts` | 47 | `targets: [“.opencode”]` | `targets: [“.aether”, “.opencode”]` |
| `config/config.ts` | 145 | `dir.endsWith(“.opencode”)` | `dir.endsWith(“.aether”) \|\| dir.endsWith(“.opencode”)` |
| `config/config.ts` | 1381 | `path.join(dir, “.opencode”, “skills”)` | `path.join(dir, “.aether”, “skills”)` |
| `config/config.ts` | 1454 | `path.join(Instance.directory, “.opencode”, “skills”)` | `path.join(Instance.directory, “.aether”, “skills”)` |
| `session/index.ts` | 400 | `path.join(Instance.worktree, “.opencode”, “plans”)` | `path.join(Instance.worktree, “.aether”, “plans”)` |
| `agent/agent.ts` | 135 | `[path.join(“.opencode”, “plans”, “*.md”)]: “allow”` | 同时包含 `.aether/plans/*.md` 和 `.opencode/plans/*.md` |
| `file/ripgrep.ts` | 295 | `if (file.includes(“.opencode”)) continue` | `if (file.includes(“.opencode”) \|\| file.includes(“.aether”)) continue` |
| `config/tui.ts` | 57 | `if (!dir.endsWith(“.opencode”) && ...)` | `if (!dir.endsWith(“.aether”) && !dir.endsWith(“.opencode”) && ...)` |
| `cli/cmd/mcp.ts` | 388 | `path.join(baseDir, “.opencode”, “opencode.json”)` 等 | 增加 `.aether` 下的候选路径 |

### 7.4 系统级托管配置

当前 `packages/opencode/src/config/config.ts:50-58` 的 `systemManagedConfigDir()` 函数硬编码返回以下路径：

- macOS: `/Library/Application Support/opencode`
- Windows: `path.join(process.env.ProgramData || "C:\\ProgramData", "opencode")`
- Linux: `/etc/opencode`

该函数的返回值赋给模块顶层 `const managedDir`（`config.ts:65`），在 `config.ts:211-214` 中用于加载 managed config 文件（`opencode.jsonc`、`opencode.json`）。

这些目录通常涉及管理员权限，不适合应用在普通首次启动中静默复制。**不做自动迁移，只做双读兼容。**

实现方案：在 `persist/naming.ts` 中新增：

```ts
export function systemManagedConfigDirs(): string[] {
  const dirs: string[] = []
  if (process.platform === "darwin") {
    dirs.push("/Library/Application Support/aether")
    dirs.push("/Library/Application Support/opencode")
  } else if (process.platform === "win32") {
    const pd = process.env.ProgramData || "C:\\ProgramData"
    dirs.push(path.join(pd, "aether"))
    dirs.push(path.join(pd, "opencode"))
  } else {
    dirs.push("/etc/aether")
    dirs.push("/etc/opencode")
  }
  return dirs
}
```

`config.ts` 中的 `systemManagedConfigDir()` 改为返回第一个存在的目录，若都不存在则默认返回新名字。`config.ts:211-214` 的文件扫描列表同时包含 `"aether.jsonc"`、`"aether.json"`、`"opencode.jsonc"`、`"opencode.json"`。

后续可单独提供管理员迁移脚本或手工迁移指引。

## 8. 数据库专项方案

数据库不能按普通文件简单处理，因为当前启用了 WAL。

### 8.1 rename 迁移与 LegacyDB 合并的职责划分

当前仓库中已存在一套完整的 legacy database 合并流程（`packages/opencode/src/storage/legacy-db.ts`），在 `src/index.ts:86-138` 的 yargs middleware 中执行。这套逻辑的作用是：将同一 data 目录下的非当前 channel 的 `.db` 文件合并到 `aether-prod.db`。

两套逻辑的职责必须正交：

| 职责 | rename 迁移 (`persist/migrate.ts`) | LegacyDB 合并 (`storage/legacy-db.ts`) |
|------|-----------------------------------|-----------------------------------------|
| 目标 | 跨目录搬迁（`opencode/` → `aether/`） | 同目录内的命名变体合并 |
| 处理的文件 | **只处理 `aether*.db` 系列**（`aether.db`、`aether-*.db`、及对应的 `-wal`、`-shm`） | 处理所有 `.db` 文件（含 `opencode*.db`） |
| 不处理的文件 | `opencode*.db`（留给 LegacyDB 处理） | — |

关键原因：
- `Database.knownPaths()`（`storage/db.ts:65-67`）用 `/^aether.*\.db$/i` 正则扫描，只匹配 `aether*` 开头的数据库。
- `LegacyDB.scan()`（`storage/legacy-db.ts:127-140`）用 `isdb()` 判断（只看 `.db` 后缀），范围更广。
- 如果 rename 迁移复制了 `opencode*.db` 到新目录，`LegacyDB.scan()` 会捕获它们但 `Database.knownPaths()` 不会，导致不一致。

执行顺序（写入 `src/index.ts` middleware）：

```
1. persist/migrate.ensureUser()     ← rename 迁移（只复制 aether*.db 系列）
2. Global.ensureDirs()              ← 确保新目录存在
3. LegacyDB.status() + copySource() ← 已有的 opencode*.db → aether-prod.db 合并
4. JsonMigration.run()              ← JSON → SQLite 迁移（如果是首次使用 SQLite）
5. Database.Client() 初始化
```

### 8.2 rename 迁移规则

1. 若新数据库已存在，则直接使用新库，不再覆盖。
2. 若新数据库不存在、旧数据库存在，则迁移旧库。
3. 优先使用 SQLite backup 语义生成新库。
4. 如果 backup 难以接入，再退化为复制：
   - `.db`
   - `.db-wal`
   - `.db-shm`
5. 复制时先落到临时路径，再原子移动到最终新路径。
6. 数据库迁移成功后再开放正常启动。
7. 若数据库迁移失败，应中止启动，而不是创建空新库继续运行。

### 8.3 注意事项

- 判断是否需要迁移时，必须以”目标数据库文件是否存在”为准（§5.1 第 3 条），不能只看新 `data` 目录是否已存在。
- rename 迁移只负责 `aether*.db` 系列文件。历史 `opencode*.db` 由 LegacyDB 流程全权负责。
- Windows 上 `.db` 文件可能被其他进程锁定，`legacy-db.ts:72-88` 的 `copy()` 函数已包含重试逻辑，rename 迁移应复用或参考此逻辑。

## 9. 迁移时机

### 9.1 Web / CLI

首次启动顺序，写入 `packages/opencode/src/index.ts` 的 yargs middleware 中：

1. 启动程序（yargs 解析命令行参数）
2. `Log.init()`（初始化日志）
3. **`persist/migrate.ensureUser()`**
   - 解析新旧路径（通过 `persist/naming.ts`）
   - 获取跨进程迁移锁
   - 检测旧 data/config/state 目录是否存在
   - 逐文件执行 copy-on-first-use（§7.1 清单 + §8.1 数据库规则）
   - 处理 WeChat/Feishu 特例目录（§7.1 迁移矩阵）
   - 写入迁移 marker
   - 释放锁
4. **`Global.ensureDirs()`**（创建新目录结构 + cache version 清理）
5. **`LegacyDB.status()` + `LegacyDB.copySource()`**（已有的 opencode*.db → aether-prod.db 合并）
6. **`JsonMigration.run()`**（JSON → SQLite 全量迁移，仅首次使用 SQLite 时触发）
7. 打开数据库（`Database.Client()`）
8. 启动服务
9. 打开 Web UI 或继续 CLI 流程

关键约束：步骤 3 和 4 的顺序**不可交换** — 如果先执行 `ensureDirs()` 创建了空的新目录，`ensureUser()` 中对每个文件的存在性检查仍然能正常工作（§5.1 第 3 条：以文件为准不以目录为准），但为了避免不必要的混淆，仍应保持 rename 迁移优先的顺序。

### 9.2 Electron

Electron 的迁移应早于以下动作：

- 初始化 electron-store
- 生成 sidecar 配置
- 启动 sidecar
- 检查 sqlite 是否已存在

建议顺序：

1. 解析新旧 `userData`
2. 若新 `userData` 不存在且旧存在，则复制到新目录
3. 若新 store 文件名缺失而旧 store 名存在，则复制旧 store 到新 store 名
4. 复制 `<oldUserData>/opencode` 到 `<newUserData>/aether`（注意：此处的 `state` 目录因 `XDG_STATE_HOME` 覆盖而位于 `<userData>` 下，详见 §3.5）
5. 完成后再初始化 Electron 主进程其余逻辑

#### `sqliteFileExists()` 的即时修复

`packages/desktop-electron/src/main/index.ts:375-380` 中的 `sqliteFileExists()` 需要**在阶段一就修改**（不等阶段三），因为阶段一完成后 sidecar 的 data 目录已经迁移到 `aether/` 下，但 Electron 主进程仍在检查 `opencode/` 下的数据库：

```ts
// 修改前（index.ts:375-380）
function sqliteFileExists() {
  const file = CHANNEL === "beta" ? "aether.db" : `aether-${CHANNEL}.db`
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return existsSync(join(base, "opencode", file))
}

// 修改后：同时检查新旧两个路径
function sqliteFileExists() {
  const file = CHANNEL === "beta" ? "aether.db" : `aether-${CHANNEL}.db`
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return existsSync(join(base, "aether", file)) || existsSync(join(base, "opencode", file))
}
```

此函数的唯一作用是判断是否需要显示 JSON→SQLite 迁移进度条（`index.ts:148`）。只要任一位置存在数据库，就不需要全量迁移。

#### Electron sidecar 的 state 目录特殊处理

阶段三处理 Electron 时，需要额外关注 sidecar 模式下 state 目录的迁移。因为 `cli.ts:208` 设置 `XDG_STATE_HOME: app.getPath("userData")`，sidecar 的 `Global.Path.state` 实际指向 `<userData>/opencode`（当前）→ `<userData>/aether`（迁移后）。

此路径下包含的 state 文件（model.json、kv.json、prompt-history.jsonl 等）与标准 XDG 路径下的 state 文件是**同一批文件的不同副本**。阶段一的 `ensureUser()` 只迁移标准 XDG 路径下的副本；阶段三需要额外迁移 `<userData>/opencode/` → `<userData>/aether/` 下的 state 文件。

## 10. 迁移锁与状态记录

### 10.1 迁移锁

不能只依赖进程内锁。应使用跨进程锁，例如：

- 独占创建锁目录
- 独占创建锁文件

推荐在新根目录同级或内部维护：

- `.migrate.lock`

该锁用于防止：

- 用户双击两次应用
- 自动重启与手动启动重叠
- Electron 与 sidecar 在错误时序下重复触发迁移

### 10.2 迁移 marker

迁移完成后应在新路径写入 marker，例如：

- `migration-v1.json`

建议记录：

- 迁移时间
- 迁移版本
- 来源根目录
- 已复制的资产列表
- 跳过项
- 失败项

marker 的作用：

- 支持调试
- 支持幂等重试
- 支持未来版本继续演进迁移逻辑

## 11. 首次启动时用户会发生什么

### 11.1 全新用户

若用户从未使用过旧版 OpenCode：

- 程序检测不到旧 `opencode` 数据
- 只创建新的 `aether` 目录树
- 初始化数据库和配置
- 正常进入界面

用户感知：

- 第一次启动略慢
- 没有迁移动作
- 之后持续使用 `aether` 新路径

### 11.2 旧用户升级

若用户本机已存在旧版 OpenCode 数据：

- 程序在首次启动时先进行一次静默迁移
- 只要新目标文件不存在，就从旧路径复制
- 旧文件和旧目录保持不变
- 迁移完成后开始使用新路径

用户感知：

- 第一次启动比平时慢
- 账号状态、数据库、偏好设置、历史记录等应保留
- 第二次启动恢复正常速度

### 11.3 中断恢复

如果首次迁移过程中异常退出：

- 已存在的新文件不回滚、不覆盖
- 缺失的资产在下次启动继续补迁
- 只有关键资产全部就绪后，才写最终完成标记

这能避免迁移半途失败后进入不可恢复的双写分叉状态。

## 12. 分阶段实施建议

### 阶段一：命名层与全局用户目录迁移

目标：

- 引入统一命名模块
- 引入统一迁移模块
- 将全局 `data/config/state` 的关键用户数据迁到 `aether`
- 处理 WeChat / Feishu 特例目录

不做：

- project-local 自动复制
- Electron `userData` 全量迁移
- CLI 安装目录切换

### 阶段二：项目内持久化兼容与显式迁移

目标：

- 全面支持 `.aether` / `aether.json*`
- 保留 `.opencode` / `opencode.json*` 双读兼容
- 提供显式迁移命令，例如：
  - `aether migrate persistence --project --dry-run`
  - `aether migrate persistence --project --apply`

### 阶段三：Electron 与桌面侧迁移

目标：

- Electron `app id` 改为 `ai.aether.desktop*`
- `userData`、store 文件名、sidecar state 子树迁移
- 收口桌面侧 legacy 探测逻辑

### 阶段四：CLI 安装路径与剩余命名收口

目标：

- CLI 安装目录切换为 `~/.aether/bin/aether`
- 安装器与探测逻辑同时兼容新旧路径
- 逐步清理剩余 `opencode` 的持久化命名引用

## 13. 实施清单

### `packages/opencode`（阶段一）

#### 新增模块

- 引入 `persist/naming.ts`：统一命名常量 + `platformDataDir()` / `legacyPlatformDataDir()` / `systemManagedConfigDirs()`
- 引入 `persist/migrate.ts`：`ensureUser()` 入口 + 文件级 copy-on-first-use + 迁移锁 + marker

#### `global/index.ts` 改造（阻塞性前置条件，详见 §6.3）

- 移除 top-level `await Promise.all([fs.mkdir(...)])` 和 cache version 逻辑
- 将 `const app = "opencode"` 改为 `const app = "aether"`
- 新增 `Global.ensureDirs()` 显式函数
- 确保 `Global.Path` 属性仍为 top-level 常量（零副作用）

#### `index.ts` middleware 改造（详见 §9.1）

- 在 `LegacyDB.status()` 之前插入 `persist/migrate.ensureUser()` 调用
- 在 `ensureUser()` 之后插入 `Global.ensureDirs()` 调用

#### config 模块改造（详见 §7.1 config、§7.3、§7.4）

- `config/config.ts:126`：`ConfigPaths.projectFiles("opencode", ...)` 之前增加 `ConfigPaths.projectFiles("aether", ...)`
- `config/config.ts:145`：`dir.endsWith(".opencode")` → `dir.endsWith(".aether") || dir.endsWith(".opencode")`
- `config/config.ts:146`：文件扫描列表增加 `"aether.jsonc"`, `"aether.json"`
- `config/config.ts:212`：managed config 文件扫描列表增加 `"aether.jsonc"`, `"aether.json"`
- `config/config.ts:1239-1244`：`Config.global()` 读取顺序改为先 aether 后 opencode
- `config/config.ts:1484-1492`：`globalConfigFile()` 候选列表改为 `["aether.jsonc", "aether.json", "config.json"]`
- `config/config.ts:50-65`：`systemManagedConfigDir()` 改为调用 `persist/naming.ts` 的 `systemManagedConfigDirs()`
- `config/paths.ts:32,40,47`：`targets: [".opencode"]` → `targets: [".aether", ".opencode"]`
- `config/tui.ts:57`：`dir.endsWith(".opencode")` → `dir.endsWith(".aether") || dir.endsWith(".opencode")`
- `config/config.ts:1381,1454`：skills 路径从 `.opencode` 改为 `.aether`

#### knowledge 模块

- `knowledge/storage.ts:8`：`KB_FOLDER` 从 `".opencode-kb"` 改为 `".aether-kb"`，但读取时增加对 `".opencode-kb"` 的回退

#### session / agent 模块

- `session/index.ts:400`：plans 目录从 `.opencode/plans` 改为 `.aether/plans`
- `agent/agent.ts:135`：权限规则同时包含 `.aether/plans/*.md` 和 `.opencode/plans/*.md`

#### 文件搜索过滤

- `file/ripgrep.ts:295`：`file.includes(".opencode")` → `file.includes(".opencode") || file.includes(".aether")`

#### WeChat / Feishu / wechat-bridge（详见 §7.1 特例目录）

- `wechat/manager.ts:17-26`：将模块顶层 `const WECHAT_DATA_DIR` 改为函数调用，使用 `persist/naming.ts` 的 `platformDataDir("wechat")`
- `wechat/manager.ts` 中所有文件读取操作：先尝试新路径，不存在则回退旧路径
- `wechat/manager.ts:495`：wechat-bridge 用户侧路径从 `opencode` 改为 `aether`
- `feishu/manager.ts:25-33`：同 wechat，改为函数调用
- `feishu/manager.ts` 中所有文件读取操作：同 wechat

#### MCP 模块

- `cli/cmd/mcp.ts:388`：增加 `.aether` 下的候选配置路径

#### uninstall 命令（只清理 aether，不触碰 opencode）

- `cli/cmd/uninstall.ts:218`：`binDir.includes(".opencode")` → `binDir.includes(".aether")`
- `cli/cmd/uninstall.ts:269,287,294,300`：shell config 清理中的 `".opencode/bin"` → `".aether/bin"`，`"# opencode"` → `"# aether"`
- 不需要额外清理 `opencode` 路径 — uninstall 只负责 Aether 自身的数据

#### 调试命令

- 扩展 `debug paths` 或新增调试命令，输出：
  - 当前解析到的新路径
  - 检测到的旧路径
  - 迁移 marker
  - 迁移状态

### `packages/desktop-electron`（阶段一即时修复 + 阶段三全量迁移）

#### 阶段一即时修复

- `src/main/index.ts:375-380`：`sqliteFileExists()` 同时检查 `aether` 和 `opencode` 两个目录（详见 §9.2）

#### 阶段三全量迁移

- `src/main/index.ts:11-19`：修改 `APP_NAMES` / `APP_IDS`
- `src/main/index.ts:22`：修改 `userData` 路径
- `src/main/constants.ts:7`：`SETTINGS_STORE` 从 `"opencode.settings"` 改为 `"aether.settings"`
- `src/main/cli.ts:14-15`：`CLI_INSTALL_DIR` 从 `".opencode/bin"` 改为 `".aether/bin"`，`CLI_BINARY_NAME` 从 `"opencode"` 改为 `"aether"`
- `src/main/cli.ts:59-60`：sidecar 二进制名从 `opencode-cli` 改为对应新名字
- `src/main/cli.ts:296`：WSL 安装脚本中的 `.opencode/bin/opencode` 改为 `.aether/bin/aether`
- 在 store 初始化前执行 Electron 专项迁移（`<userData>/opencode` → `<userData>/aether`）

### 不在本方案范围内

- `.well-known/opencode` 远程配置端点：属于协议层命名，涉及已部署的远程服务端。改名需要服务端先同时支持 `.well-known/aether` 和 `.well-known/opencode`，客户端再优先 fetch 新端点。应在独立的 API 迁移计划中处理。代码位置备忘：`config/config.ts:95-96`、`cli/cmd/providers.ts:281`。
- `OPENCODE_*` 环境变量名：40+ 个环境变量（`flag/flag.ts:14-76`）是否改为 `AETHER_*` 需要单独决策。
- `opencode://` 协议（deep link）：涉及操作系统注册和已分发的 URL（`desktop-electron/src/main/index.ts:90,121`），不能简单改名。

## 14. 测试要求

必须补充自动化测试，至少覆盖：

1. 旧路径存在，新路径不存在
2. 新旧路径都存在
3. 旧路径不存在
4. 迁移过程并发启动
5. 数据库包含 `-wal`、`-shm`
6. WeChat / Feishu 平台特例路径
7. `aether.json*` 与 `opencode.json*` 的优先级
8. `.aether` 与 `.opencode` 的优先级
9. Electron `userData` 与 store 文件迁移
10. 首次启动中断后的恢复

测试原则：

- 尽量不用 mock
- 尽量验证真实文件系统行为
- 从包目录运行测试，不从仓库根目录运行

## 15. 风险与结论

这次命名迁移的真正难点，不是把字符串 `opencode` 批量替换成 `aether`，而是要保证：

- 老用户数据不丢
- 首次启动行为可预测
- 失败后可恢复
- 用户项目目录不被静默改坏
- Electron 与 Web/CLI 不互相踩状态

因此，最稳健的做法不是单个 PR 一次性“全量重命名”，而是：

1. 先建立统一命名层和统一迁移层
2. 先迁全局用户私有目录
3. 再处理项目内路径
4. 最后处理 Electron 和 CLI 安装路径

按这个顺序实施，能够在最小风险下完成 Aether 与 OpenCode 的运行时持久化脱钩。
