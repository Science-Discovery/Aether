# Aether WebUI · 项目识别 / project_id / 侧边栏 全景梳理

> 来源仓库：`.worktrees/fix-project-id-detection`（基于 `origin/dev` @ `d4acd9d1b`）
> 本次为只读分析备忘，未做任何代码修改。

---

## 0. 核心概念速览（一句话定义）

| 概念 | 含义 | 标识 / Key |
|---|---|---|
| **Project** | 一个代码仓库（一份"主 worktree"），持久化为一行 DB 记录 | `id = sha1(norm(主 worktree 绝对路径))`，40 hex |
| **Sandbox** | 同一 Project 的"备用副本"——通常是 git worktree、或被打开的子目录 | 字符串路径，存于 `project.sandboxes[]` |
| **Workspace** | 控制面（control-plane）层面、绑定到 Project 的受管 checkout，可绑分支 | 自有 `id`，外键 `project_id` |
| **Instance** | 服务端运行时按"目录"缓存的单例（Agent/Skill/Tool/Config 都挂这里） | key = `Filesystem.resolve(directory)`，一个 Instance 对应一个 Project |
| **Session / Message / Part** | 会话与消息，事件溯源 | 外键 `project_id`，可选 `workspace_id`；记录实际 `directory` |
| **ProjectRecent** | 全局表（webui 侧边栏数据源），`kind ∈ {project, directory}` | key = `dir:<norm(目录)>` |
| **GlobalProjectMap** | 全局别名表：directory → project_id 的反查表 | PK = norm(directory) |
| **DirectoryMeta** | 每个 Project DB 内的"每个被打开过的目录"的元信息（名称/图标） | PK = directory |

文档对应：`docs/architecture.md`、`docs/session-architecture.zh-CN.md`、`docs/workspace-data-loss-fix.md`。

---

## 1. project_id 是怎么算出来的（共有逻辑，跨端跨平台）

所有平台、所有客户端最终都走同一条服务端管线：

```
用户传入 directory（来自 dialog / URL / header / cwd）
      │
      ▼
Filesystem.resolve(p)  packages/opencode/src/util/filesystem.ts
   ├─ windowsPath()  把 /c/... /cygdrive/c/... /mnt/c/... → C:/...
   ├─ pathResolve()  绝对化
   └─ realpathSync() 跟随符号链接（POSIX 不做大小写变换；
                     Windows 用 realpathSync.native 修正盘符大小写）
      │
      ▼
ProjectIdentity.resolve(dir)  packages/opencode/src/project/identity.ts
   ├─ marker(dir)            向上找 .git（文件或目录），最多到根
   ├─ 无 .git    → root = dir, sandbox = root, vcs 为空
   ├─ .git 是目录 → root = sandbox = dirname(.git), vcs = "git"
   └─ .git 是文件 → 解析 gitdir:，截取 /worktrees/ 之前一级
                  → root = 主仓 worktree，sandbox = 当前 .git 所在目录
      │
      ▼
ProjectIdentity.norm(root)                   identity.ts
   ├─ \\ → /，去尾随 /（保留单个 / 与 <drive>:\）
   └─ Windows 上把 / 转回 \，<drive>: 补成 <drive>:\
      │
      ▼
ProjectID.fromDirectory(normRoot)            project/schema.ts
      = Hash.fast(normRoot)                  util/hash.ts
      = sha1(normRoot).hex                   ← 40 字符，无截断、无前缀、无盐
```

要点：
- **唯一探测器是 `.git`**。没有任何对 `package.json` / `opencode.json` / `AGENTS.md` 的探测——没有 `.git` 的目录就以自身路径作为根。
- **所有 git worktree 共享同一个 project_id**（指向主 worktree）。当前 worktree 路径会作为 `sandbox` 加进 `project.sandboxes[]`。
- **没有大小写折叠**（POSIX）；Windows 通过 `realpathSync.native` 修正实际盘符大小写。
- **没有截断哈希**：完整 40 字符 sha1。
- 三个地方各自实现了 `norm()`（`identity.ts`、`project.ts`、`storage/db.ts`）——必须字节级一致，否则 id/键会错位（这正是近期一系列修复的目标）。
- **保留 ID**：`"global"`（全局非项目命名空间），以及 skill-evolution 的固定根 id。

