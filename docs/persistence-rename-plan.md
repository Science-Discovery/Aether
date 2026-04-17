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
3. JsonMigration.run()            ← 首次 SQLite 迁移（仅当前目标库不存在时）
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

### 8.1 rename 迁移与 legacy db seed 的职责划分

当前工作区中，数据库启动期迁移已经收口为 `persist/migrate.ensureUser()` 内的两条互斥分支：

| 分支 | 目标 | 处理的文件 | 不处理的文件 |
|------|------|------------|--------------|
| `copyDb()` | 跨目录搬迁（`opencode/` → `aether/`） | **只处理 `aether*.db` 系列**（`aether.db`、`aether-*.db`、及对应的 `-wal`、`-shm`） | `opencode*.db` |
| `seedDb()` | 为“只有 `opencode*.db` 的旧用户”在新目录生成目标库 | 从旧目录只读扫描 `opencode*.db`，按旧 `LegacyDB.copySource()` 的“最新库优先”语义选源，直接生成新目录中的目标库（默认 `aether-prod.db`） | 不把任何 `opencode*.db` 原名复制到新目录 |

关键原因：
- `Database.knownPaths()`（`storage/db.ts:65-67`）只扫描 `aether*` 开头的数据库。
- 如果把 `opencode*.db` 复制到新目录，会重新引入“`LegacyDB` 看得到、`Database.knownPaths()` 看不到”的不一致。
- 对于旧目录里已经存在 `aether*.db` 的用户，应只复制这些已经完成命名迁移的数据库，不再理会残留的 `opencode*.db`。

执行顺序（写入 `src/index.ts` middleware）：

