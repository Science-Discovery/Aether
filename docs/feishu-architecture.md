# 飞书连接架构文档

## 概述

Aether 通过飞书官方 SDK 的 **WebSocket 长连接模式**，在本地与飞书服务器建立实时通信。用户在飞书中给机器人发消息，Aether 本地接收并调用 AI 处理后，通过飞书 API 回复。

核心特点：
- **无需公网地址**：本地主动连接飞书服务器，不需要 webhook 或云端部署
- **内置实现**：TypeScript 原生集成，非子进程方案
- **体验一致**：与微信连接的使用流程完全对齐

## 整体架构

```
飞书用户
  │
  ▼
飞书服务器
  │ WebSocket 推送
  ▼
┌─────────────────────────────────────────────────┐
│  Aether 本地进程                                 │
│                                                  │
│  ┌──────────────┐    Bus 事件    ┌────────────┐ │
│  │ FeishuManager│ ──────────────▶│ SSE 事件流  │ │
│  │  (manager.ts)│               │(routes/     │ │
│  │              │◀──── HTTP ────│ feishu.ts)  │ │
│  └──────┬───────┘               └──────┬──────┘ │
│         │                              │        │
│         │ Instance.bind()              │ SSE    │
│         ▼                              ▼        │
│  ┌──────────────┐               ┌────────────┐ │
│  │ Session API  │               │  前端 UI    │ │
│  │ Session.create│              │(dialog-     │ │
│  │ Prompt.prompt│               │ feishu.tsx) │ │
│  └──────────────┘               └────────────┘ │
└─────────────────────────────────────────────────┘
  │
  │ larkClient.im.message.reply()
  ▼
飞书用户看到回复
```

### 图中名词解释

如果你是第一次看这张图，下面逐个解释每个名词：

**飞书服务器** — 飞书的云端服务，负责在用户之间传递消息，类似微信的后台。

**WebSocket 推送** — 一种网络连接方式。普通 HTTP 像「发短信」，你问一次服务器答一次。WebSocket 像「打电话」，连接建立后一直保持通着，服务器有新消息随时推过来，不需要你反复去问。这就是为什么 Aether 不需要公网地址——是你的电脑主动打电话给飞书服务器，而不是反过来。

**Bus 事件** — Aether 内部的事件总线，`FeishuManager` 通过它广播状态变更（如 `feishu.connected`、`feishu.status`），前端 SSE 路由监听这些事件并转发给浏览器。

**Instance.bind()** — Aether 用 AsyncLocalStorage 存储当前项目上下文（目录、工作区等）。飞书 SDK 的回调跑在独立的异步上下文里，需要用 `Instance.bind()` 手动恢复上下文，否则 `Session.create` 等 API 无法知道当前项目。

## 代码结构

```
packages/opencode/src/feishu/
  manager.ts              # 连接管理器（SDK 初始化、消息处理、会话映射、模型管理）

packages/opencode/src/server/routes/
  feishu.ts               # HTTP API（start/stop/status/events/session）

packages/app/src/
  context/feishu.ts       # 前端全局状态（feishuStatus 信号）
  components/dialog-feishu.tsx  # 连接对话框 UI
```

## 各模块详解

### 1. 连接管理器 (`packages/opencode/src/feishu/manager.ts`)

全局单例 `FeishuManager`，负责整个飞书连接的生命周期。

#### 状态机

```
idle ──▶ starting ──▶ connected
  ▲         │              │
  │         ▼              │
  └───── error ◀───────────┘
```

| 状态 | 含义 |
|------|------|
| `idle` | 未连接，等待用户操作 |
| `starting` | 正在建立 WebSocket 连接 |
| `connected` | 连接成功，正常接收消息 |
| `error` | 连接失败或运行时错误 |

#### 关键方法

| 方法 | 职责 |
|------|------|
| `start(config?, model?)` | 入口。加载或接收配置和模型，触发连接 |
| `_doStart(config, model)` | 实际连接逻辑：创建 SDK 客户端、注册事件、启动 WebSocket、设置连接模型 |
| `handleMessage(data)` | 接收飞书消息 → 过滤 @mention → 映射会话 → 解析模型 → 调用 AI → 回复 |
| `handleCommand(text)` | 分发 `/new`、`/model`、`/help` 等斜杠命令 |
| `cmdNew(messageId, chatId)` | 清除会话映射和本聊天的模型 override，立即新建会话 |
| `cmdModel(messageId, chatId, args)` | 无参数列出模型，有参数切换本聊天的模型 |
| `cmdProject(messageId, chatId, arg)` | 查看/切换/隐藏项目，完整对齐微信端逻辑 |
| `buildModelList()` | 调用 `Provider.list()` 展平成编号列表，供 `/model` 使用 |
| `resolveModel(chatId)` | 三级模型解析：per-chat override → 连接快照 → undefined |
| `getProjects()` | 调用 `Project.recentList()` 并过滤根目录，与微信端 `GET /project/recent` 数据一致 |
| `replyText(messageId, text)` | 通过飞书 REST API 回复消息 |
| `stop()` | 断开 WebSocket，清理客户端和所有模型状态 |
| `clearSession()` | 删除本地配置和会话映射文件 |

