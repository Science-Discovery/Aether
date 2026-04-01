# Aether 当前会话（Session）架构梳理

本文基于当前工作区代码如实整理，重点覆盖：

- 后端以 `session` 为核心的数据模型、路由、事件与运行时循环
- web-ui 如何围绕 session 做加载、缓存、预取、展示与交互
- session 在 `fork / revert / summarize(compaction) / todo / permission / question / review diff` 等分支逻辑中的位置

本文不是产品设计文档，而是“按当前实现”做的代码级架构说明。

## 1. 总体判断

当前程序的 session 体系不是“单纯的聊天记录表”，而是一个同时承担以下职责的核心聚合对象：

- 作为一次 AI 协作工作的边界
- 作为消息、分片 part、todo、diff、权限请求、问题请求的归属单位
- 作为 web-ui 页面、侧边栏、review 面板、terminal、prompt composer 的主路由单位
- 作为后端 AI 执行循环 `SessionPrompt.loop()` 的运行单位
- 作为 event/bus/sync 投影和前端 SSE 增量同步的主聚合键

从代码结构看，session 是“项目实例（project instance）内最核心的业务实体”。

## 2. 核心对象关系

从后端模型看，大致关系如下：

```text
Project / Worktree / Workspace
  └─ Session
      ├─ Message(user | assistant)
      │   └─ Part(text | file | tool | reasoning | patch | compaction | subtask ...)
      ├─ Todo[]
      ├─ PermissionRequest[]
      ├─ QuestionRequest[]
      ├─ Summary(diff stats)
      ├─ Revert state
      └─ Share / Archive / Parent-child(fork) metadata
```

几个关键事实：

- `Session` 绑定到 `project_id`，并记录实际 `directory`
- `Session` 可选地绑定 `workspace_id`
- `Session` 支持 `parent_id`，因此天然支持 fork 树
- `Message` 归属某个 `session_id`
- `Part` 归属某个 `message_id` 和 `session_id`
- UI 里看到的大多数运行细节，实际都来自 message/part 的增量更新

## 3. 后端：session 作为核心聚合

## 3.1 请求入口与实例边界

服务总入口在 `packages/opencode/src/server/server.ts`。

请求在进入 session 路由前，会先经过两层上下文绑定：

1. `directory` 或 `x-opencode-directory`
2. `workspace` 或 `x-opencode-workspace`

然后进入：

- `WorkspaceContext.provide(...)`
- `Instance.provide(...)`

这意味着 session 的所有读写，都运行在“某个实例目录”的上下文中，而不是纯全局静态环境。

这层设计直接影响：

- `Session.create()` 默认把 `directory` 设为当前 `Instance.directory`
- `Session.list()` 默认只列当前 project/instance 下的 session
- tool、snapshot、file read、shell、worktree 等操作都天然围绕当前实例目录展开

如果开启 experimental workspace，`packages/opencode/src/control-plane/workspace-router-middleware.ts` 会把请求代理到远程 workspace，因此 session 的“执行位置”也可以随 workspace 切换。

## 3.2 持久化模型

核心表定义在 `packages/opencode/src/session/session.sql.ts`。

### `session`

字段重点如下：

| 字段 | 含义 |
| --- | --- |
| `id` | session 主键 |
| `project_id` | 所属项目 |
| `workspace_id` | 所属 workspace，可空 |
| `parent_id` | fork 父 session，可空 |
| `slug` | 短标识 |
| `directory` | 本次 session 所在目录 |
| `title` | 标题 |
| `version` | 安装版本 |
| `share_url` | 分享链接 |
| `summary_*` | 当前 session diff 汇总 |
| `revert` | 当前 revert 状态 |
| `permission` | 会话级权限 ruleset |
| `time_created / updated / compacting / archived` | 时间字段 |

### `message`

- 一条 message 只存 message 本身的元信息，实际内容由 part 补足
- `data` 列是 JSON
- 通过 `(session_id, time_created, id)` 建索引，支持分页和顺序流

### `part`

- part 是真正承载消息内容和执行细节的最小单位
- 文本、文件、推理、工具调用、patch、step 边界、compaction、subtask 等都落成 part

### `todo`

- todo 也是 session 级数据，但没有走 sync event 投影持久化那一套
- 是直接写 `TodoTable` 再发 bus 事件