```
1. persist/migrate.ensureUser() ← 启动期数据库迁移
   - 旧目录有 `aether*.db`：只复制这些库到新目录
   - 旧目录没有 `aether*.db`：只读扫描 `opencode*.db`，直接在新目录 seed 目标库
2. Global.ensureDirs()         ← 确保新目录存在
3. JsonMigration.run()         ← JSON → SQLite 迁移（如果当前目标库仍不存在）
4. Database.Client() 初始化
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
- rename 迁移只负责 `aether*.db` 系列文件；旧命名 `opencode*.db` 仅在 `seedDb()` 中被只读扫描并作为数据源使用。
- Windows 上 `.db` 文件可能被其他进程锁定，`legacy-db.ts:72-88` 的 `copy()` 函数已包含重试逻辑，rename 迁移应复用或参考此逻辑。
- 严禁在旧目录中补写 `aether-prod.db`、重命名旧库或删除旧库；旧目录必须保持只读。

## 9. 迁移时机

### 9.1 Web / CLI

首次启动顺序，写入 `packages/opencode/src/index.ts` 的 yargs middleware 中：

1. 启动程序（yargs 解析命令行参数）
2. **`persist/migrate.ensureUser()`**
   - 解析新旧路径（通过 `persist/naming.ts`）
   - 获取跨进程迁移锁
   - 检测旧 data/config/state 目录是否存在
   - 逐文件执行 copy-on-first-use（§7.1 清单 + §8.1 数据库规则）
   - 若旧目录已存在 `aether*.db`，只复制这些数据库
   - 若旧目录仅有 `opencode*.db`，则只读选源并直接在新目录生成目标库
   - 处理 WeChat/Feishu 特例目录（§7.1 迁移矩阵）
   - 写入迁移 marker
   - 释放锁
3. **`Global.ensureDirs()`**（创建新目录结构 + cache version 清理）
4. **`Log.init()`**（初始化日志）
5. **`JsonMigration.run()`**（JSON → SQLite 全量迁移，仅首次使用 SQLite 且当前目标库仍缺失时触发）
6. 打开数据库（`Database.Client()`）
7. 启动服务
8. 打开 Web UI 或继续 CLI 流程

关键约束：步骤 2 和 3 的顺序**不可交换** — 如果先执行 `ensureDirs()` 创建了空的新目录，`ensureUser()` 中对每个文件的存在性检查仍然能正常工作（§5.1 第 3 条：以文件为准不以目录为准），但为了避免不必要的混淆，仍应保持 rename 迁移优先的顺序。

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

## 16. 进度更新（截至 2026-04-17）

本节用于补充记录当前代码实际已经落地的内容，以及与上文原定方案之间的偏差。为避免覆盖原计划，本节只做增量说明。

说明：

- “已合入远端”指当前 `origin/refactor/new-name` 上已经存在的实现。
- “当前工作区”指我当前读取到的本地工作区状态，其中包含尚未提交的 Electron 持久化相关改动。
- `⚠` 表示该实现与上文原计划不完全一致，或存在需要继续收口的地方。

### 16.1 `packages/opencode` / Web / CLI：已合入远端的进展

以下内容已在当前分支远端或已合入的共享后端代码中实际生效。

#### 统一命名层与路径常量

- 已新增 `packages/opencode/src/persist/naming.ts`，统一定义：
  - `APP = "aether"`
  - `LEGACY_APP = "opencode"`
  - `PROJECT = ".aether"`
  - `LEGACY_PROJECT = ".opencode"`
  - `KB = ".aether-kb"`
  - `LEGACY_KB = ".opencode-kb"`
  - `CFG = "aether"`
  - `LEGACY_CFG = "opencode"`
- 已统一提供：
  - `Persist.current` / `Persist.legacy`
  - `platformDir()` / `legacyPlatformDir()`
  - `managedDir()` / `legacyManagedDir()`

对应代码：`packages/opencode/src/persist/naming.ts`

#### 全局路径初始化已改为显式流程

- `packages/opencode/src/global/index.ts` 已不再在 import 时创建目录。
- 目录创建与 cache version 清理已收口到 `Global.ensureDirs()`。
- `Global.Path.data/config/state/cache/log/bin` 已切到 `Persist.current.*`，即新的 `aether` 根目录。

对应代码：`packages/opencode/src/global/index.ts`

这意味着 §6.3 中“先 rename 迁移、再创建目录”的阻塞性前置改造已经实际完成。

#### 启动顺序已改造

- `packages/opencode/src/index.ts` 的 yargs middleware 当前顺序为：
  1. `ensureUser()`
  2. `Global.ensureDirs()`
  3. `Log.init()`
  4. `JsonMigration.run()`

对应代码：`packages/opencode/src/index.ts`

这说明“用户级 rename 迁移先于新目录初始化、先于 JSON→SQLite 迁移”这一主线已落地；旧 `LegacyDB` 自动补库已不再参与 boot 主链。

#### 用户级迁移层已落地

- 已新增 `packages/opencode/src/persist/migrate.ts`。
- 已实现 `ensureUser()`、`status()`、`reset()`。
- 已实现跨进程锁：
  - 锁文件名：`.migrate.lock`
  - 带陈旧锁回收（5 分钟超时）
- 已实现迁移 marker：
  - 文件名：`migration-v1.json`
  - 当前记录字段：`copied`、`skipped`、`time`

对应代码：`packages/opencode/src/persist/migrate.ts`

#### 用户级迁移已覆盖的资产

当前 `ensureUser()` 实际会做以下 copy-on-first-use：

- `data/`
  - 旧根目录下匹配 `aether*.db` 的数据库文件
  - 对应的 `-wal` / `-shm`
  - 若旧根目录中不存在任何 `aether*.db`，则从旧根目录的 `opencode*.db` 中按“最新库优先”语义只读选源，并直接在新根目录生成目标库（默认 `aether-prod.db`）及其 `-wal` / `-shm`
  - `auth.json`
  - `mcp-auth.json`
  - `reading-mode/`
  - `storage/`
- `config/`
  - `config.json`
  - `opencode.json -> aether.json`
  - `opencode.jsonc -> aether.jsonc`
  - `AGENTS.md`
  - `tui.json`
  - `tui.jsonc`
- `state/`
  - `model.json`
  - `kv.json`
  - `prompt-history.jsonl`
  - `prompt-stash.jsonl`
  - `frecency.jsonl`
  - `legacy-db.json`
  - `legacy-db-merge.json`
- 特例目录
  - `wechat/session.json`
  - `wechat/accounts.json`
  - `feishu/config.json`
  - `feishu/sessions.json`
  - `feishu/hidden_projects.json`
  - `wechat-bridge/` 整目录

对应代码：`packages/opencode/src/persist/migrate.ts`

这意味着之前测试里暴露出来的“旧全局 `opencode.json*` 中 provider baseURL 不会被实体化复制”问题，已经通过用户级迁移补上。

#### 全局配置读写语义已修正

- `Config.global()` 现在会：
  - 先读 `config.json`
  - 再判断新命名文件 `aether.json` / `aether.jsonc` 是否存在
  - 若存在，只读取新命名文件
  - 若不存在，回退读取旧命名文件 `opencode.json` / `opencode.jsonc`
- `updateGlobal()` 现在在首次创建新配置文件时，会先以 `await global()` 的聚合结果为基底，再 merge 本次 patch。

对应代码：`packages/opencode/src/config/config.ts`

这意味着此前已经修掉：

- 旧 `opencode.json*` 中的预置 provider `baseURL` 首次写配置时丢失
- 新旧全局配置同时存在时，旧文件继续覆盖新文件

#### 项目级命名兼容已部分落地

- `ConfigPaths.directories()` 已同时向上搜索 `.aether` 与 `.opencode`。
- 项目配置加载已同时搜索：
  - `aether.jsonc`
  - `aether.json`
  - `opencode.jsonc`
  - `opencode.json`
- `.aether` / `.opencode` 目录中的 agent、command、mode、plugin 配置已同时参与读取。
- `session/index.ts` 新写入的 plan 路径已切到 `.aether/plans`。
- `agent/agent.ts` 权限规则已同时允许 `.aether/plans/*.md` 与 `.opencode/plans/*.md`。
- `knowledge/storage.ts` 新写入目录已切到 `.aether-kb`，读取时会回退 `.opencode-kb`。
- `file/ripgrep.ts` 已同时忽略 `.opencode` 与 `.aether`。

对应代码：

- `packages/opencode/src/config/paths.ts`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/knowledge/storage.ts`
- `packages/opencode/src/file/ripgrep.ts`

#### WeChat / Feishu 路径命名兼容已部分落地

- WeChat 和 Feishu 的路径计算都已从模块顶层旧常量改为通过 `platformDir()` / `legacyPlatformDir()` 计算。
- 读取时都会优先使用新路径，不存在时回退旧路径。
- 写入路径统一落到新路径。

对应代码：

- `packages/opencode/src/wechat/manager.ts`
- `packages/opencode/src/feishu/manager.ts`

#### 已存在的测试覆盖

当前仓库里已经有与本轮命名迁移直接相关的自动化测试：

- `packages/opencode/test/persist/migrate.test.ts`
- `packages/opencode/test/config/config.test.ts`
- `packages/opencode/test/config/tui.test.ts`
- `packages/opencode/test/file/ripgrep.test.ts`
- `packages/opencode/test/storage/db.test.ts`
- `packages/opencode/test/storage/legacy-db.test.ts`

其中已覆盖：

- 旧用户级路径复制到新路径
- 新路径已存在时不覆盖
- 旧目录已有 `aether*.db` 时只复制这些库，不再理会 `opencode*.db`
- 旧目录仅有 `opencode*.db` 时，只在新目录生成目标库，不把 `opencode*.db` 原名带进新目录
- 全局 `aether.json*` / `opencode.json*` 优先级
- `updateGlobal()` 首次写入保留 legacy provider `baseURL`
- `.aether` / `.opencode` 的搜索兼容
- `tui` 迁移行为

### 16.2 `packages/opencode`：与原计划不一致或尚未完全收口的点

以下内容需要特别标记，因为它们与上文原计划存在差异，或者虽已有代码但未完全达到原计划要求。

#### ✅ 数据库职责已按讨论收口

当前 `persist/migrate.ts` 中：

- `copyDb()` 已只处理 `aether*.db`
- `seedDb()` 仅在旧目录中不存在任何 `aether*.db` 时，才从旧目录的 `opencode*.db` 中只读选源
- 新目录中不再落任何 `opencode*.db`
- boot 主链已不再自动调用 `LegacyDB.status()` / `LegacyDB.copySource()`

对应代码：

- `packages/opencode/src/persist/migrate.ts`
- `packages/opencode/src/index.ts`

这意味着此前文档中标记的“数据库 rename 迁移当前复制所有 `*.db`”问题已经被修正。

#### ⚠ marker 信息比原计划简化

原计划 §10.2 建议 marker 至少记录：

- 迁移版本
- 来源根目录
- 已复制资产
- 跳过项
- 失败项

当前实际 marker 只包含：

- `copied`
- `skipped`
- `time`

对应代码：`packages/opencode/src/persist/migrate.ts`

目前这不影响幂等复制，但调试信息仍然弱于原计划。

#### ⚠ `ensureProject()` 仍保留在代码中，但运行时已不再调用

当前 `persist/migrate.ts` 里仍保留了 `ensureProject()`，其行为是：

- 若 `.aether/skills` 不存在、`.opencode/skills` 存在
- 则将 `.opencode/skills` 整目录复制到 `.aether/skills`

并且该行为有对应测试：`packages/opencode/test/persist/migrate.test.ts`

但目前仓库内已没有运行时调用 `ensureProject()` 的入口，因此这一项目级自动复制逻辑处于“函数与测试仍在、主流程未接入”的状态。

对应代码：

- `packages/opencode/src/persist/migrate.ts`
- `packages/opencode/test/persist/migrate.test.ts`

这与用户后来明确确认的“统一 boot 阶段只处理全局/用户级，不处理项目级”是一致的；但与本文 §7.3 中关于 `skills/` 首次启动 copy 的原始描述不一致。

#### ⚠ `tui` 迁移仍然是运行时懒触发，且会修改旧配置文件

原计划后续讨论里已经明确：

- 暂不在本轮继续展开 boot 阻塞方案
- 项目级先采用双读兼容
- 不应对旧用户文件做原地改写

但当前实际实现中：

- `TuiConfig.get()` 仍会在运行时调用 `migrateTuiConfig()`
- 当发现 `opencode.json*` 或 `aether.json*` 中存在 `theme` / `keybinds` / `tui` 字段时
  - 会生成新的 `tui.json`
  - 会生成 `*.tui-migration.bak`
  - 并会回写原始配置文件，删除 legacy tui 字段

对应代码：

- `packages/opencode/src/config/tui.ts`
- `packages/opencode/src/config/migrate-tui-config.ts`

这与本文 §5.1 的“旧路径只读，不改名，不删除，不覆盖”不一致；也与后续用户确认的“项目级先只做兼容，不做自动迁移”不一致。

#### ⚠ 系统级 managed config 当前是“双目录并读”，不是“优先存在目录”

原计划 §7.4 中的写法是：

- `systemManagedConfigDir()` 返回第一个存在的目录
- 若都不存在则返回新名字

当前实际实现是：

- `managedDirs = unique([managedConfigDir(), legacySystemManagedConfigDir()])`
- 遍历所有存在的目录
- 每个目录中同时读取 `aether.json*` 与 `opencode.json*`

对应代码：`packages/opencode/src/config/config.ts`

这仍然符合“不自动迁移，只做双读兼容”的总体方向，但具体实现形态与原文举例不同。

### 16.3 Electron：已合入远端的进展

截至当前远端分支，Electron 方向已经有两项和命名迁移直接相关的修复进入代码。

#### packaged sidecar 连通性已修复

- `packages/app/src/utils/server.ts` 里的 `createSdkForServer()` 已开始透传 Basic Auth headers。
- 这修复了 packaged Electron 与本地 sidecar 之间的鉴权连通性问题。

对应代码：`packages/app/src/utils/server.ts`

#### packaged prod 的旧目录预处理已被新方案取代

此前远端曾通过 `prepareProdMigration()` 在 packaged + `prod` 下先向旧 XDG data 根补写 `opencode/aether-prod.db`，再让共享后端迁入新根。

当前工作区已移除这条路径，改为统一依赖共享后端在 `ensureUser()` 中直接从旧目录只读选源、写入新目录目标库。这样可以满足“旧目录严格只读”的约束。

### 16.4 Electron：当前工作区已完成但尚未提交的进展

以下内容我已在当前工作区代码中读到，但它们不在当前 `HEAD` 提交里，而是本地尚未提交的 Electron 持久化改动。

#### Electron `userData` 命名层已实际引入

- 新增 `packages/desktop-electron/src/main/paths.ts`
- 已定义：
  - `ai.aether.desktop.dev`
  - `ai.aether.desktop.beta`
  - `ai.aether.desktop`
- 同时保留 legacy：
  - `ai.opencode.desktop.dev`
  - `ai.opencode.desktop.beta`
  - `ai.opencode.desktop`
- `app.setPath("userData", userDataDir())` 已切到新的 `ai.aether.desktop*`
- `app.setName(...)` 也已切到 `Aether*`

对应代码：`packages/desktop-electron/src/main/paths.ts`

#### Electron store 命名层已实际引入

- 新增 `packages/desktop-electron/src/main/persist-names.ts`
- 已定义：
  - `SETTINGS_STORE = "aether.settings"`
  - `LEGACY_SETTINGS_STORE = "opencode.settings"`
- 已提供：
  - `storeName()`
  - `legacyStoreName()`
- 规则已经覆盖：
  - `opencode.settings -> aether.settings`
  - `opencode.global.dat -> aether.global.dat`
  - `opencode.workspace.foo.dat -> aether.workspace.foo.dat`
  - `default.dat` 保持不变

对应代码：

- `packages/desktop-electron/src/main/persist-names.ts`
- `packages/desktop-electron/src/main/persist-names.test.ts`

#### Electron `userData` 复制层已实际引入

- 新增 `packages/desktop-electron/src/main/persist.ts`
- 已实现 `ensureDesktopPersist()`，当前会：
  - 创建新的 `userData` 目录
  - 将旧 `default.dat` 复制到新 `userData`
  - 将以下任一来源的 sidecar state 子树复制到 `<newUserData>/aether`
    - `<newUserData>/opencode`
    - `<oldUserData>/aether`
    - `<oldUserData>/opencode`
- 已实现 `ensureStoreFile()`，会在真正创建 electron-store 前尝试从新旧 `userData` 中的旧 store 名复制到新 store 名。
- 已统一 `sidecar.pid` 的探测范围为新旧两个 `userData`。

对应代码：

- `packages/desktop-electron/src/main/persist.ts`
- `packages/desktop-electron/src/main/store.ts`

#### Electron 主进程已开始使用新的持久化辅助层

当前工作区里：

- `src/main/index.ts`
  - 已 `import "./paths"`
  - 启动初始化前会调用 `ensureDesktopPersist()`
- `src/main/store.ts`
  - 创建 `electron-store` 前会先跑 `ensureDesktopPersist()` 与 `ensureStoreFile()`
- `src/main/cli.ts`
  - 已改为通过 `userDataDir()` 写 `sidecar.pid`
  - 启动前会调用 `ensureDesktopPersist()`

这意味着 Electron 主进程自己的 `userData` 命名迁移已经开始接入启动链。

### 16.5 Electron：当前仍未落地或未完全对齐 Web 的部分

以下内容截至当前仍未真正完成，Electron 仍未在用户体验和持久化行为上完全对齐 Web 版本。

#### Electron 启动状态机尚未纳入“重命名迁移”语义

- `packages/desktop-electron/src/main/index.ts` 当前仍只有：
  - `server_waiting`
  - `sqlite_waiting`
  - `done`
- 尚无：
  - rename migration checking
  - rename migration in progress
  - restart required

因此 Electron 还没有把“路径命名迁移”显式纳入初始化状态机。

#### `migrate()` 仍未启用

- `packages/desktop-electron/src/main/migrate.ts` 仍然存在
- 但 `index.ts` 中 `migrate()` 依然是注释掉的

对应代码：

- `packages/desktop-electron/src/main/migrate.ts`
- `packages/desktop-electron/src/main/index.ts`

不过需要注意，当前工作区已经不再依赖 `migrate()` 处理 store 重命名，相关逻辑正在转移到 `persist.ts` / `persist-names.ts`。

#### `sqliteFileExists()` 的原计划修复当前并未以该函数形式落地

原计划 §9.2 中建议尽快修复 `sqliteFileExists()`。

当前实际情况是：

- 远端当前 `packages/desktop-electron/src/main/index.ts` 中已看不到该函数
- JSON→SQLite 进度条显示现在依赖 sidecar stdout/stderr 中的 `sqlite-migration:*` 事件

因此，原计划中的这条“即时修复”已经被后续架构演进绕开，不再以 `sqliteFileExists()` 的形式存在。

#### Electron renderer / WebView 本地存储命名仍然是旧名

当前 `packages/app` 中仍有一批 Electron/前端本地存储键名保留旧命名：

- `packages/app/src/entry.tsx`
  - `opencode.settings.dat:defaultServerUrl`
  - `opencode.settings.dat:proxy`
- `packages/app/src/utils/persist.ts`
  - `GLOBAL_STORAGE = "opencode.global.dat"`
  - `LOCAL_PREFIX = "opencode."`

这意味着即使 Electron 主进程 store 文件命名已开始迁移，renderer 侧 localStorage / 持久化命名仍未完成对齐。

#### CLI 安装路径与 sidecar 二进制命名仍然保留旧名

当前 `packages/desktop-electron/src/main/cli.ts` 里仍然是：

- `CLI_INSTALL_DIR = ".opencode/bin"`
- `CLI_BINARY_NAME = "opencode"`
- sidecar 二进制仍然解析为 `opencode-cli`
- WSL 安装脚本仍然写死 `~/.opencode/bin/opencode`

这部分仍然属于 §12 阶段四里尚未收口的遗留项。

#### Electron 仍未实现与 Web 一致的“迁移期间禁止使用 + 完成后要求重启”

目前：

- Web / CLI 共享后端侧也尚未接入 boot gate 和 API 总闸门
- Electron loading window 目前只覆盖 sidecar 启动和 SQLite 迁移
- 尚未覆盖 rename migration 的阻塞展示
- 尚未在迁移完成后强制提示用户重启

这与用户后续提出的更严格要求仍然有距离，目前暂未进入实施范围。

### 16.6 当前阶段判断

综合上面的实际代码状态，可以把当前进度概括为：

1. `packages/opencode` 的用户级全局持久化命名迁移主线已经落地，Web/CLI 路径已经从 `opencode` 切到了 `aether`，并具备 copy-on-first-use 能力。
2. 全局配置迁移中最关键的正确性问题，即旧 `opencode.json*` 中 provider `baseURL` 的保留，已经修正。
3. 项目级路径当前主要停留在“兼容读取、写新路径”的阶段，未统一纳入启动期迁移；其中 `tui` 仍是明显例外。
4. Electron 远端已完成 packaged sidecar 连通性和 packaged prod 数据库过渡补丁。
5. 当前工作区中，数据库迁移链已经改为“旧目录只读 + 新目录直接 seed 目标库”，Electron packaged `prod` 不再需要向旧目录补写过渡库。
6. Electron 当前工作区已经开始进入 `userData` / store 名称迁移阶段，但 renderer 存储键、CLI 安装路径、重启交互和启动状态机仍未完全对齐 Web。

### 16.7 后续更新文档时应继续关注的点

后续如果继续推进命名迁移，建议优先检查并在本节继续增量补充以下事项：

- `tui` 迁移是否停止对旧配置文件的原地修改
- Electron renderer 存储键是否切到 `aether.*`
- Electron `CLI_INSTALL_DIR` / `CLI_BINARY_NAME` / sidecar 名称是否完成命名切换
- Electron 是否引入 rename migration 的初始化状态与重启提示
- 是否补上 Electron 方向的真实文件系统迁移测试
- `LegacyDB` 的手动诊断/修复路由是否需要按新的 boot 语义继续收口或重命名