---

## 2. 服务端持久化（共有，所有客户端通用）

两层 SQLite：

**全局 DB**（`Global.Path.data/<channel>/aether.db`）
- `project_recent`（PK `key="dir:<norm(dir)>"`，`kind`、`project_id`、`directory`、icon、`activity_at`…）— 侧边栏的最近列表数据源。
- `global_project_map`（PK `directory`，`project_id`）— 别名反查表：每次 `Project.fromDirectory` 都会把 `directory ∪ worktree ∪ sandbox` 三个路径都写一行映射回同一个 `project_id`。

**每项目 DB**（`<channel>/aether-<projectId>.db`）— `Database.attach()` 强校验：除非 id 是 `"global"` 或 `global_project_map` 中已注册，否则不允许新建（`storage/db.ts`）。
- `project`（PK = `id`，`worktree`/`vcs`/`name`/`icon`/`sandboxes[]`/`commands.start`）
- `directory_meta`（PK = `directory`，`worktree`/`name`/`icon`/`activity_at`）
- `workspace`（FK 到 `project.id`，`ON DELETE CASCADE`）
- `session`（FK `project_id`，可选 `workspace_id`，`directory`）

写入主路径（`project/project.ts` `fromDirectory()`）：
1. `ProjectIdentity.resolve` 拿到 `{ id, worktree, sandbox, vcs }`
2. 写 `global_project_map`：`directory`、`worktree`、`sandbox` 三个 key 都映射到同一个 `id`
3. 写 `project_recent`（`touch`）
4. Upsert 当前 project DB 的 `project` 行
5. 同步图标/名字到 `project_recent`，写 `directory_meta`
6. 后台 `syncWorktrees`：`git worktree list --porcelain` 自动登记其它 worktree 为 sandbox

读取：
- 侧边栏列表 → `Project.recent()` (`project.ts:`)：按 `activity_at desc` 取 `project_recent`，再用 `global_project_map` 把 `project_id` 规范化（防陈旧），过滤掉 sandbox 重复条目（`project.ts`）和 skill-evolution 内部项目。
- 分组取所有 project → `Project.canonical()` (`project.ts`)：枚举所有 per-project DB 并 join。
- 反查：`Project.recentFromDir`、`Project.directories`。

---

## 3. HTTP/SDK 表面（所有 webui 都通过它）

服务端在请求进来时挂中间件（`server/server.ts`）：
- 取 `?directory=` 或 `x-opencode-directory` 头 → `Filesystem.resolve()` 规范化
- 进入 `Instance.provide({ directory, create, … })`：缓存 `Map<resolvedDir, Promise<Shape>>`，每个 Shape = `{ directory, worktree(=sandbox), project }`
- "browse" 类路径（`/file`、`/find`、`/file/pick-folder`、`/file/check-directory`、`/file/ensure-directory`）只读复用已有 Instance，不会创建项目。

由此暴露的 REST：

| 路径 | 用途 |
|---|---|
| `GET /project` | 全部已知 Project（`project.list`） |
| `GET /project/recent` | 侧边栏使用的最近项目/目录混合列表 |
| `GET /project/directories` | 项目下的目录元信息 |
| `GET /project/current` | **当前 Instance 的 Project**（按 directory header 路由） |
| `PATCH /project/:id` | 改名/改图标 |
| `DELETE /project/:id` | 删项目（有 session 则拒绝） |
| `POST /project/git/init` | git init + reload Instance |
| `GET /project/:id/session-count` | 删除前校验 |
| `POST /project-directory-meta` | 写 `directory_meta` |
| `GET /path` | 当前 Instance 的 `{ directory, worktree }` |
| `GET /vcs` | VCS 状态 |
| `*/experimental/workspace*` | 控制面 workspace |