### `permission`

- 权限规则持久化是 project 级，不是 session 级
- session 上保存的是“当前会话附着的 ruleset”

## 3.3 session 的领域模型

`packages/opencode/src/session/index.ts` 提供了 session 领域 API。

几个关键点：

- `Session.Info` 是前后端共用的会话主信息形状
- `Session.createNext()` 负责生成真正的 session 记录
- `Session.fork()` 会复制原 session 某个消息点之前的 message/part 到新 session
- `Session.messages()` 基于 `MessageV2.stream()` 把当前 session 的完整消息流取回
- `Session.touch()` 只更新 `time.updated`
- `Session.setTitle / setArchived / setPermission / setRevert / setSummary` 都通过 sync event 更新

### 重要实现特征

1. session/message/part 的“写”不是直接改表，而是优先发 `SyncEvent`

2. 再由 projector 把事件投影回 SQLite

3. 这使 session 子系统呈现出“轻量 event sourcing + 投影”的形态

但它不是彻底统一的 event sourcing，因为：

- `Todo`
- `Permission`
- `Question`
- `SessionStatus`

这些并没有全部走同一套投影持久化机制。

## 3.4 SyncEvent 与 projector：session 的真实写路径

核心文件：

- `packages/opencode/src/sync/index.ts`
- `packages/opencode/src/session/projectors.ts`
- `packages/opencode/src/server/projectors.ts`

真实写链路是：

```text
领域函数
  -> SyncEvent.run(...)
  -> projector
  -> SQLite 表
  -> Bus / GlobalBus 发布最新事件
```

例如：

- `Session.updateMessage()` 发 `message.updated`
- `Session.updatePart()` 发 `message.part.updated`
- `Session.setTitle()` 发 `session.updated`

对应 projector 会：

- `session.created` -> `insert SessionTable`
- `session.updated` -> `update SessionTable`
- `message.updated` -> `insert/update MessageTable`
- `message.part.updated` -> `insert/update PartTable`

所以从实现上说：

- message/part 是“事件驱动写入数据库”的
- web-ui 看到的 SSE 更新，与数据库里的最终结果，来源于同一条事件链

这也是该架构很关键的一点。

## 3.5 Message + Part：真正的会话执行载体

核心定义在 `packages/opencode/src/session/message-v2.ts`。

### message 分两类

- `User`
- `Assistant`

### part 类型非常丰富

当前 part 类型包括：

- `text`
- `file`
- `agent`
- `tool`
- `reasoning`
- `step-start`
- `step-finish`
- `patch`
- `snapshot`
- `retry`
- `compaction`
- `subtask`

这意味着系统不是把一次 assistant 回复当成“大字符串”，而是把整个执行过程拆成结构化事件片段。

对 web-ui 来说，这直接带来两个后果：

1. UI 能实时显示推理、工具输入输出、文件附件、流式文本
2. UI 可以选择性忽略某些内部 part，例如 `patch / step-start / step-finish`

## 3.6 SessionPrompt：会话运行时总调度器

核心文件是 `packages/opencode/src/session/prompt.ts`。

`SessionPrompt` 是整个 session 运行态的总入口，负责：

- 创建 user message
- 决定当前 agent/model/variant
- 解析用户附带的 file、agent、resource、image part
- 启动或恢复 session loop
- 在 loop 中决定是正常回复、处理 subtask、处理 compaction、还是结束

### 关键状态

`SessionPrompt` 内部有一个按 `sessionID` 维护的 `state()`：

- `abort: AbortController`
- `callbacks: resolve/reject[]`

这意味着：

- 一个 session 同时只能有一个活跃处理循环
- 如果已有循环在跑，后续请求不会重新开 loop，而是挂在 callbacks 上等待已有循环结果
- `cancel(sessionID)` 会中断该 session 的当前执行

这就是“session 是执行并发控制单位”的直接体现。

## 3.7 createUserMessage：把前端输入转成后端真实消息

`createUserMessage()` 不是简单地把 prompt 文本落库，它会做大量规范化：

- 解析 agent
- 解析 model / variant
- 可选注入知识库 RAG 结果到 system
- 处理 file part
- 对 `text/plain` 文件或目录，实际会先走 Read tool，再把读取结果变成 synthetic text part
- 对 `agent` part，会生成额外 synthetic text，引导后续 task/subagent 流程