#### AsyncLocalStorage 上下文绑定

这是架构中最关键的技术细节。

`Session.create()` 和 `SessionPrompt.prompt()` 依赖 `Instance` AsyncLocalStorage 上下文（提供 `directory`、`worktree` 等项目信息）。HTTP 路由通过中间件自动注入此上下文，但飞书 SDK 的 WebSocket 事件回调运行在独立的异步上下文中，没有 Instance 信息。

解决方案：在 `_doStart()` 中使用 `Instance.bind()` 捕获当前上下文：

```typescript
// _doStart 由 HTTP 请求触发，此时 Instance 上下文可用
private async _doStart(config: FeishuConfig, model: ModelRef | null): Promise<void> {
  // 捕获 Instance 上下文，绑定到事件回调
  const boundHandleMessage = Instance.bind((data: any) => {
    void this.handleMessage(data)  // 不 await，立即返回
  })

  const eventDispatcher = new lark.EventDispatcher({})
  eventDispatcher.register({
    "im.message.receive_v1": boundHandleMessage,  // 事件触发时自动恢复上下文
  })
  // ...
}
```

调用链：`HTTP POST /feishu/start` → 中间件注入 Instance 上下文 → `FeishuManager.start()` → `void _doStart()` 同步启动 → `Instance.bind()` 捕获上下文 → 后续事件回调中恢复。

> **为什么用 `void` 而不是 `await`？**
> 飞书 SDK 的事件回调要求快速返回。如果回调里 `await handleMessage()`（等 AI 生成回复，可能要几秒到几十秒），飞书服务器会认为投递失败并重发同一条消息，导致用户收到重复回复。改为 `void` 后回调立即返回，`handleMessage` 在后台异步执行。

#### 会话映射

飞书聊天到 Aether 会话的映射规则：

```
映射 key = `${chatId}:${rootId}`
```

- `chatId`：飞书聊天 ID
- `rootId`：消息线程根 ID（`root_id` 或 `parent_id`，回退到 `message_id`）

同一线程内的消息共享同一个 Aether 会话。使用 `/new` 命令清除当前聊天的所有映射。

首次发消息（无映射）时，优先复用 Aether 中最近的会话，无已有会话时才新建。

映射持久化到本地文件 `sessions.json`。

#### 数据持久化

| 文件 | 内容 |
|------|------|
| `config.json` | App ID 和 App Secret |
| `sessions.json` | 飞书聊天 → Aether 会话 ID 映射 |
| `hidden_projects.json` | 隐藏项目目录 → 隐藏时间戳 |

存储路径按平台：
- Windows: `%APPDATA%\opencode\feishu\`
- macOS: `~/Library/Application Support/opencode/feishu/`
- Linux: `~/.local/share/opencode/feishu/`

### 2. HTTP 路由 (`packages/opencode/src/server/routes/feishu.ts`)

通过 Hono 框架注册在 `/feishu` 路径下。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/feishu/start` | 启动连接。body 可选传 `appId`/`appSecret` 和 `model`，否则用已保存配置 |
| POST | `/feishu/stop` | 断开连接 |
| GET | `/feishu/status` | 返回 `{ status, appId, hasConfig, error }` |
| GET | `/feishu/events` | SSE 事件流，推送状态变更和心跳 |
| DELETE | `/feishu/session` | 清除本地配置和会话数据 |

#### SSE 事件流

`/feishu/events` 端点通过 Server-Sent Events 向前端实时推送状态：

```
初始连接 → 推送当前 status
         → 若已 connected，额外推送 feishu.connected 事件
运行中   → 每 10 秒推送 heartbeat
         → 订阅 Bus 上所有 feishu.* 事件并转发
断开     → 清理订阅和定时器
```

事件格式：
```json
data: {"type": "feishu.connected", "properties": {"appId": "cli_xxx"}}
data: {"type": "feishu.status", "properties": {"status": "starting", "message": "正在连接飞书..."}}
data: {"type": "feishu.error", "properties": {"code": "start_failed", "message": "..."}}
```

### 3. 前端 UI (`packages/app/src/components/dialog-feishu.tsx`)

SolidJS 对话框组件，提供完整的连接管理界面。

#### UI 状态