SDK 类型（`packages/sdk/js/src/v2/gen/types.gen.ts`）：`Project`、`ProjectRecent`、`Workspace`、`Worktree`、`Session` 字段如概念表。

---

## 4. WebUI 端的项目识别 / 侧边栏（共有逻辑，`packages/app`）

`packages/app` 是 SolidJS 应用——**Electron 渲染进程、Tauri 桌面端、纯浏览器**都加载同一份代码。`packages/web` 是 Astro 营销站（无侧边栏），`packages/console` 是另一种工作台（无项目侧边栏）。

### 4.1 三层数据源

1. **全局服务端拉取（global store）** — `packages/app/src/context/global-sync/bootstrap.ts`
   - `globalSDK.project.list()` → `globalStore.project`（全部 Project）
   - `globalSDK.project.recent()` → `globalStore.recent`（最近列表）
   - 构建按目录索引：`global-sync.tsx`：把 `project.worktree` 与每个 `project.sandboxes[]` 都注册进 `byDir` Map，便于"任意目录 → Project"查找。

2. **每服务器持久化的"已打开项目"列表** — `packages/app/src/context/server.tsx`
   ```ts
   {
     projects: Record<serverKey, StoredProject[]>   // serverKey = "local" | URL
     lastProject: Record<serverKey, string>        // 当前 active 目录
   }
   ```
   存到 `opencode.global.dat`（Electron 下落到 `aether.global.dat` 文件，见 §5）。**这是真正决定侧边栏显示哪些 tile 的列表**——而非服务端"全部项目"。

3. **layout 富化层** — `packages/app/src/context/layout.tsx`
   `enrich(project)` 把 `StoredProject` 与 `globalSync.child(worktree).project`（projectID）+ `globalSync.project.get(id)`（icon/name）+ `globalSync.project.recentFromDir(worktree)` 合并为 `LocalProject = Partial<Project> & { worktree, expanded }`，输出 `layout.projects.list()` 给侧边栏。

### 4.2 当前 directory / 当前 project_id

- **URL 是当前目录的真实来源**：`/:dir/...` 中 `:dir` 是 base64(directory)。`layout.tsx`：
  ```ts
  const currentDir = createMemo(() => decode64(params.dir) ?? "")
  ```
- **当前 project_id**：`bootstrap.ts` 中的 `bootstrapDirectory`：
  1. 先用本地 `byDir` 匹配（worktree 或 sandboxes 中包含 directory）
  2. 不行则 `sdk.project.current()`（带 `x-opencode-directory` 头）
  3. 兜底：`sdk.path.get()` 回填，再次 `byDir` 匹配
- **侧边栏选中态** — `sidebar-project.tsx`：
  ```ts
  const selected = createMemo(() =>
    workspaceKey(props.project.worktree) === workspaceKey(props.ctx.currentDir()) ||
    props.project.sandboxes?.some(s => workspaceKey(s) === workspaceKey(props.ctx.currentDir()))
  )
  ```
  只用 `workspaceKey = norm(directory)`（来自 `packages/util/src/path.ts`），**不**做 realpath、不做小写。

### 4.3 侧边栏组件结构

```
nav (sidebar-nav-desktop / sidebar-nav-mobile)         packages/app/src/pages/layout.tsx+
└─ SidebarContent                                       sidebar-shell.tsx
   ├─ rail
   │  ├─ For projects → SortableProject                 sidebar-project.tsx
   │  │   └─ ProjectTile (selected/active 高亮)         sidebar-project.tsx
   │  │       ├─ ProjectIcon                            sidebar-items.tsx
   │  │       └─ ContextMenu（编辑/删除/工作区/关闭…）
   │  ├─ "New project" 按钮（仅 desktop 平台）         layout.tsx + sidebar-shell.tsx
   │  ├─ "Open project" 按钮                           sidebar-shell.tsx
   │  └─ 用户/平台/设置/帮助
   └─ SidebarPanel（当前 project 的 sessions）         layout.tsx
      └─ 空态：sidebar.empty.* i18n + Open project 按钮
```

