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

**Aether 本地进程** — 运行在你电脑上的 Aether 程序，就是你双击打开的那个应用。整个大框就是它。

**FeishuManager (manager.ts)** — Aether 里专门负责和飞书打交道的模块。它做三件事：收飞书消息、交给 AI 处理、把回复发回飞书。同时它还记住「飞书的哪个聊天 = Aether 的哪个 AI 会话」。

**Bus 事件** — 程序内部的广播机制。像对讲机：FeishuManager 喊一句「我已连上飞书了」，所有在听的模块都能收到。这里主要用来把连接状态（连接中/已连接/出错）传给前端。

**SSE 事件流 (routes/feishu.ts)** — Server-Sent Events，一种服务器向浏览器单向推送数据的技术。Aether 后端通过 SSE 持续向前端推送状态更新。前端收到后就能实时刷新界面，显示「正在连接...」或「已连接」。

**HTTP** — 前端和后端之间最基本的请求/响应通信。你在界面上点击「连接飞书」按钮 → 前端发一个 HTTP 请求到后端 → 后端执行连接操作并返回结果。图中 `routes/feishu.ts` 定义了后端能响应哪些请求（开始连接、断开、查状态等）。

**Instance.bind()** — 这是一个技术细节。飞书的消息回调运行在「另一个执行空间」里，访问不到 Aether 的项目信息（比如当前工作目录）。`Instance.bind()` 的作用是在连接飞书时把项目信息「打包」起来，等消息回调触发时再「解包」恢复，这样回调里就能正常创建 AI 会话了。

**Session API** — Aether 的 AI 会话接口。`Session.create` = 新建一个 AI 对话；`Prompt.prompt` = 把用户说的话发给 AI 模型，等 AI 想好了返回回答。

**前端 UI (dialog-feishu.tsx)** — 你在 Aether 界面里看到的「飞书连接」弹窗。用来输入 App ID/Secret、显示连接状态、提供断开/重连按钮。

**larkClient.im.message.reply()** — 飞书 SDK 提供的「回复消息」方法。AI 生成回答后，通过这个方法把文字发回飞书，用户就能在飞书聊天里看到回复了。

### 一句话总结

飞书用户发消息 → 飞书服务器通过 WebSocket 推给你电脑上的 Aether → FeishuManager 收到后交给 AI 处理 → AI 回复后通过飞书 SDK 发回去 → 飞书用户看到回复。与此同时，连接状态通过 Bus → SSE 实时推给前端界面显示。

## 文件结构

```
packages/opencode/src/
  feishu/
    manager.ts              # 核心：连接管理、消息处理、会话映射

packages/opencode/src/server/routes/
  feishu.ts                 # HTTP API 路由（start/stop/status/events）

packages/app/src/
  context/feishu.ts         # 前端全局状态信号
  components/
    dialog-feishu.tsx       # 连接对话框 UI
    prompt-input.tsx        # 工具栏飞书按钮（状态指示）

packages/ui/src/components/
  icon.tsx                  # feishu 图标定义
```

## 核心模块详解

### 1. FeishuManager (`packages/opencode/src/feishu/manager.ts`)

单例模式的连接管理器，负责全部飞书交互逻辑。

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
| `start(config?)` | 入口。加载或接收配置，触发连接 |
| `_doStart(config)` | 实际连接逻辑：创建 SDK 客户端、注册事件、启动 WebSocket |
| `handleMessage(data)` | 接收飞书消息 → 过滤 @mention → 映射会话 → 调用 AI → 回复 |
| `handleCommand(text)` | 处理 `/new`、`/help` 等斜杠命令 |
| `replyText(messageId, text)` | 通过飞书 REST API（原生 fetch）回复消息 |
| `stop()` | 断开 WebSocket，清理客户端 |
| `clearSession()` | 删除本地配置和会话映射文件 |

#### AsyncLocalStorage 上下文绑定

这是架构中最关键的技术细节。

`Session.create()` 和 `SessionPrompt.prompt()` 依赖 `Instance` AsyncLocalStorage 上下文（提供 `directory`、`worktree` 等项目信息）。HTTP 路由通过中间件自动注入此上下文，但飞书 SDK 的 WebSocket 事件回调运行在独立的异步上下文中，没有 Instance 信息。

解决方案：在 `_doStart()` 中使用 `Instance.bind()` 捕获当前上下文：

```typescript
// _doStart 由 HTTP 请求触发，此时 Instance 上下文可用
private async _doStart(config: FeishuConfig): Promise<void> {
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

存储路径按平台：
- Windows: `%APPDATA%\opencode\feishu\`
- macOS: `~/Library/Application Support/opencode/feishu/`
- Linux: `~/.local/share/opencode/feishu/`

### 2. HTTP 路由 (`packages/opencode/src/server/routes/feishu.ts`)

通过 Hono 框架注册在 `/feishu` 路径下。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/feishu/start` | 启动连接。body 可选传 `appId`/`appSecret`，否则用已保存配置 |
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
  └─ 2. fetch POST /start     触发后端连接
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
   c. 斜杠命令 → handleCommand 处理
   d. 普通文本 → 继续
5. 根据 chatId + rootId 查找已有 Aether 会话
   a. 有映射 → 复用已映射的会话
   b. 无映射 → 复用最近的会话；若无任何会话则新建
6. SessionPrompt.prompt() 将文本发送给 AI
7. 提取 AI 回复的文本部分
8. larkClient.im.message.reply() 回复到飞书
9. 如果任何步骤报错 → catch 中通过 replyText 将错误信息发回飞书，用户会收到"处理消息时出错: xxx"
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

## 已知限制

1. **仅支持文本消息**：图片、文件等消息类型暂不处理
2. **无自动重连**：WebSocket 断开后需手动重新连接
3. **单实例**：FeishuManager 是全局单例，不支持同时连接多个飞书应用
4. **群聊限制**：当前设计面向私聊场景，群聊中 @机器人 需要额外的消息过滤逻辑

## 变更记录

| 日期 | 修改内容 | 原因 |
|------|---------|------|
| 2026-04-06 11:25 | 事件回调从 `await` 改为 `void`（非阻塞） | 飞书服务器在回调未及时返回时会重发消息，导致用户收到重复回复 |
| 2026-04-06 11:39 | `handleMessage` 的 catch 中增加 `replyText` 错误反馈 | 报错时飞书用户无任何提示，现在会收到错误信息 |
| 2026-04-06 16:03 | 首次发消息优先复用最近会话，而非总是新建 | 飞书每条消息都新建会话，web 端体验混乱 |
