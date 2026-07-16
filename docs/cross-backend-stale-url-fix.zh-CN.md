# 跨后端旧 URL 回放导致界面空白问题分析与修复方案

## 1. 问题概述

Mac 桌面客户端在本地后端工作一段时间后，切换到远端服务器后端时出现：

- 最左侧 project 边栏仍保持 Mac 本地打开的项目列表；
- 中间 session 显示界面及其他界面空白；
- 右上角按钮点击无响应。

经排查，**远端服务器与数据均健康**，问题纯粹由前端跨后端复用同一份客户端状态（URL 中的 directory / session，以及未按后端隔离的 project / recent 缓存等）导致。软件本身未更新，触发者是客户端侧的状态漂移。

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
- `packages/app/src/context/sdk.tsx:22-31`：SDK client 用该 directory 创建，后续请求会把它写入请求上下文（当前 SDK 通过 `x-opencode-directory` header 传递）。
- `packages/app/src/pages/session.tsx:599`：`sync.session.get(params.id)` 直接用 URL 里的 `params.id` 去当前后端取会话。
- `packages/app/src/context/global-sync/bootstrap.ts:184`：`sdk.project.current()` / `path.get()` 等均通过 scoped SDK 携带 URL 来的 directory 调用，从不校验该 directory / project 是否属于当前后端。

### 3.2 切换后端只改 `state.active`，不重置 URL

- `packages/app/src/context/server.tsx:181-183` `setActive`：仅 `setState("active", input)`，不动 URL、不清 session。
- `packages/app/src/app.tsx:283-290` `ServerKey` 是 `<Show when={server.key} keyed>`：`server.key` 变化时整棵子树（含 Router）重挂载，但 `@solidjs/router` 保留当前 URL，所以 `params.dir` / `params.id` 仍是旧后端的值，重挂载后被重新解码并应用到新后端。

### 3.3 后端切换入口分散，且现有"软重置"非结构性

部分交互入口在 `setActive` 前调了 `navigate("/")`，但依赖 `queueMicrotask` 排队和隐式时序：

- `packages/app/src/components/status-popover.tsx:279-280`：`navigate("/"); queueMicrotask(() => server.setActive(key))`
- `packages/app/src/components/dialog-select-server.tsx:357,360`：同上模式。

同时仍存在其他会改变 active 后端的路径，例如连接错误页切换、添加/替换服务器、移除当前服务器后的 fallback 等。这些路径不一定先清 URL，且不应依赖调用方各自记得做 `navigate("/")`。

reload / 深链 / 改持久化 active 或默认后端后刷新等路径也会绕过交互入口，旧 URL 可原样回放给新后端。

### 3.4 为什么"以前能用、现在不能用、且没更新"

触发条件是**数据/状态漂移**，不是代码回归：

- 7 月 12 日，客户端把会话 `ses_0a930f79…` 正确 scope 到 polysimplify（`7ea56ad…`），加载正常。
- 7 月 13 日重连时，同一会话被 scope 到幽灵 `e9458606…`（外加 Mac 目录 bootstrap 触发 EACCES）。会话本身和远端服务器都健康，变的是客户端侧"当前 directory / session / project 缓存"指针。
- 这个漂移能发生，正是 3.1–3.3 描述的结构性缺陷：指针不与后端绑定、切换/重连不校验。该缺陷平时状态没漂移就不触发，"以前没事"只是因为指针恰好对得上。软件不需要更新，只要客户端状态漂移就会复现。

## 4. 修复方案

目标：**directory / session / project 与后端绑定，切换或重连时校验并重置，旧指针绝不跨后端回放。**

### 4.1 方案 A：统一后端切换并结构性回到 `/`

覆盖**在线切换后端**场景。核心要求是：所有 active 后端变化必须收口到唯一切换 API：先把路由替换成中立根路径，再更新 active 后端，避免旧 `/:dir/session/:id` 被新后端读取。组件、连接错误页、添加/替换/移除服务器后的 fallback 等入口不得直接调用底层 `setActive`，也不得通过 `server.add()` / `server.remove()` 的隐式激活绕过 URL reset。

**改动位置**：