### 4.4 切换项目（点击 tile）

`sidebar-project.tsx:`：点已选中的 tile → 收起侧边栏；否则 `props.navigateToProject(project.worktree)`。

`navigateToProject`（`layout.tsx`）：
1. `server.projects.touch(directory)` 写 `lastProject[serverKey]`
2. 计算"工作区有效顺序"：当前 + sandboxes + 同 project 的 recent 兄弟目录
3. 找上次会话或最新会话 → `navigate('/${base64(dir)}/session/${id}')`，否则 `/${base64(dir)}/session`

**纯客户端 URL 跳转**——没有 IPC，没有"切 cwd"的 RPC。服务端的 Instance 路由只看请求里的 `x-opencode-directory` 头。

### 4.5 自动选择 / 空态（`layout.tsx`）

- 若 URL 无 `:dir`、`server.projects.list()` 非空 → 选择 `lastProject` 对应的或第一个
- 列表为空但有 `lastProject` → 先 `openProject(last, false)` 再跳过去
- 都没有 → SidebarPanel 显示 `sidebar.empty.{title,description}` + Open project 按钮（i18n 在 `packages/app/src/i18n/en.ts`）
- 期间过滤掉 `aether/aether_x.y.z.w` 这类构建产物路径（正则）

---

## 5. Electron 端 vs 纯 Web 端

### 5.1 Electron（`packages/desktop-electron`）

**主进程不识别项目，也不传 cwd 给服务端。**

- 启动 sidecar：`main/cli.ts serve()` → `opencode-cli serve --hostname … --port … --print-logs --log-level WARN`，**没有 `--cwd`、没有目录参数**。`spawn` 时 `cwd: app.isPackaged ? process.resourcesPath : undefined`。环境变量带 `OPENCODE_CLIENT=desktop`、密码、XDG_*。
- 渲染进程通过 IPC `await-initialization` 拿到 `{ url, username, password }`（`preload/index.ts`），**只是连服务端凭据**——不包含任何 project_id。
- 项目目录选择：IPC `open-directory-picker`（`main/ipc.ts`）调 `dialog.showOpenDialog({ properties: ["openDirectory","createDirectory", multiSelections?] })`。返回的字符串**未经任何规范化**直接交给渲染进程。
- 渲染进程拿到目录后调 `server.projects.open(dir)` 把它加到本地"已打开"列表，并 navigate 到 `/${base64(dir)}/...`，服务端这时才第一次看到这个目录、走 §1 那条管线生成 project_id。
- "New project" 按钮：仅 `platform === "desktop"` 时显示（`layout.tsx`、`sidebar-shell.tsx`）。
- 深链：`aether://` 协议（`main/index.ts setAsDefaultProtocolClient("aether")`），`emitDeepLinks` 经 `webContents.send("deep-link", urls)` 转给渲染进程，渲染进程 `layout.tsx` 处理，仅在 `server.isLocal()` 下生效。
- 单实例：`requestSingleInstanceLock` + `second-instance` 事件捡 `aether://` argv。

### 5.2 纯 Web（浏览器）

- 没有 `dialog.showOpenDialog`，没有 IPC，没有"new project"按钮。
- 服务端 `cwd` 即默认 directory；`bootstrap.ts` 直接用 `sdk.project.current()` 拿到当前 project，使用者只能在那一个 project 内浏览/切换 sandbox。
- "Open project" 类按钮在浏览器下 `Platform.openDirectoryPickerDialog` 未提供，UI 受限。

### 5.3 Tauri 桌面（`packages/desktop`）

也有自己的 directory picker（`packages/desktop/src/index.tsx`），原理与 Electron 类似但通过 Tauri command。本次问题与之无直接关系。

---

## 6. Windows / macOS / Linux 平台特殊性

### 共享路径规范化（`packages/util/src/path.ts`）