也就是说，前端发来的 prompt part 并不是最终入库形态；后端会做二次展开。

## 3.8 loop：session 的 AI 执行主循环

`SessionPrompt.loop()` 是最关键的运行时逻辑。

每一轮 loop 大致做这些事：

1. 把 session status 设为 `busy`
2. 读取当前 session 历史，并通过 `MessageV2.filterCompacted()` 过滤压缩后的可见历史
3. 找出最近 user、assistant、已完成 assistant、待处理 task
4. 若 assistant 已正常结束，则退出 loop
5. 第一轮时尝试 `ensureTitle()` 自动生成标题
6. 解析当前模型
7. 处理待执行 `subtask`
8. 处理待执行 `compaction`
9. 判断上下文是否溢出，需要则自动创建 compaction user message
10. 正常进入 agent 执行

正常执行阶段又会：

- 生成 assistant message 壳
- 解析工具集合 `resolveTools()`
- 按需注入 `StructuredOutput` tool
- 插入计划模式 reminder / build switch reminder
- 组装 system prompt
- 调用 `SessionProcessor.process(...)`

这说明 session 不是“每个请求一次性生成一次响应”，而是一个可多轮内部循环的状态机。

## 3.9 SessionProcessor：把模型流输出落成消息事实

核心文件：`packages/opencode/src/session/processor.ts`

它负责消费 `LLM.stream()` 的事件流，并把每个阶段转成 message/part 更新：

- `reasoning-start/delta/end` -> reasoning part
- `tool-input-start` -> pending tool part
- `tool-call` -> running tool part
- `tool-result` -> completed tool part
- `tool-error` -> error tool part
- `start-step` -> snapshot + `step-start`
- `finish-step` -> token/cost 统计 + `step-finish` + patch + summary 触发
- `text-start/delta/end` -> text part 流式拼接

同时它还负责：

- context overflow 检测
- retry 状态写入 `SessionStatus`
- permission/question 拒绝后的 `blocked` 判定
- tool doom-loop 检测

换句话说，`SessionProcessor` 是“把大模型事件流变成 session 事实流”的组件。

## 3.10 SessionStatus：运行态状态机

`packages/opencode/src/session/status.ts`

状态只有三类：

- `idle`
- `busy`
- `retry`

特点：

- 状态保存在 `InstanceState` 内存里，不是持久化表
- SSE 会把状态广播给前端
- session 空闲时会从 map 中移除，所以“没有状态”在语义上等于 `idle`

这也是为什么 web-ui 要经常把“未命中状态”解释为 idle。

## 3.11 summary / diff / review：session 级变更视图

核心文件：`packages/opencode/src/session/summary.ts`

session 创建时会尽量记录一个 baseline snapshot 到 `session_diff_from`。

后续每次关键 assistant step 完成后，会：

- 计算从 baseline 到当前工作区的 diff
- 写入 `Storage["session_diff", sessionID]`
- 更新 session.summary 的 additions/deletions/files
- 广播 `session.diff`

这套逻辑非常关键，因为 web-ui 的 session review 面板直接依赖它。

重要细节：

- 如果有 baseline，就优先做“完整 diff”
- 如果没有 baseline，才退化为从 step snapshot 推算
- 用户在 AI 第一次操作前手工改过文件，也尽量纳入 review 范围

## 3.12 revert / unrevert：会话级回滚

核心文件：`packages/opencode/src/session/revert.ts`

它不是简单删消息，而是同时处理：

- 找到目标 message/part
- 收集后续 patch
- 通过 snapshot 回滚文件
- 更新 session.revert
- 重算 session diff summary

当 session 之后继续运行时，`SessionRevert.cleanup()` 会真正把被 revert 掉的 message/part 从事件流中清理掉。

所以 revert 是“两阶段”的：

1. 先标记 session.revert + 恢复文件
2. 后续清理消息历史

web-ui 也是围绕这个模型做“revert dock”和可恢复提示的。

## 3.13 compaction：session 压缩不是 UI 功能，而是运行时自救机制

核心文件：`packages/opencode/src/session/compaction.ts`

compaction 的职责：

- 当上下文接近模型限制时自动总结历史
- 用 summary assistant message 压缩旧上下文
- 在必要时 replay 最近关键用户消息，确保任务能继续
- 触发旧 tool output prune，减小上下文负担

