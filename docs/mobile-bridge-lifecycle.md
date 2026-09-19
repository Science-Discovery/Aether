# 移动端桥接生命周期（微信 / 飞书 / QQ）

本文描述三个移动端平台（微信、飞书、QQ）桥接连接的统一生命周期模型。

## 设计原则

1. **期望状态持久化**：每个平台在自己的平台目录下保存 `enabled.json`，记录"开/关"期望状态。**只有用户显式操作才会切换**：点击「连接」置为开，点击「断开连接」或「退出登录/切换账号」置为关。关闭页面、刷新、多开窗口、断网、服务重启等任何其它操作都**不改变**该状态。
2. **桥生命周期归服务端所有**：轮询/长连接运行在 Aether 服务进程内，与浏览器页面生命周期完全解耦。页面只是状态的显示器。
3. **看门狗自动恢复**：只要期望状态为开且凭据存在，服务端每 60 秒检查一次，发现桥不在运行（`idle`/`error`）就自动重新 `start()`。`start()` 在三个平台都是幂等的（重复调用会被内部状态守卫拒绝），因此看门狗无需理解平台差异。

## 状态文件

`enabled.json` 位于各平台的持久化目录（与该平台 `config.json` / `session.json` 同目录）。**该目录按 channel 隔离**：`latest`（含 beta）沿用根目录，其余 channel（prod、local、dev 等）位于 `<root>\<channel>\` 子目录下，与 channel 数据库的分目录约定一致：

| 平台 | latest / beta    | 其他 channel（prod / local / …）                       |
| ---- | ---------------- | ------------------------------------------------------ |
| 微信 | `<root>\wechat\` | `<root>\<channel>\wechat\`（如 `<root>\prod\wechat\`） |
| 飞书 | `<root>\feishu\` | `<root>\<channel>\feishu\`                             |
| QQ   | `<root>\qq\`     | `<root>\<channel>\qq\`                                 |

其中 `<root>` 按平台为：

| OS      | `<root>`                                |
| ------- | --------------------------------------- |
| Windows | `%APPDATA%\aether\`                     |
| macOS   | `~/Library/Application Support/aether/` |
| Linux   | `~/.local/share/aether/`                |

内容：`{ "enabled": true, "updatedAt": 1730000000000 }`。文件不存在视为关。

## 多 channel 隔离

同一台机器可同时运行多个 channel（如 prod 与 local）。移动端桥接的**全部持久状态按 channel 隔离**：

- 每个 channel 有自己的一套平台目录：`enabled.json`（期望状态）、凭证/令牌（微信 `ilink_state.json`、飞书/QQ `config.json`）、`sessions.json`、`hidden_projects.json`、`header_state.json`；
- 每个 channel 的看门狗只读取**本 channel** 的期望状态与凭证，自动连接互不干扰——例如 prod 只自动开 QQ、local 只自动开微信，是完全受支持的用法；
- 一个 channel 的「连接/断开」操作不会影响另一个 channel 的连接。

**迁移语义**：升级到本版本后，`latest` 沿用原有目录（无感）；其余 channel 从空白状态开始，需要一次性重新登录/配置（微信扫一次码、飞书/QQ 重填应用配置）。不会自动继承旧的共享状态——否则每个 channel 都会继承相同的账号并自动连接，重新造成串台。

**已知限制**：微信凭据是平台单会话语义。若在两个 channel 登录**同一个**微信账号，两个进程会互相顶号（连接互踢），请为不同 channel 使用不同账号或只在一个 channel 登录。

## 状态转换表

| 事件                           | enabled | 桥状态                                                         |
| ------------------------------ | ------- | -------------------------------------------------------------- |
| 用户点「连接」成功             | 开      | 启动                                                           |
| 用户点「断开连接」             | 关      | idle，看门狗不再拉起                                           |
| 退出登录 / 切换账号            | 关      | 清除会话数据，idle                                             |
| 重新扫码（微信）               | 不变    | 短暂断开后恢复                                                 |
| 关闭 / 刷新 / 多开页面         | 不变    | 不变                                                           |
| 断网 → 恢复                    | 不变    | 微信轮询自续；飞书/QQ WebSocket 自动重连                       |
| 微信 token 过期（errcode -14） | 不变    | 出一次二维码等待扫码；不扫码则停在 error（不刷码）；扫码后恢复 |
| Aether 服务重启                | 不变    | 服务启动约 5 秒后看门狗自动恢复连接                            |

## 实现结构

```
packages/opencode/src/mobile/
  base.ts           # MobileManagerBase：desired()/setDesired()/hasCredentials() 统一实现
  supervisor.ts     # MobileSupervisor：每 60s 检查 enabled + 凭据 + 状态，必要时幂等调 start()
  wechat.ts         # 微信管理器：start() 幂等（_starting/_pollRunning 守卫），pollLoop 带 generation 计数
  feishu.ts / qq.ts # 各自的 WebSocket 自愈（指数退避重连，最大间隔 5 分钟）
  route.ts          # HTTP API：/start 写入 enabled=开；/stop、DELETE /session 写入 enabled=关
packages/app/src/context/mobile.ts   # 前端状态；仅展示，不再控制桥的生死
```

### 看门狗判定规则（三平台一致）

```
每 60 秒，对每个平台：
  期望状态为关            → 跳过
  无凭据（未配置/需扫码）  → 跳过（等待用户操作，绝不自动出二维码）
  状态非 idle/error       → 跳过（运行中或自带自愈）
  其余                    → 调用 start()（幂等）
```

### 微信 token 过期的特殊处理

- 轮询收到 errcode -14，或 iLink 在 HTTP 层返回 401/403 时，判定会话失效：删除本地 token 状态并请求**一次**二维码，等待扫码（2 分钟超时）；
- 扫码成功即恢复；超时/失败进入 error，之后凭据不存在，看门狗不会再自动请求二维码（避免刷码触发风控）；
- 登录成功后的建连阶段（会话初始化等）失败时**保留** token，看门狗会自动重试恢复，无需重新扫码；
- 用户在 UI 点「重试」会重新出码。

## HTTP API 变化

- `GET /mobile/{platform}/status` 响应新增 `enabled: boolean` 字段；
- `POST /mobile/{platform}/stop`：无条件执行（不再区分客户端）；
- 移除 `POST /mobile/wechat/ping`（看门狗取代其职责）；
- 移除微信跨进程文件锁及 `/start` 的 `clientId`/`force` 参数与 `/status` 的 `locked`/`lockHolder` 字段（channel 隔离后锁不再必要，见「已知限制」）。

## 已知限制

- **恢复间隙消息可能丢失**：微信 cursor 在处理前推进、飞书/QQ 无离线缓冲，断线到恢复之间（最长约 60 秒）到达的消息无法补投。这是平台协议限制。
- **无跨进程锁**：同一 channel 若同时运行两个服务进程且都自动连接同一平台（如两个窗口各起一个服务），微信会同 token 双重轮询、互相干扰。channel 隔离已消除跨 channel 场景；同 channel 请保证只有一个服务进程。
