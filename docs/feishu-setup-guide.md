# 飞书接入 Aether 使用说明

## 功能概述

Aether 支持通过飞书进行对话，体验与微信连接一致：

1. 打开 Aether
2. 点击"飞书连接"
3. 输入应用凭证
4. 连接成功后，在飞书中直接与 Aether AI 对话

## 技术原理

使用飞书 SDK 的 **WebSocket 长连接模式**，本地 Aether 主动连接飞书服务器。

- 不需要公网地址
- 不需要部署 webhook 服务
- 不需要云端桥接
- 本地解压即可使用

这与微信的客户端连接模式本质相同。

## 飞书开放平台配置

使用前需要在飞书开放平台创建应用。

### 第一步：创建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)
2. 点击「创建企业自建应用」
3. 填写应用名称（如 "Aether AI"）和描述
4. 创建完成后，在「凭证与基础信息」页面获取：
   - **App ID**（格式：`cli_xxxxxxxxxxxxxxxx`）
   - **App Secret**

### 第二步：开启机器人能力

1. 在 [飞书开放平台](https://open.feishu.cn/app) 的应用列表中，点击刚创建的应用名称进入应用详情页
2. 在左侧导航栏找到「添加应用能力」，点击进入
3. 找到「机器人」，点击「添加」

### 第三步：配置事件订阅

1. 在应用详情页左侧导航栏，点击「事件与回调」→「事件配置」
2. 添加事件：`im.message.receive_v1`（接收消息）
3. 订阅方式选择：**使用长连接接收事件**（非 webhook）

### 第四步：配置权限

在应用详情页左侧导航栏，点击「权限管理」，搜索并开通以下权限：

| 权限 | 说明 |
|------|------|
| `im:message` | 获取与发送消息 |
| `im:message:send_as_bot` | 以机器人身份发送消息 |
| `im:message.p2p_msg:readonly` | 读取私聊消息 |
| `im:message.group_msg` | 读取群聊消息历史（总结功能需要） |

### 第五步：发布应用

1. 在应用详情页左侧导航栏，点击「版本管理与发布」
2. 创建版本并提交审核
3. 管理员审核通过后即可使用

## 在 Aether 中连接

### 通过界面操作

1. 打开 Aether，在 web UI 底栏选择好想使用的模型
2. 点击输入框旁边的菜单按钮
3. 点击「飞书连接」
4. 首次使用：输入 App ID 和 App Secret，点击「连接」
5. 之后使用：直接点击「连接飞书」

> **提示**：连接时会自动快照当前 web UI 选中的模型。连接后切换 web UI 模型不会影响飞书端，如需更换模型请在飞书中使用 `/model n`。

### 连接状态

| 状态 | 图标颜色 | 说明 |
|------|----------|------|
| 未连接 | 灰色 | 等待连接 |
| 连接中 | 黄色闪烁 | 正在建立 WebSocket 连接 |
| 已连接 | 蓝色 | 正常工作中 |
| 错误 | 红色 | 连接失败，可重试 |

## 使用方式

连接成功后，在飞书中直接给机器人发送消息即可。

- **私聊**：直接发消息
- **群聊**：需要 **@机器人** 才会触发回复，普通消息不会被处理

### 支持的消息类型

- 文本消息 ✅
- 图片/文件（后续支持）

### 内置命令

| 命令 | 说明 |
|------|------|
| `/new` | 开始新对话（清除当前会话上下文和本聊天的模型设置） |
| `/model` | 列出所有可用模型，当前选中标 ★ |
| `/model <n>` | 将本聊天切换到第 n 号模型 |
| `/project` | 查看项目列表（前 10 个，当前标 ◀） |
| `/project list` | 查看全部项目（含隐藏） |
| `/project <n>` | 切换到第 n 个项目 |
| `/project hide <n>` | 隐藏第 n 个项目（有新活动后自动恢复） |
| `/help` | 显示帮助信息 |

### 项目切换

发送 `/project` 查看项目列表：

```
📂 当前项目：opencode

📂 项目列表：

1. opencode ◀
   /home/user/code/openresearch/opencode
2. my-app
   /home/user/code/my-app

💡 /project n 切换 | /project list 查看全部 | /project hide n 隐藏
```

发送 `/project 2` 切换到第 2 个项目，之后所有消息都在该项目上下文中执行，回复头部也会显示对应项目名。

> **提示**：项目列表与微信端完全一致（同一数据来源），隐藏状态跨重连保留。

### 模型切换

发送 `/model` 查看可用模型列表：

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

发送 `/model 3` 切换到第 3 号模型，仅对当前聊天生效，`/new` 后重置为连接快照模型。

### 会话映射规则

飞书对话到 Aether 会话的映射：

- 每个飞书聊天 + 消息线程 = 一个 Aether 会话
- 同一线程内的消息共享上下文
- 不同线程或使用 `/new` 后会创建新会话

## 配置文件位置

配置保存在本地，下次启动无需重新输入：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\opencode\feishu\config.json` |
| macOS | `~/Library/Application Support/opencode/feishu/config.json` |
| Linux | `~/.local/share/opencode/feishu/config.json` |

## 与微信连接的对比

| 项目 | 微信 | 飞书 |
|------|------|------|
| 认证方式 | 扫二维码 | App ID + Secret |
| 连接方式 | 客户端长连接 | WebSocket 长连接 |
| 需要公网 | 否 | 否 |
| 首次配置 | 扫码即可 | 需先在飞书平台创建应用 |
| 后续使用 | 点击连接 | 点击连接 |
| 实现语言 | Python 子进程 | TypeScript（内置） |
| 模型传递 | 环境变量 | 连接时前端传入 |

## 架构说明

```
飞书用户发送消息
    ↓
飞书服务器
    ↓ (WebSocket 推送)
Aether 本地 (FeishuManager)
    ↓
会话映射 → 创建/复用 Aether Session
    ↓
resolveModel() → per-chat override / 连接快照 / 默认
    ↓
SessionPrompt.prompt() → AI 处理
    ↓
飞书 SDK → 回复消息
    ↓
飞书用户看到回复
```

### 代码结构

```
packages/opencode/src/feishu/
  manager.ts              # 连接管理器（SDK 初始化、消息处理、会话映射、模型管理）

packages/opencode/src/server/routes/
  feishu.ts               # HTTP API（start/stop/status/events）

packages/app/src/
  context/feishu.ts       # 前端状态
  components/dialog-feishu.tsx  # 连接对话框 UI
```

### API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/feishu/start` | 启动飞书连接（body 可传 appId/appSecret/model） |
| POST | `/feishu/stop` | 断开连接 |
| GET | `/feishu/status` | 获取连接状态 |
| GET | `/feishu/events` | SSE 事件流 |
| DELETE | `/feishu/session` | 清除配置和会话数据 |

## 常见问题

### 连接失败

1. 确认 App ID 和 App Secret 是否正确
2. 确认应用已开启「机器人」能力
3. 确认事件订阅使用了「长连接」模式
4. 确认应用已发布且审核通过

### 收不到消息

1. 确认已添加 `im.message.receive_v1` 事件订阅
2. 确认已开通 `im:message` 权限
3. 确认在飞书中直接给机器人发消息（群聊中 @机器人 也支持，但需开通群聊权限）

### 项目不对 / 回复的不是我想要的项目

1. 发送 `/project` 查看当前项目和列表
2. 发送 `/project n` 切换到目标项目
3. 切换后发的消息会在新项目上下文中执行

### 模型不对

1. 连接前先在 web UI 底栏切换到目标模型，再点击连接
2. 已连接时使用 `/model n` 切换
3. 重新连接（断开后重连）也会重新快照当前 web UI 模型

### 断线重连

当前版本断线后需要手动重新点击「连接飞书」。自动重连功能将在后续版本实现。
