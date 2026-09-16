# 移动端桥接生命周期（微信 / 飞书 / QQ）

本文描述三个移动端平台（微信、飞书、QQ）桥接连接的统一生命周期模型。

## 设计原则

1. **期望状态持久化**：每个平台在自己的平台目录下保存 `enabled.json`，记录"开/关"期望状态。**只有用户显式操作才会切换**：点击「连接」置为开，点击「断开连接」或「退出登录/切换账号」置为关。关闭页面、刷新、多开窗口、断网、服务重启等任何其它操作都**不改变**该状态。
2. **桥生命周期归服务端所有**：轮询/长连接运行在 Aether 服务进程内，与浏览器页面生命周期完全解耦。页面只是状态的显示器。
3. **看门狗自动恢复**：只要期望状态为开且凭据存在，服务端每 60 秒检查一次，发现桥不在运行（`idle`/`error`）就自动重新 `start()`。`start()` 在三个平台都是幂等的（重复调用会被内部状态守卫拒绝），因此看门狗无需理解平台差异。

## 状态文件

`enabled.json` 位于各平台的持久化目录（与该平台 `config.json` / `session.json` 同目录）：

| 平台 | Windows                    | macOS                                          | Linux                           |
| ---- | -------------------------- | ---------------------------------------------- | ------------------------------- |
| 微信 | `%APPDATA%\aether\wechat\` | `~/Library/Application Support/aether/wechat/` | `~/.local/share/aether/wechat/` |
| 飞书 | `%APPDATA%\aether\feishu\` | `~/Library/Application Support/aether/feishu/` | `~/.local/share/aether/feishu/` |
| QQ   | `%APPDATA%\aether\qq\`     | `~/Library/Application Support/aether/qq/`     | `~/.local/share/aether/qq/`     |

内容：`{ "enabled": true, "updatedAt": 1730000000000 }`。文件不存在视为关。

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
  wechat.ts         # 微信管理器：锁内置于 start()；pollLoop 运行中续租 lock.json
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
  其余                    → 调用 start()（幂等，跨进程由微信锁挡住）
```

### 微信 token 过期的特殊处理

- 轮询收到 errcode -14，或 iLink 在 HTTP 层返回 401/403 时，判定会话失效：删除本地 token 状态并请求**一次**二维码，等待扫码（2 分钟超时）；
- 扫码成功即恢复；超时/失败进入 error，之后凭据不存在，看门狗不会再自动请求二维码（避免刷码触发风控）；
- 登录成功后的建连阶段（会话初始化等）失败时**保留** token，看门狗会自动重试恢复，无需重新扫码；
- 用户在 UI 点「重试」会重新出码。

## HTTP API 变化

- `GET /mobile/{platform}/status` 响应新增 `enabled: boolean` 字段；
- `POST /mobile/{platform}/stop`：微信平台在锁由其它进程的客户端持有时，要求 `clientId` 与当前锁持有者一致才执行，不一致则忽略（防止残留页面误断其它窗口的连接）；同进程或无锁时直接执行；
- 移除 `POST /mobile/wechat/ping`（看门狗取代其职责）。

## 已知限制

- **恢复间隙消息可能丢失**：微信 cursor 在处理前推进、飞书/QQ 无离线缓冲，断线到恢复之间（最长约 60 秒）到达的消息无法补投。这是平台协议限制。
- **跨进程强制接管**：两个 Aether 服务进程共享数据目录时，第二个进程可通过「强制接管」抢锁，但不会停止第一个进程已有的轮询（历史行为，未改变）；意外双跑已被锁 + 运行中续租机制阻止。