| 状态 | 显示内容 |
|------|---------|
| `idle` | 飞书图标 + "连接飞书"按钮（有配置时）或"配置飞书应用"按钮 |
| `config` | App ID / App Secret 输入表单 |
| `loading` | 旋转动画 + 状态文字 |
| `connected` | 绿色勾 + 已连接信息 + "断开连接"/"切换应用"按钮 |
| `error` | 红色警告 + 错误信息 + "重试"按钮 |

#### 事件处理时序

```
用户点击"连接飞书"
  │
  ├─ 1. connectSSE()          先建立 SSE 连接，避免遗漏事件
  │
  └─ 2. fetch POST /start     携带当前模型（providerID + modelID）触发后端连接
       │
       └─ SSE 接收事件 ──▶ 更新 UI 状态
```

关键设计：SSE 在 start 请求之前建立，因为 `_doStart` 是 `void` 调用（异步不等待），可能在 start 返回前就完成连接。

### 4. 全局状态 (`packages/app/src/context/feishu.ts`)

```typescript
export type FeishuStatus = "idle" | "loading" | "connected" | "error"
export const [feishuStatus, setFeishuStatus] = createSignal<FeishuStatus>("idle")
```

在 `prompt-input.tsx` 中用于工具栏按钮的状态指示颜色：
- 蓝色 = connected
- 黄色闪烁 = loading
- 红色 = error
- 灰色 = idle

## 消息处理流程

```
1. 飞书用户发送文本消息
2. 飞书服务器通过 WebSocket 推送 im.message.receive_v1 事件
3. 事件回调通过 Instance.bind 恢复上下文，用 void 立即返回（不阻塞 SDK）
4. handleMessage 在后台异步执行：
   a. 非文本消息 → 回复"暂时只支持文本消息"
   b. 过滤 @mention 占位符（群聊中的 `@_user_1 ` 前缀）
   c. 斜杠命令 → handleCommand 分发处理
   d. 普通文本 → 继续
5. 根据 chatId + rootId 查找已有 Aether 会话
   a. 有映射 → 复用已映射的会话
   b. 无映射 → 复用最近的会话；若无任何会话则新建
6. resolveModel(chatId) 解析本次使用的模型
7. SessionPrompt.prompt() 将文本发送给 AI（携带模型参数）
8. 提取 AI 回复的文本部分，拼接项目/会话标题头部
9. larkClient.im.message.reply() 回复到飞书
10. 如果任何步骤报错 → catch 中通过 replyText 将错误信息发回飞书
```

## 模型选择逻辑

### 设计原则

- 连接飞书时，前端把 web UI 底栏当前选中的模型一并发给后端，作为连接快照
- 连接期间 web UI 切换模型不影响飞书端（快照冻结）
- 用户可通过 `/model n` 为当前聊天设置独立的模型 override
- `/new` 只清除本聊天的 override，连接快照保持不变
- `/stop` 清除所有模型状态

## 项目切换逻辑

### 命令

| 命令 | 行为 |
|------|------|
| `/project` | 显示前 10 个非隐藏项目，当前项目标 `◀` |
| `/project list` | 显示全部项目，隐藏项目标 `[已隐藏]` |
| `/project n` | 切换到第 n 个项目，自动复用/新建该项目的会话 |
| `/project hide n` | 隐藏第 n 个项目；该项目有新活动后自动恢复 |

### 数据来源

`getProjects()` 直接调用 `Project.recentList()`，这与微信端调用的 `GET /project/recent` HTTP 接口是**同一个函数**，因此两端看到的项目列表完全一致。

### 每聊天目录（`_chatDirs`）

`/project n` 切换后，该 chatId 的目标目录保存在 `_chatDirs[chatId]`。后续每条消息都在该目录的 Instance 上下文中执行：

```typescript
const effectiveDir = this._chatDirs[chatId] ?? Instance.directory
await Instance.provide({
  directory: effectiveDir,
  fn: async () => {
    // Session 查找/创建、SessionPrompt.prompt() 均在此上下文内运行
  },
})
```

这样 `Session.create()` 和 AI 回复都归属于正确的项目，而不是连接时的默认目录。

### 隐藏项目

- 隐藏状态持久化到 `hidden_projects.json`，重连后保留
- 每次执行 `/project` 命令时自动检查：若隐藏项目的 `time.activity` 晚于隐藏时间，则自动恢复显示
- `/project n` 切换到已隐藏的项目时也会自动取消隐藏

### 状态字段

| 字段 | 类型 | 生命周期 |
|------|------|---------|
| `_chatDirs` | `Record<chatId, directory>` | `/project n` 设置，`stop()` 时清除 |
| `_hiddenDirs` | `Record<directory, timestamp>` | `/project hide n` 设置，持久化，重连保留 |

### 三级解析（`resolveModel(chatId)`）

