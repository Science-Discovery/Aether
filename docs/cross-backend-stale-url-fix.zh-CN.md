# 跨后端旧 URL 回放导致界面空白问题分析与修复方案

## 1. 问题概述

Mac 桌面客户端在本地后端工作一段时间后，切换到远端服务器后端时出现：

- 最左侧 project 边栏仍保持 Mac 本地打开的项目列表；
- 中间 session 显示界面及其他界面空白；
- 右上角按钮点击无响应。

经排查，**远端服务器与数据均健康**，问题纯粹由前端跨后端复用同一份客户端状态（URL 中的 directory / session、localStorage 中的 currentProjectID）导致。软件本身未更新，触发者是客户端侧的状态漂移。

## 2. 现象与证据

### 2.1 远端服务器日志（`~/.local/share/aether/log/dev.log`，UTC 03:37）

三条关键错误集中在 `03:37:43–03:37:51`：

| 服务器侧现象                                                                                                                                       | 含义                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `service=default directory=/Users/lx/Desktop/code/AI/Aether-dev/Aether bootstrapping` → `ERROR EACCES: permission denied, mkdir '/Users/lx'`       | 前端把 Mac 工作目录通过 `params.dir` 发给远端，服务器尝试 bootstrap 该目录，在 Linux 上去 `mkdir '/Users/lx'` 失败 |
| `GET /session/ses_0a930f798ffd3448LdhQ2IS0Cw` → `ERROR Cannot create project database: e94586062ac1cb3cbd31ba3d7152f007f3d40e91 is not registered` | 前端请求的会话被 scope 到一个远端从未注册的项目 `e9458606…`，服务器无法打开该 project 库                           |
| `INFO global event disconnected`                                                                                                                   | SSE 全局事件流断开，右上角按钮无响应的直接原因                                                                     |

### 2.2 数据库取证

- `e9458606…` 是**纯幽灵 ID**：远端 `global_project_map`、`local/`、`prod/` 项目库、`aether-memory.db` 的 `project_id` 列均查无；Mac 端任何 DB / 持久化文件也查无。它不是任何已注册目录的 `sha1`。
- 会话 `ses_0a930f798ffd3448LdhQ2IS0Cw` 是**远端真实会话**，完好存在于 polysimplify 项目库 `aether-7ea56ad73f44ba94d2cd14809ae511eb521e167f.db`：
  - `project_id = 7ea56ad…`（polysimplify，`/home/lixiang/code/AI4research/polysimplify`）
  - `title = "利用因子化结构减少积分约化撒点"`
- `aether-memory.db` 中有 6 条 `remember` 事件，`session_id = ses_0a930f79…`、`project_id = 7ea56ad…`，时间为 7 月 12 日 14:50–16:33。即该会话此前在远端 polysimplify 上正常使用。
- 远端 `local/` 下所有项目库 mtime 均为 7 月 13 日 11:37（服务器重启），`aether-local.db` 中 Mac Aether-dev 路径行的 `time_updated` 为 7 月 13 日 03:52（本次失败重连刷新）。

### 2.3 项目 ID 计算方式

`ProjectID.fromDirectory(directory) = sha1(规范化根目录路径)`，与 git 历史无关：

- `packages/opencode/src/project/identity.ts:50-91` `ProjectIdentity.resolve(dir)` 找到 `.git` marker 后取其父目录为 root；
- `packages/opencode/src/project/schema.ts` `ProjectID.fromDirectory = (directory) => schema.makeUnsafe(Hash.fast(directory))`；
- `packages/opencode/src/util/hash.ts` `Hash.fast = (input) => createHash("sha1").update(input).digest("hex")`。

验证：`sha1("/Users/lx/Desktop/code/AI/Aether-dev/Aether") = 53db03507412fe2333e258f9e5e27c70dacc7d75`，与 Mac / 远端 `global_project_map` 中该路径的 `project_id` 完全一致。故同一目录路径在两端得到同一 project ID，稳定可复现。

## 3. 根本原因

### 3.1 directory 与 session 存于 URL，与后端无关

- 路由：`packages/app/src/app.tsx:313-316`
  - `/:dir` → `params.dir`（目录路径的 base64）
  - `/session/:id?` → `params.id`（会话 ID）
- `packages/app/src/pages/directory-layout.tsx:43-46,76`：`resolved = decode64(params.dir)`，直接用它建 `SDKProvider directory={() => resolved}`。
- `packages/app/src/context/sdk.tsx:22-31`：SDK client 用该 directory 创建，后续所有请求都带它。
- `packages/app/src/pages/session.tsx:599`：`sync.session.get(params.id)` 直接用 URL 里的 `params.id` 去当前后端取会话。
- `packages/app/src/context/global-sync/bootstrap.ts:184`：`sdk.project.current()` / `path.get()` 等均用 URL 来的 directory 调用，从不校验该 directory / project 是否属于当前后端。