- `packages/app/src/app.tsx`：定义唯一的后端切换路径，并处理 Router 外入口的中立 URL reset。
- `packages/app/src/context/server.tsx`：将底层 active mutation 私有化或限制为内部 reducer；对外只暴露统一切换 API。`add` / `remove` 只负责服务器列表变更，不应隐式激活；需要激活或 fallback 时，由调用方显式走统一切换 API。
- server 选择组件：所有入口改为调用同一个切换路径，不再自行组合 `navigate()`、`queueMicrotask()` 与 `setActive()`。

**要点**：

- 当前 `ServerProvider` / `ConnectionGate` 位于 Router 外层，不能在 `server.tsx` 或 `ConnectionGate` 中直接调用 `useNavigate()`；Router 外入口需要由 `AppInterface` 提供基于 `basePath` 的中立 URL reset（例如 `history.replaceState`），或调整组件层级使统一切换 helper 获得 Router context。
- 不要把 `createEffect(on(() => server.key, ...), { defer: true })` 放在 `ServerKey` 的 keyed 子树内；该子树会随 `server.key` 重挂载，effect 可能把变化当成首次执行并跳过。
- 如果使用响应式 reset 组件，它必须位于 Router context 内、但不位于 `ServerKey` keyed 子树内，才能在 key 变化前后持续观察同一个组件实例。
- 统一切换语义应是同步顺序：先把 URL 替换成中立根路径，再更新 active 后端；禁止依赖 `queueMicrotask` 作为正确性条件。
- 需要覆盖当前所有 active 变更入口：服务器切换、连接错误页切换、添加服务器后的"设为当前"流程、替换服务器配置后的 active 保持或切换流程、移除当前服务器后的 fallback，以及任何直接调用 `setActive`、通过 `server.add()` 隐式激活或通过 `server.remove()` 隐式 fallback 的路径。这些入口只能调用统一切换 API；若业务需要"添加后切换"或"移除当前后 fallback"，应拆成列表变更 + 统一切换 API 两步。

**覆盖**：在线切换时，停在旧 `/:dir/session/:id` 上直接切到另一后端 → 先回 `/`，再挂载新后端数据，不再回放旧 directory / session。

**未覆盖**：reload / 深链携带跨后端旧 URL。启动时没有"切换事件"可依赖，必须由 4.2 的目录守卫兜底。

### 4.2 方案 B：`DirectoryLayout` 无副作用校验 directory 属于当前后端

覆盖 reload / 深链 / 在线切换后遗留 URL 等**旧 directory 不属于当前后端**的路径，是真正的 directory 安全网，不依赖任何"切换事件"。若两个后端注册了相同绝对路径，directory 校验会放行，URL 中旧 session 仍必须由 4.3 的会话降级兜底。

**改动位置**：`packages/app/src/pages/directory-layout.tsx`（`Layout`，约 43-83 行）。

**要点**：

- 在 `resolved = decode64(params.dir)` 之后、`SDKProvider` 建立之前完成校验；校验处于 loading / unknown / failed 状态时都不能创建带该 directory 的 scoped SDK。
- 守卫应使用显式状态机或 `createResource` keyed by `server.key + resolved`：只有校验结果为 pass 才渲染 `SDKProvider` / `SyncProvider`；旧请求返回时若 key 已变化必须丢弃，避免竞态误放行。
- 校验必须无副作用：不要调用带目标 directory 的 `sdk.path.get()`、`project.current()`、`session.list()` 等接口，因为它们会 bootstrap 旧目录，正是要阻止的副作用。
- 守卫必须使用**无 directory 作用域的 fresh global SDK** 查询当前后端。推荐使用语义明确的已注册目录集合接口（如 `project.directories()`，或等价的 project worktree + sandbox + recent directory 聚合接口）判断 `resolved` 是否属于当前后端已知目录；不要混用语义较窄的 `project.list()` 作为唯一依据。该 client 的请求不得携带目标 `resolved` directory，也不得触发 scoped bootstrap。
- 实现时要确认 SDK transport 的 directory 来源：scoped SDK 会把 directory 写入请求上下文（当前为 `x-opencode-directory` header），因此守卫阶段不能复用 `SDKProvider directory={() => resolved}` 产生的 client。守卫只能使用当前 server 的 global client；只有校验通过或存在本次用户打开意图时，才创建 scoped SDK。
- 不能直接信任 `globalSync.project/recent` 的持久化缓存；该缓存当前不按 `server.key` 隔离，启动初期可能仍是旧后端数据。缓存可用于占位展示，但守卫判定必须等待当前后端 fresh 查询结果；若 fresh 结果未返回，不得创建 scoped SDK。
- 在校验结果为 loading / unknown / failed 时，只能显示 loading / fallback UI，不能渲染任何会读取 project、recent、session 或 path 的子组件，避免被污染的 recent / project 缓存提前触发 scoped SDK 或 bootstrap。
- 判定为无用户意图的旧 URL 后 → `navigate("/", { replace: true })` + toast（如"该项目属于另一后端，已回到首页"），不进入 `SDKProvider` / `SyncProvider`。
- 用户主动打开新目录是例外路径：例如通过"打开目录"对话框、显式命令或受控 action 进入时，可以允许 scoped SDK 创建并由当前后端 bootstrap。该意图必须由本次交互产生的显式 intent 标记证明，例如一次性 `openIntent` token、router state 或受控 action 参数；该标记应绑定 `server.key + directory`，使用后立即消费。普通 URL 参数、recent 缓存、持久化路由状态、reload / 深链都不能被视为用户意图。
- 打开目录入口必须同步改造为受控 intent 入口：跳转到未注册目录前先写入一次性 intent；刷新、复制深链或从持久化状态恢复时没有 intent，应按旧 URL 拦截。
- directory 命中只能证明该目录属于当前后端的已知范围；若两个后端注册了相同绝对路径，仍需由 session 加载降级处理 URL 中的旧 session。
- 这样即使 URL 带 Mac 路径或幽灵 directory，也不会触发服务器侧 `mkdir '/Users/lx'`（EACCES）或 `attach(ghost)`（not registered）。