```
per-chat override (_modelOverrides[chatId])
       ↓ 无
连接快照 (_connectedModel)
       ↓ 无
undefined → SessionPrompt 内部默认逻辑
```

### 状态字段

| 字段 | 类型 | 生命周期 |
|------|------|---------|
| `_connectedModel` | `{ providerID, modelID } \| null` | 连接时由前端传入，`stop()` 时清除 |
| `_modelOverrides` | `Record<chatId, ModelRef>` | `/model n` 设置，`/new` 或 `stop()` 清除 |
| `_modelList` | `ModelEntry[]` | 连接时预构建，`stop()` 时清除 |

### 连接时传递模型

前端 `dialog-feishu.tsx` 在调用 `/feishu/start` 时，读取 `useLocal().model.current()`，将 `{ providerID, modelID }` 放入 POST body。后端路由解析后传给 `FeishuManager.start(config, model)`，直接赋值给 `_connectedModel`。

这比从 session 消息历史反推更可靠：用户刚切换模型未发消息时，历史记录里没有新模型的 assistant 消息，反推会拿到错误的模型。

### `/model` 命令格式

```
/model          → 列出所有可用模型
/model <n>      → 将本聊天的模型 override 设为第 n 号
```

列表格式（参考微信端）：

```
🤖 当前：anthropic/claude-sonnet-4-6

📦 可用模型：

【anthropic】
  1. anthropic/claude-opus-4-6
  2. anthropic/claude-sonnet-4-6 ★

【openai】
  3. openai/gpt-4o

💡 /model n 切换模型
```

## 依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `@larksuiteoapi/node-sdk` | 1.60.0 | 飞书官方 SDK：WSClient、EventDispatcher、Client |

SDK 使用方式：
- `lark.WSClient` — WebSocket 长连接客户端
- `lark.EventDispatcher` — 事件注册和分发
- `lark.Client` — REST API 客户端（发送回复消息）
- `lark.LoggerLevel.debug` — 调试日志级别

## 与微信连接的架构对比

| 维度 | 微信 | 飞书 |
|------|------|------|
| 连接方式 | Python 子进程 + 客户端长连接 | TypeScript 内置 + WebSocket 长连接 |
| SDK | Python wechatferry | Node.js @larksuiteoapi/node-sdk |
| 认证 | 扫二维码 | App ID + App Secret |
| 消息桥接 | 子进程 stdout/HTTP 通信 | 进程内直接调用 Session API |
| 上下文处理 | HTTP API 自带中间件上下文 | Instance.bind() 手动绑定上下文 |
| 需要公网 | 否 | 否 |
| 首次配置 | 扫码 | 飞书开放平台创建应用 |
| 模型传递 | 环境变量 `AETHER_MODEL` | POST body `model` 字段 |

## 已知限制

1. **仅支持文本消息**：图片、文件等消息类型暂不处理
2. **无自动重连**：WebSocket 断开后需手动重新连接
3. **单实例**：FeishuManager 是全局单例，不支持同时连接多个飞书应用
4. **群聊限制**：当前设计面向私聊场景，群聊中 @机器人 已过滤 @mention 占位符，但未经大规模验证

## 变更记录

| 日期 | 修改内容 | 原因 |
|------|---------|------|
| 2026-04-06 11:25 | 事件回调从 `await` 改为 `void`（非阻塞） | 飞书服务器在回调未及时返回时会重发消息，导致用户收到重复回复 |
| 2026-04-06 11:39 | `handleMessage` 的 catch 中增加 `replyText` 错误反馈 | 报错时飞书用户无任何提示，现在会收到错误信息 |
| 2026-04-06 16:03 | 首次发消息优先复用最近会话，而非总是新建 | 飞书每条消息都新建会话，web 端体验混乱 |
| 2026-04-06 16:15 | 每条 AI 回复顶部追加项目和会话标题（`📁 项目名\n💬 会话名\n───`） | 用户无法感知当前处于哪个项目/会话 |
| 2026-04-06 16:25 | `/new` 改为立即创建新会话（`Session.create`），不再等到下一条消息才新建 | web 端侧边栏需实时出现新会话，旧实现只清除映射延迟到下条消息才生效 |
| 2026-04-06 18:30 | 新增模型选择逻辑：连接时前端传模型 + per-chat override + `/model` 命令 | 飞书端应沿用 web UI 当前选中的模型，连接后 web UI 切换模型不应影响飞书端 |
| 2026-04-06 19:00 | `/model` 列表格式改为按 provider 分组，参考微信端风格 | 原格式不直观，统一两端体验 |
| 2026-04-06 20:00 | 新增 `/project` 命令：查看/切换/隐藏项目，数据源与微信端一致 | 多项目场景下需在飞书端切换工作目录；切换后消息自动在对应项目上下文中执行 |