注意这里的 compaction 不是单独维护摘要表，而是直接写进当前 session 的 message 流里。

因此：

- 历史压缩本身也是 session 历史的一部分
- `MessageV2.filterCompacted()` 负责筛出压缩后仍需要参与推理的消息范围

## 3.14 todo / permission / question：都围绕 session 挂载

### todo

`packages/opencode/src/session/todo.ts`

- 以 `session_id` 为键
- 更新时整体替换
- 发 `todo.updated`

### permission

`packages/opencode/src/permission/index.ts`

- tool 调用时可触发 `Permission.ask(...)`
- pending request 按 session 挂载
- reply 后广播 `permission.replied`
- `always` 会转成 project 级已批准规则

### question

question 路由在 `packages/opencode/src/server/routes/question.ts`，模式与 permission 类似，也是 session 级请求。

这三类信息一起决定了：

- session 当前是否 blocked
- web-ui composer 区是否应切到 question/permission/todo dock

## 3.15 fork：session 树形结构是真实存在的

`Session.fork()` 会：

- 新建 child session
- 复制原 session 指定 message 之前的 message/part
- 重建 assistant `parentID` 引用关系

所以 fork 不是“共享父会话只打个引用”，而是物理复制到新的 session 流。

这也解释了前端为什么：

- 侧边栏要维护 parent/child session map
- permission/question 查找要沿 session 子树找，而不只看当前 session 自己

## 4. web-ui：session 为中心的前端架构

## 4.1 基本结构不是“页面直接请求接口”，而是三层协作

web-ui 侧的 session 架构大致分三层：

```text
GlobalSDK
  -> 维护全局 SSE 连接，接收 directory 级事件

GlobalSync
  -> 维护按 directory 划分的 child store

Sync
  -> 在当前目录下提供 session/message/part/todo/diff/history 的读写与缓存策略

Session Page
  -> 只消费 Sync / GlobalSync 的响应式状态
```

这是当前前端理解 session 的最重要切入点。

## 4.2 GlobalSDK：全局事件入口

核心文件：`packages/app/src/context/global-sdk.tsx`

它会建立到 `/global/event` 的 SSE 长连接。

事件形状是：

```text
{ directory, payload }
```

所以前端收到的不是单一 session 流，而是“带目录标签的全局事件流”。

`GlobalSDK` 做了几件重要的性能处理：

- 对 `session.status`、`lsp.updated`、`message.part.updated` 做 coalescing
- 如果某个 part 已收到完整 `message.part.updated`，会丢弃旧的 `message.part.delta`
- 用 16ms frame 粒度批量 flush 事件
- 15s heartbeat 超时重连

这层是整个 web-ui session 实时感的基础。

## 4.3 GlobalSync：按目录拆分的全局 store

核心文件：

- `packages/app/src/context/global-sync.tsx`
- `packages/app/src/context/global-sync/child-store.ts`
- `packages/app/src/context/global-sync/event-reducer.ts`
- `packages/app/src/context/global-sync/bootstrap.ts`

它做的事情是：

- 维护一个 global store：project/provider/config/path 等全局信息
- 为每个目录维护一个 child store
- child store 内保存该目录下的 session、message、part、todo、diff、permission、question、vcs 等
- 收到事件后，把事件分发到对应 directory store

也就是说，web-ui 没有做“全应用唯一 session normalized store”，而是采用“目录分片 store”。

这跟后端 `Instance.directory` 语义是对齐的。

## 4.4 child store 的 session 缓存与淘汰

child store 的状态定义在 `packages/app/src/context/global-sync/types.ts`。

与 session 相关的缓存主要是：

- `session`
- `session_status`
- `session_diff`
- `todo`
- `message`
- `part`
- `permission`
- `question`

缓存淘汰策略在：

- `packages/app/src/context/global-sync/session-cache.ts`
- `packages/app/src/context/sync.tsx`

重要参数：

- 目录 store 最多 30 个
- session cache 默认最多保留 40 个活跃 session
- 被淘汰时会连 message/part/todo/diff/permission/question/status 一起丢

这说明前端的 session 视图是“缓存型 + 按需恢复型”，不是无限常驻内存。

## 4.5 Sync：当前 session 页实际依赖的读写接口