**覆盖**：reload / 深链 / 在线切换后遗留 URL 中旧 directory 不属于当前后端的场景；同时保留用户主动打开当前后端新目录的能力。它不单独保证旧 session id 可用，session 相关失败由 4.3 的会话降级处理。

### 4.3 会话失败降级与实现注记

- **会话优雅降级**：这是完整修复的必要防线，不是展示优化。降级逻辑应放在 `sync/session` 数据层或统一异步错误处理层，而不是分散在页面组件里。它需要覆盖 `get`、`sync`、`todo`、`diff`、`messages`、`history` 等所有会话相关异步链路；任一链路遇到 "project not registered"、"session not found"、跨后端目录错误或等价 404 / 作用域错误时，应统一 toast 并导航到项目首页或 `/`，保持全局事件流、顶部按钮和侧栏可用。
- **同路径跨后端**：如果两个后端都已注册同一个绝对路径，`DirectoryLayout` 只能确认 directory 属于当前后端，不能确认 URL 中的 session id 属于当前后端；这种情况必须依赖会话降级避免中间区域空白。
- **判定优先级**：`DirectoryLayout` 守卫的放行依据优先级为：本次用户打开 intent > 当前后端 fresh global 查询命中 > 拦截并回 `/`。持久化缓存永远不能作为放行依据。
- **缓存命名空间**：`globalSync.project` / `globalSync.recent` 的持久化 key 应按 `server.key` 命名空间化，避免首页和 recent 展示被其他后端污染。该项改善展示一致性，但不能替代 `DirectoryLayout` 的 fresh 守卫，也不能替代会话降级。
- **服务端边界**：服务端 `db.ts:543-545` 的 not-registered 抛错和 bootstrap EACCES 是旧前端指针触发后的被动结果。前端守卫修复后，不需要通过补建幽灵项目库解决；服务端可以继续拒绝未注册 project。守卫实现应通过请求检查确认 fresh global 查询不携带 `x-opencode-directory`。

### 4.4 落地顺序

1. **先做 4.2（DirectoryLayout 无副作用守卫）**：用当前后端 fresh global 数据判断 directory 是否属于当前后端，并在校验完成前阻止 `SDKProvider` 创建，兜住 reload / 深链 / 旧 URL 回放中的跨后端 directory。
2. **同步改造用户打开目录 intent**：所有允许 bootstrap 新目录的入口必须写入一次性 intent，避免守卫误拦合法新目录，同时确保刷新和深链不会继承该权限。
3. **补 4.3 会话异步降级**：在 `sync/session` 数据层或统一错误处理层覆盖 get / sync / todo / diff / messages / history 等失败路径，避免同路径不同后端或旧 session 导致中间区域空白和交互不可用。
4. **再做 4.1（统一 server active 切换）**：所有后端切换路径先重置到中立根路径，再变更 active；底层 active mutation 不对组件直接暴露，`add` / `remove` 不隐式激活，消除在线切换时的指针回放。
5. **最后做缓存命名空间化**：隔离 `globalSync.project/recent` 展示状态，避免跨后端污染首页和 recent 状态；守卫仍只信当前后端 fresh 查询结果，不用缓存作为放行依据。