### 3.2 切换后端只改 `state.active`，不重置 URL

- `packages/app/src/context/server.tsx:181-183` `setActive`：仅 `setState("active", input)`，不动 URL、不清 session。
- `packages/app/src/app.tsx:283-290` `ServerKey` 是 `<Show when={server.key} keyed>`：`server.key` 变化时整棵子树（含 Router）重挂载，但 `@solidjs/router` 保留当前 URL，所以 `params.dir` / `params.id` 仍是旧后端的值，重挂载后被重新解码并应用到新后端。

### 3.3 仅有的两处"软重置"非结构性

只有两个交互入口在 `setActive` 前调了 `navigate("/")`，且用 `queueMicrotask` 排队、依赖时序：

- `packages/app/src/components/status-popover.tsx:279-280`：`navigate("/"); queueMicrotask(() => server.setActive(key))`
- `packages/app/src/components/dialog-select-server.tsx:357,360`：同上模式。

reload / 深链 / 改 localStorage 默认后端后刷新等路径**完全绕过**这两处，旧 URL 原样回放给新后端。

### 3.4 为什么"以前能用、现在不能用、且没更新"

触发条件是**数据/状态漂移**，不是代码回归：

- 7 月 12 日，客户端把会话 `ses_0a930f79…` 正确 scope 到 polysimplify（`7ea56ad…`），加载正常。
- 7 月 13 日重连时，同一会话被 scope 到幽灵 `e9458606…`（外加 Mac 目录 bootstrap 触发 EACCES）。会话本身和远端服务器都健康，变的是客户端侧"当前 directory / currentProjectID"指针。
- 这个漂移能发生，正是 3.1–3.3 描述的结构性缺陷：指针不与后端绑定、切换/重连不校验。该缺陷平时状态没漂移就不触发，"以前没事"只是因为指针恰好对得上。软件不需要更新，只要客户端状态漂移就会复现。

## 4. 修复方案

目标：**directory / session / currentProjectID 与后端绑定，切换或重连时校验并重置，旧指针绝不跨后端回放。**

### 4.1 方案 A（简单版）：切换后端时结构性回到 `/`

覆盖**在线切换后端**场景。本质是把现有两处 `navigate("/")` 提升为一个对 `server.key` 变化的响应式 effect。

**改动位置**：`packages/app/src/app.tsx`（`ServerKey`，约 283-290 行附近）。

**要点**：

- 用 `createEffect(on(() => server.key, () => navigate("/", { replace: true }), { defer: true }))`，**只在 key 变化时触发、跳过首次**（避免破坏同后端的深链与正常 boot）。
- 效果必须在 keyed 的 `<Show keyed>` 重挂载**之前/之外**生效，否则新 Router 读到的还是旧 URL。实现上即：保证切换 handler 先 `navigate("/")` 提交、再 `setActive`（现有两处已是此模式，需确保所有切换路径都走它，并去掉对 `queueMicrotask` 时序的隐式依赖）。
- 该 effect 需在 Router context 内拿到 `useNavigate`，故放置为一个位于 Router 子树内、但能在 `server.key` 变化时被观测到的组件（具体实现见实现注记）。

**覆盖**：在线切换（dialog / popover / 任何调用 `setActive` 的入口）停在旧 `/:dir/session/:id` 上直接切 → 自动回 `/`，不再回放旧 directory / 幽灵 currentProjectID。

**未覆盖**：reload / 深链带跨后端旧 URL（boot 时 `server.key` 首次赋值，非"变化"，`defer` 的 effect 不触发）。见 4.2。

### 4.2 方案 B（防弹版）：`DirectoryLayout` 校验 directory 属于当前后端

覆盖**所有路径**（含 reload / 深链），是真正的安全网，不依赖任何"切换事件"。

**改动位置**：`packages/app/src/pages/directory-layout.tsx`（`Layout`，约 43-83 行）。

**要点**：

- 在 `resolved = decode64(params.dir)` 之后、`SDKProvider` 建立之前，向后端确认该 directory 可解析：命中当前后端的 `global_project_map` / `project_recent`，或 `sdk.path.get` / `project.current` 成功。
- 命中失败 → `navigate("/", { replace: true })` + toast（如"该项目属于另一后端，已回到首页"），不进入 `SDKProvider` / `SyncProvider`。
- 这样即使 URL 带 Mac 路径或幽灵 directory，也不会触发服务器侧 `mkdir '/Users/lx'`（EACCES）或 `attach(ghost)`（not registered）。

**覆盖**：方案 A 的全部场景 + reload / 深链 / 任何携带跨后端旧 URL 的启动。