核心文件：`packages/app/src/context/sync.tsx`

它是在当前 `sdk.directory` 上，对 `GlobalSync.child(directory)` 再封装一层更贴近 session 页的 API。

主要职责：

- `session.sync(sessionID)` 拉 session info + 首屏消息
- `session.diff(sessionID)` 拉 session diff
- `session.todo(sessionID)` 拉 todo
- `session.history.loadMore(sessionID)` 拉更早消息
- `session.optimistic.add/remove(...)` 做 optimistic user message
- `session.archive(...)` 归档

### 重要的消息加载策略

首屏和历史页不是同一个 page size：

- 首屏：80 条
- 继续向上翻历史：每批 200 条

并且会维护：

- `limit`
- `cursor`
- `complete`
- `loading`

这些 meta 不直接存在 child store，而存在 `SyncProvider` 自己的 `meta` store 中。

## 4.6 message/part 在前端并非原样展示

前端会主动跳过这几类 part：

- `patch`
- `step-start`
- `step-finish`

跳过点在：

- `packages/app/src/context/global-sync/event-reducer.ts`
- `packages/app/src/context/sync.tsx`

这很关键，因为：

- 后端 part 是“运行事实”
- 前端 session timeline 展示的是“经过裁剪的运行事实”

因此 UI 看到的 session 不是数据库 part 的完整镜像，而是面向交互的投影。

## 4.7 sidebar 预取：web-ui 对 session 的处理非常主动

核心逻辑在 `packages/app/src/pages/layout.tsx` 和 `packages/app/src/pages/layout/sidebar-items.tsx`。

当前实现会在以下时机主动预取 session message：

- 当前 session 附近的相邻 session
- 鼠标 hover 某个 session
- 键盘切换 session
- 侧边栏聚焦 session

预取参数：

- 每次预取 200 条 message
- 每目录并发 2 个
- 待处理队列最多 10 个
- 每目录最多保留 10 个预取过的 session
- 预取 TTL 15 秒

所以侧边栏里的 session 列表不是纯导航，而是 session 数据预热器。

## 4.8 Session 页面：围绕 sessionKey 建立整套局部 UI

核心文件：`packages/app/src/pages/session.tsx`

页面状态首先由 `sessionKey = dir + "/" + id?` 定义。

这会驱动：

- 文件 tab 组
- review panel 开关
- terminal 视图
- prompt handoff
- 历史滚动窗口

页面主要从 `sync.data` 读取：

- `sync.session.get(params.id)` -> session info
- `sync.data.message[params.id]` -> message 列表
- `sync.data.part[messageID]` -> part 列表
- `sync.data.session_diff[params.id]` -> session diff
- `sync.data.session_status[params.id]` -> 运行状态
- `sync.data.todo[params.id]` / `globalSync.data.session_todo[params.id]` -> todo

### 页面里的关键派生状态

- `userMessages`
- `visibleUserMessages`
- `lastUserMessage`
- `revertMessageID`
- `historyMore`
- `historyLoading`
- `diffsReady`

其中 `visibleUserMessages` 会根据 `session.revert.messageID` 过滤掉被 revert 后不可见的 turn。

这点和后端 `session.revert` 语义是严格对应的。

## 4.9 Session 历史窗口不是简单无限列表

`packages/app/src/pages/session.tsx` 内的 `createSessionHistoryWindow()` 专门控制时间线历史窗口。

策略是：

- 初次仅渲染最近 10 个 user turn
- 向上滚动时按批次回填
- 接近顶部时预取更老 message
- 点击“load earlier”时，先把已有缓存完全露出，再继续向服务端取历史

另外，`packages/app/src/pages/session/message-timeline.tsx` 还有一层 staged mount：

- 先渲染很小的窗口
- 再分帧补齐更多 DOM

这说明 session 页面为长历史做了专门的渲染优化。

## 4.10 Prompt 状态按 `(dir, sessionID)` 持久化

核心文件：`packages/app/src/context/prompt.tsx`

PromptProvider 并不是单例字符串输入框，而是：

- 以 `(dir, sessionID)` 为 key 建 prompt session
- 最多缓存 20 个 prompt session
- 同时持久化 prompt 内容、cursor、context items

这带来的效果：

- 切换 session 再切回来，未提交 prompt 还能保留
- 新建 session 页和已有 session 页各自有独立 prompt 草稿
- 文件 comment/context item 也是 session 级绑定