上述防线合并后，在线切换、reload、深链、缓存污染和异步会话失败都有独立防护。

## 5. 短期解封（不改代码）

坏状态在客户端，**远端服务器无任何幽灵可清**（`e9458606` 不在服务器任何 DB），故无法纯靠服务器终端解封。解封步骤在 Mac 客户端：

1. 在桌面客户端先**回到根 `/`**（丢掉 `/:dir/session/:id` 这段旧状态）。
2. 再**选远端后端**（`status-popover` / `dialog-select-server` 的 `navigate("/")` 会把 URL 清成中立，`ServerKey` 重挂载时 Router 读到 `/` → 不再回放旧 directory / 幽灵 project ID）。
3. 从侧栏点 polysimplify（`/home/lixiang/code/AI4research/polysimplify`），其会话列表会出现"利用因子化结构减少积分约化撒点"（`ses_0a930f79…`），点开即正常加载。

> 实测：仅做第 1、2 步即可成功，无需清理 localStorage。说明本案例的幽灵 project ID 与旧 directory 均绑定在 URL 上下文里，URL 回 `/` 后即不再被发送。

若 GUI 已冻结（按钮无响应、中间空白）无法走第 1 步：退出/强杀 Mac 上 Aether 进程 → 清客户端持久化旧指针（浏览器版 DevTools `localStorage.clear()`；桌面版备份后清 `~/.local/share/aether/aether.settings` 与 `aether.workspace.*.dat` / `default.dat` 中残留的 directory / session / project / recent 状态）→ 重开 app 确保地址在 `/` → 选远端 → 进 polysimplify。

## 6. 非目标

- 不在服务器侧为幽灵 `e9458606` 补建项目库或 `global_project_map` 行——即使补建，`Session.get` 仍会在空库里找不到会话，只是把 "not registered" 换成 "session not found"，中间依旧空白。
- 不修改项目 ID 算法（`sha1` 路径哈希）。该设计本身正确稳定，问题在前端指针未与后端绑定。
- 不改服务端代码：根因在前端指针未与后端绑定，服务端 `db.ts:543-545` 的 not-registered 抛错与 EACCES bootstrap 均为被动受害，无需改动。

## 7. 验证方法

修复后应满足：

1. **在线切换**：停在 `/<mac-dir>/session/<mac-session>` 上直接切到远端 → 自动回 `/`，侧栏出现远端项目列表，无 EACCES、无 "not registered"。
2. **reload / 深链**：将浏览器 URL 设为 `/<base64-mac-dir>/session/<mac-session>` 后改默认后端为远端并刷新 → DirectoryLayout 用当前后端 fresh 全局数据判定不命中 → 跳回 `/` + toast，无空白。
3. **fresh global 守卫**：构造旧 directory URL，确认守卫请求不携带该 directory，不携带 `x-opencode-directory`，且不会触发 `path.get()`、`project.current()`、`session.list()` 或服务器 bootstrap。
4. **active API 收口**：扫描所有 active 变更路径，确认组件、`ConnectionGate`、添加/替换/移除服务器 fallback 均不直接调用底层 `setActive`，而是走统一切换 API。
5. **会话加载失败降级**：构造一个指向远端不存在会话的 URL，并分别触发 get / sync / todo / diff / messages / history 请求 → 中间不空白，回退到会话列表或 project home，右上角按钮可用，SSE 不挂死。
6. **同路径跨后端旧 session**：两个后端都注册同一绝对路径时，旧 URL 的 directory 守卫可放行，但旧 session id 不存在于当前后端时必须触发会话降级，不得空白。
7. **缓存隔离**：预置另一个后端的 project / recent 缓存，确认页面可短暂展示占位，但守卫不会因此创建 scoped SDK 或放行 directory；项目列表和 recent 状态最终只显示当前后端数据。
8. **用户主动打开新目录**：通过受控打开入口选择一个当前后端尚未注册的新目录时，应允许 bootstrap 并进入项目；刷新同一 URL 或复制深链打开时没有 intent，应被守卫拦截。
9. **回归**：同后端深链 `/<dir>/session/<id>` 正常打开会话。