### 4.3 实现注记（两方案共用）

- **优雅降级**：`packages/app/src/pages/session.tsx:599` 的 `sync.session.get(params.id)` 应捕获 "project not registered / session not found"，回退到该项目会话列表或 project home，而不是留空白 + 让事件流挂死（即 3.1 表里的 `global event disconnected` 与"中间空白"的直接对症）。与方案 B 配合，即便有漏网旧 URL 也不会硬失败。
- **currentProjectID 命名空间**：memory / search 等请求携带的 `currentProjectID`（`packages/app/src/utils/server.ts:146,388`）应取自 `packages/app/src/context/server.tsx:224` 的 `origin()` / `projects` 命名空间，并在切换时清空。本案例中幽灵 `e9458606` 即由此回放；方案 A/B 通过重置 URL 间接中和了它（URL 在 `/` 时无 directory 上下文，`currentProjectID` 不再被带出），但若后续仍有与 URL 解耦的 `currentProjectID` 持久化，需单独按命名空间处理。
- **服务端硬化（可选，非必须）**：`packages/opencode/src/storage/db.ts:543-545` 对未注册 project 返回结构化 NotFound（而非裸 throw），便于客户端走 4.3 的降级；服务器对 EACCES 目录的 bootstrap 快速失败、不污染连接。

### 4.4 落地顺序

1. **先做 4.2（DirectoryLayout 校验）+ 4.3 优雅降级**：立刻消除"空白/无响应"症状，且兜住 reload / 深链，独立可用。
2. **再做 4.1（结构性 `navigate("/")`）**：消除在线切换时的指针回放根因，UX 也更顺（切换即回首页，符合"项目列表按后端不同"的预期）。
3. 4.3 的 currentProjectID 命名空间与服务端硬化视情况补齐。

两方案合并后，相比初版五条修复已大幅精简：一个 effect + 一个校验守卫即可覆盖全部已知触发路径。

## 5. 短期解封（不改代码）

坏状态在客户端，**远端服务器无任何幽灵可清**（`e9458606` 不在服务器任何 DB），故无法纯靠服务器终端解封。解封步骤在 Mac 客户端：

1. 在桌面客户端先**回到根 `/`**（丢掉 `/:dir/session/:id` 这段旧状态）。
2. 再**选远端后端**（`status-popover` / `dialog-select-server` 的 `navigate("/")` 会把 URL 清成中立，`ServerKey` 重挂载时 Router 读到 `/` → 不再回放旧 directory / 幽灵 currentProjectID）。
3. 从侧栏点 polysimplify（`/home/lixiang/code/AI4research/polysimplify`），其会话列表会出现"利用因子化结构减少积分约化撒点"（`ses_0a930f79…`），点开即正常加载。

> 实测：仅做第 1、2 步即可成功，无需清理 localStorage。说明本案例的幽灵 `currentProjectID` 与旧 directory 均绑定在 URL 上下文里，URL 回 `/` 后即不再被发送。

若 GUI 已冻结（按钮无响应、中间空白）无法走第 1 步：退出/强杀 Mac 上 Aether 进程 → 清客户端持久化旧指针（浏览器版 DevTools `localStorage.clear()`；桌面版备份后清 `~/.local/share/aether/aether.settings` 与 `aether.workspace.*.dat` / `default.dat` 中残留的 currentProject / lastSession）→ 重开 app 确保地址在 `/` → 选远端 → 进 polysimplify。

## 6. 非目标

- 不在服务器侧为幽灵 `e9458606` 补建项目库或 `global_project_map` 行——即使补建，`Session.get` 仍会在空库里找不到会话，只是把 "not registered" 换成 "session not found"，中间依旧空白。
- 不修改项目 ID 算法（`sha1` 路径哈希）。该设计本身正确稳定，问题在前端指针未与后端绑定。
- 不在首阶段做服务端 EACCES 目录的 fs 容错之外的更大重构。

## 7. 验证方法

修复后应满足：

1. **在线切换**：停在 `/<mac-dir>/session/<mac-session>` 上直接切到远端 → 自动回 `/`，侧栏出现远端项目列表，无 EACCES、无 "not registered"。
2. **reload / 深链**：将浏览器 URL 设为 `/<base64-mac-dir>/session/<mac-session>` 后改默认后端为远端并刷新 → 命中 DirectoryLayout 校验 → 跳回 `/` + toast，无空白。
3. **会话加载失败降级**：构造一个指向远端不存在会话的 URL → 中间不空白，回退到会话列表或 project home，右上角按钮可用，SSE 不挂死。
4. **回归**：同后端深链 `/<dir>/session/<id>` 正常打开会话（方案 A 的 `defer` 与方案 B 的命中校验都不误伤）。