## 4.11 发送 prompt 的真实前端链路

核心文件：

- `packages/app/src/components/prompt-input/submit.ts`
- `packages/app/src/components/prompt-input/build-request-parts.ts`

真实链路大致如下：

1. 读取当前 prompt、image、context、agent、model、variant
2. 如果当前页还没有 session，则先 `session.create()`
3. 如需新建 worktree，先创建 worktree，再切换目录 client
4. 构造 `FollowupDraft`
5. 通过 `buildRequestParts()` 把 prompt/context/file/image/open tabs/选中文本转成 request parts
6. 先在前端做 optimistic user message
7. 调用 `client.session.promptAsync(...)`
8. 之后完全依赖 SSE 把真实 message/assistant/part 更新回来

这里非常关键的一点是：

- 前端并不等待 `session.prompt` 的完整响应
- 它默认走 `promptAsync`
- 然后依赖 SSE 驱动 session timeline 逐步长出来

所以 web-ui 的 session 体验本质上是“event-driven streaming UI”。

## 4.12 optimistic message 只覆盖用户消息，不覆盖 assistant 结果

`SyncProvider` 里有专门的 optimistic 逻辑：

- `session.optimistic.add`
- `session.optimistic.remove`

它只为 user message 提前占位，并附上 optimistic part。

assistant 回复、tool part、reasoning part 都不做 optimistic，而是等待后端 SSE。

这符合当前架构，因为 assistant 侧的真实执行细节只有后端 loop 才知道。

## 4.13 composer region 会根据 session 状态切换 dock

核心文件：

- `packages/app/src/pages/session/composer/session-composer-state.ts`
- `packages/app/src/pages/session/composer/session-composer-region.tsx`
- `packages/app/src/pages/session/composer/session-request-tree.ts`

composer 下方可能出现的 dock 有：

- todo dock
- permission dock
- question dock
- followup dock
- revert dock

尤其重要的是，permission/question 的查找不是只看当前 session，而是会沿 session child tree 搜索。

这和后端 fork 的物理 session 树相匹配。

换句话说，web-ui 已经把“fork 出来的 child session 仍属于当前工作流延伸”编码进交互逻辑里了。

## 4.14 review 面板其实有四种“变更视角”

`packages/app/src/pages/session.tsx` 中的 review 不是只有 session diff 一种。

当前支持：

- `git`
- `branch`
- `session`
- `turn`

其中：

- `session` 依赖 `session.diff`
- `turn` 依赖最后一条 user message 的 `summary.diffs`
- `git/branch` 走独立的 VCS diff API

因此 session 在 review 体系中承担的是“AI 工作过程变更视图”，不是整个项目的唯一 diff 来源。

## 4.15 sidebar 中 session 的展示是 session-centric 的

侧边栏 session item 在 `packages/app/src/pages/layout/sidebar-items.tsx`。

session item 上会综合展示：

- 标题
- working/busy/retry 状态
- permission 待处理状态
- error/unseen 状态
- hover preview 时的 user message 导航

hover preview 依赖已缓存的 `sessionStore.message[session.id]`，因此又和预取链路紧密耦合。

## 5. 端到端链路梳理

## 5.1 新建 session 并发送首条 prompt

```text
PromptInput 提交
  -> 如果当前无 session，先 session.create()
  -> 前端 seed 新 session 到当前目录 store
  -> buildRequestParts()
  -> optimistic user message 写入前端 store
  -> POST /session/:id/prompt_async
  -> 后端 createUserMessage()
  -> Session.updateMessage/Part -> SyncEvent -> DB + Bus
  -> SessionPrompt.loop()
  -> SessionProcessor.process()
  -> SSE 持续推 assistant/message.part/status/todo/diff 等
  -> web-ui reducer 增量更新 timeline/composer/review/sidebar
```

这条链路最能体现 session 是全栈中心对象。

## 5.2 打开已有 session

```text
路由进入 /:dir/session/:id
  -> Sync.session.sync(id)
  -> 如命中预取元数据，则先复用 prefetch meta
  -> 拉 session info + 首屏 messages
  -> 可选拉 todo / diff
  -> 页面只渲染最近几个 turn
  -> 向上滚动时再分页补 older history
```