```ts
const isWin = process.platform === "win32"
export function norm(input: string): string {
  if (!input) return input
  const next = input.replace(/\\/g, "/")
  const result = /^\/+$/g.test(next) ? "/" : next.replace(/\/+$/, "")
  if (isWin && /^[A-Za-z]:/.test(result)) {
    const out = result.replace(/\//g, "\\")
    if (/^[A-Za-z]:$/.test(out)) return out + "\\"
    return out
  }
  return result
}
```
- **不做小写折叠**（NTFS 大小写不敏感这点没在客户端兜底，靠 Electron dialog 返回值与 `realpathSync.native` 保持一致）
- **不专门处理 UNC `\\server\share`**——只判 `^[A-Za-z]:` 前缀，UNC 在 Windows 下会变成 `//server/share`（潜在 bug 风险点）
- 已被多次修复（`f11429458 / c6a77e5b8 / 9ecc8d9b6 / d72036fc0`）。

### Windows
- Sidecar 二进制带 `.exe`（`cli.ts`）
- 不 detach、不 `kill -PGID`，用 `tree-kill`（`cli.ts`）
- `windowsHide: true`
- WSL 模式：`cli.ts` `wsl -e bash -lc <script>`，配合 IPC `wsl-path` 在 Linux ↔ Windows 路径间互转，影响 dialog `defaultPath` 与回填（`renderer/index.tsx`）
- `electronWindows` 标志：UA 探测 `Windows`（`renderer/index.tsx`）
- 协议注册写入 HKCU
- **不使用 `%APPDATA%`**：用户数据故意被改写到 `~/.local/share/aether/desktop/`（与 Linux 同布局，`paths.ts`），即 Windows 上典型路径是 `C:\Users\<user>\.local\share\aether\desktop\`
- 自动更新走 electron-updater（不是手动）

### macOS
- `app.on("open-url", ...)`（Apple Event）是 macOS 专用深链路径
- `setDockIcon()` 仅 darwin
- 手动更新（`MANUAL_INSTALL_UPDATE === true`），点击更新弹 GitHub Releases
- `open -a` 命令打开外部 app（`ipc.ts`）
- CLI 安装脚本仅 macOS/Linux 可用（`cli.ts`）
- **不使用 `~/Library/Application Support`**：同样被强制改到 `~/.local/share/aether/desktop/`（不寻常但故意为之）
- `.app` 包内：`process.resourcesPath` 指向 Resources/

### Linux
- AppImage 检测：`process.env.APPIMAGE` 决定走手动更新（非 AppImage）还是自动更新
- detached 进程组 + `process.kill(-pid, ...)` 清理 wrapper shell（`index.ts`、`cli.ts`）
- XDG 完整支持（`cli.ts`）：`XDG_DATA_HOME / XDG_CONFIG_HOME / XDG_CACHE_HOME / XDG_STATE_HOME` 全部传给 sidecar
- snap/flatpak 走 `app.getPath("home")` 隐式适配（snap 把 `$HOME` 改写到 `~/snap/<app>/current`），代码无显式分支

---

## 7. 用户实际使用场景对应

| 场景 | 实际触发的代码路径 |
|---|---|
| **首次启动 Electron** | `desktop-electron/main` 拉起 sidecar（无项目）→ 渲染进程拿到凭据 → `bootstrap.ts` 拉 `project.list()`/`recent()` → `layout` 自动选 `lastProject`（无则空态） |
| **点击 "Open project"** | IPC `open-directory-picker` → dialog 返回 raw path → 渲染进程 `server.projects.open(dir)` 持久化 → 路由到 `/<base64(dir)>/...` → 服务端中间件 `Filesystem.resolve` + `Project.fromDirectory` 写三表 → 侧边栏 tile 出现 |
| **打开同一仓库的另一个 git worktree** | 同上选目录；`ProjectIdentity.resolve` 把 `.git`-file 解析成主 worktree → 复用同一 `project_id`，仅追加到 `sandboxes[]`、`global_project_map`、`directory_meta`；`recent()` 过滤防止侧边栏出现重复 tile（`project.ts`） |
| **点击侧边栏 tile** | 纯前端 `navigateToProject(worktree)` → 找该 directory 上次的会话 → URL 跳过去；服务端通过 `x-opencode-directory` header 看到目录、解析 Instance |
| **切换到同 project 的 sandbox** | sidebar 的 selected 态用 `workspaceKey` 比 `worktree` 与 `sandboxes[]`（`sidebar-project.tsx`）；选中后通过 `effectiveWorkspaceOrder` 在 SidebarPanel 显示 sandbox 切换条 |
| **删除项目** | tile 右键 → `ctx.deleteProject` → SDK `DELETE /project/:id` → 服务端 `Project.remove` 校验无 session → detach + 删 per-project DB + 清 `global_project_map`、`project_recent` |
| **重命名 / 改图标** | `PATCH /project/:id` 写 ProjectTable；`POST /project-directory-meta` 写 DirectoryMeta；图标双向同步进 `project_recent`（`project.ts`） |
| **浏览器访问服务端** | 用户无法选目录；服务端 `cwd` 决定的那个 project 通过 `GET /project/current` 直接返回；切换只能在 sandboxes 内 |
| **Windows 用户用 WSL 路径** | 渲染进程先调 IPC `wsl-path` 把 `/mnt/c/...` ↔ `C:\...` 互转后再交服务端；服务端 `windowsPath()` 也兜底转 |
| **符号链接目录** | `Filesystem.resolve` 跑 `realpathSync` 跟随；故 symlink 与 target 拿到**同一个** project_id |
| **未受 git 控制的目录** | `marker()` 找不到 `.git` → 路径本身做根 → `vcs` 字段为空；每个非 git 目录是独立 project |

---

## 8. 已知潜在问题面（与"处理 project_id 计算"相关的高风险点）

1. **客户端 `byDir` 是普通字符串等值匹配**（`global-sync.tsx`、`sidebar-project.tsx`）——不做 realpath、不做大小写折叠、不重新 normalize 分隔符。如果 Electron dialog 返回的字符串和服务端 `Project.worktree` / `sandboxes[]` 字面不一致（Windows 大小写、UNC、尾随分隔符、symlink 已被服务端解开但客户端没解开），侧边栏会出现"明明是这个项目却高亮不上"或者"打开了但没归档到对的 tile"。
2. **三处 `norm()` 必须字节级一致**（`identity.ts`、`project.ts`、`storage/db.ts`、`util/path.ts`）。一旦任一发生漂移，写入键和哈希输入分裂，会出现"幽灵 project"。这正是近期一连串修复的主题（`f11429458`、`c6a77e5b8`、`9ecc8d9b6`、`d72036fc0`）。
3. **UNC 路径 (`\\server\share\...`) 在 `util/path.ts` 的 norm 里没有特别处理**——只检查盘符前缀，UNC 会被替换成正斜杠开头的 `//server/share`，与服务端走 `windowsPath()` 后的形态可能不一致。
4. **跨平台用户数据目录强制 XDG**（macOS/Windows 均落到 `~/.local/share/aether/desktop`）——用户预期可能在 `%APPDATA%` 或 `~/Library/Application Support`，目前并不在那里。
5. **Phase 4 启动校验**（`fcaa62cae`）会在启动时用 `ProjectIdentity.resolve` 验证 `global_project_map` 与 `project_recent`——如果该校验逻辑本身有 bug，可能误删/误改用户的 recent 与 alias 表。
6. **WebUI 自动选项目时过滤了 `aether/aether_x.y.z.w`** 路径（layout.tsx）——若用户真的把项目放在这种路径下，会被错误隐藏。
7. **Sandbox 与主项目共享 project_id**——所有 per-project 数据（sessions、workspaces、directory_meta、knowledge）都共享。如果用户把多个无关仓库通过一些奇怪的 `.git` 文件配置串在一起（罕见），可能错误并库。