## 5.3 运行中的 session 流式更新

```text
后端 SessionProcessor 在 loop 内流式写 message.part.updated / delta / status
  -> GlobalSDK 接收 /global/event SSE
  -> coalescing / flush
  -> GlobalSync.applyDirectoryEvent()
  -> 当前 directory child store 更新
  -> Session 页面响应式重绘
```

## 5.4 revert

```text
前端触发 session.revert
  -> 后端 snapshot revert + session.revert 标记 + diff 重算
  -> SSE 更新 session.updated / session.diff
  -> 前端 visibleUserMessages 按 revert.messageID 截断
  -> composer 区出现 revert dock
  -> 后续继续运行前，cleanup 再真正删历史
```

## 5.5 compaction

```text
SessionProcessor/Prompt 判断上下文过大
  -> 插入 compaction user part
  -> SessionPrompt.loop 识别待处理 compaction
  -> 生成 summary assistant message
  -> 必要时 replay 最近 user 请求或生成 synthetic continue
  -> MessageV2.filterCompacted() 改变后续可见历史范围
```

## 6. 当前实现的几个关键特征

## 6.1 session 是“聚合根”，但不是所有数据都严格统一在同一机制下

严格走 sync event 投影的主要是：

- session
- message
- part

其他围绕 session 的数据：

- todo
- permission
- question
- status

则采用 bus、内存状态、直接表写等不同策略。

所以当前架构更准确地说是：

- session/message/part 为主干
- 其他 session 附属能力环绕其周围

## 6.2 web-ui 明显是 SSE 优先，而不是请求响应优先

前端会做：

- optimistic user message
- 侧边栏预取
- session 历史分页
- SSE 增量 merge

但不会等同步接口返回 assistant 完整结果。

这说明 session 页本质是事件流驱动界面。

## 6.3 session 同时承担“业务会话”和“执行队列”的职责

同一个 session 同时定义：

- 业务上的一次任务/对话
- 后端 loop 的串行执行边界
- 前端 busy/idle/retry 的状态边界
- tool/permission/question/todo 的归属边界

这使 session 成为真正的一等核心对象，而不是 UI 层的分组概念。

## 6.4 fork 被前后端都当成真实树结构处理

从后端的 `parent_id`、复制历史，到前端：

- child map
- permission/question 子树查找
- sidebar child session 展示

都说明 fork session 不是附带功能，而是 session 模型的原生能力。

## 6.5 review 体系高度依赖 session baseline snapshot

session 创建时就记录 baseline snapshot，是当前 review 架构里非常关键的一个实现点。

没有这个 baseline：

- human edits 可能丢失
- session diff 的语义会退化

因此从代码看，session 不只是聊天容器，也承担了“工作区变更观察窗口”的角色。

## 7. 如果只看 web-ui，session 架构可以概括成什么

如果只从 web-ui 视角概括，当前架构可以浓缩为一句话：

> web-ui 不是“打开某个聊天记录页”，而是在“订阅并驱动一个 session 的运行现场”。

更具体地说：

- 路由用 session 定位页面
- SSE 用 session 驱动实时更新
- composer 用 session 承载输入草稿、context、followup、permission/question/todo
- timeline 用 session message/part 渲染执行过程
- review 用 session diff 展示代码结果
- sidebar 用 session 列表和预取组织导航

这也是为什么 session 相关代码在 app 和 opencode 两端都占据很大比重。

## 8. 结论

当前程序的 session 架构具有以下本质：

1. `session` 是全栈核心聚合根，而非普通聊天容器。
2. 后端围绕 session 建立了 event-driven 的 message/part 事实流。
3. AI 执行循环、工具调用、summary、revert、fork、todo、permission、question 全都围绕 session 挂载。
4. web-ui 以 session 为主视图单元，并通过 SSE、预取、分页、optimistic update 维护一个实时运行中的“会话现场”。
5. session 既承载“对话历史”，也承载“代码工作流状态”和“工作区变更视图”。

如果后续要继续研究或改造 session，最值得优先盯住的文件是：

- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/summary.ts`
- `packages/opencode/src/session/revert.ts`
- `packages/app/src/context/global-sync.tsx`
- `packages/app/src/context/sync.tsx`
- `packages/app/src/pages/session.tsx`
- `packages/app/src/components/prompt-input/submit.ts`

