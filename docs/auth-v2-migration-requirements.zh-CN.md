# Aether 客户端认证 v2 迁移与解耦需求文档

## 1. 背景

当前 opencode/Aether 客户端已经接入 Aether 账号体系，用于在侧边栏完成登录、注册、展示当前账号和退出登录。代码主要集中在：

- `packages/app/src/context/auth.tsx`
- `packages/app/src/components/dialog-login.tsx`
- `packages/app/src/components/dialog-register.tsx`
- `packages/app/src/pages/layout/sidebar-shell.tsx`

现状中，客户端认证模块直接请求 `https://skill.aiphys.cn` 下的 `/v1/auth/register`、`/v1/auth/login`、`/v1/auth/logout`、`/v1/auth/me`。这带来两个问题：

1. 注册仍使用 v1 接口，不要求邮箱验证码，已经落后于 aether-site 提供的 v2 注册流程。
2. 客户端直接耦合 aether-site/Skill Market 的域名、接口版本和页面策略。aether-site 一旦调整登录注册页面或域名分流策略，客户端体验会被动受影响。

aether-site 当前已经在 `https://aether.aiphys.cn` 提供 v2 认证接口，支持邮箱验证码注册、登录、忘记密码和重置密码。客户端需要迁移到 v2，并把认证调用收口为 opencode 自己可控的接口适配层。

## 2. 现状定位

### 2.1 当前客户端行为

`AuthProvider` 当前承担了三件事：

- 维护本地持久化登录态：`session_token`、`expires_at`、`account`。
- 直接拼接远程 API 地址：`BASE_URL = "https://skill.aiphys.cn"`。
- 暴露 `register`、`login`、`logout`、`me` 给 UI 调用。

登录弹窗仅包含邮箱和密码。注册弹窗仅包含邮箱、密码、确认密码、昵称。它没有发送验证码、验证码输入、倒计时、忘记密码、重置密码等 v2 所需流程。

### 2.2 aether-site v2 行为

aether-site 已有以下能力。v2 认证接口的主域名是 `https://aether.aiphys.cn`，例如登录接口应请求 `https://aether.aiphys.cn/v2/auth/login`，不要请求 `https://skill.aiphys.cn/v2/auth/login`。

| 能力 | 接口 |
|------|------|
| 发送注册验证码 | `POST /v2/auth/register/code` |
| 使用验证码注册 | `POST /v2/auth/register` |
| 登录 | `POST /v2/auth/login` |
| 登出 | `POST /v2/auth/logout` |
| 获取当前用户 | `GET /v2/auth/me` |
| 发送重置密码邮件 | `POST /v2/auth/password/forgot` |
| 重置密码 | `POST /v2/auth/password/reset` |

其中 `register` 与 `login` 都返回 `account`、`session_token`、`expires_at`，也会设置 Session Cookie。非浏览器客户端可保存 `session_token`，后续通过 `Authorization: Bearer <session_token>` 访问登录态接口。

### 2.3 关键发现

aether-site 自己在注册和登录页里存在域名分支：当页面运行在 `skill.aiphys.cn` 时仍降级使用 `/v1/auth/register` 和 `/v1/auth/login`；否则使用 `https://aether.aiphys.cn/v2/auth/*`。当前 opencode 客户端硬编码 `https://skill.aiphys.cn`，因此自然停留在旧体验上。

需要特别记录的是：v2 认证接口主要挂在 `https://aether.aiphys.cn`，不是 `https://skill.aiphys.cn`。客户端实现时应把 `https://aether.aiphys.cn/v2/auth/login` 作为登录接口基准地址。

这说明问题不只是“接口路径换成 v2”，还包括“客户端不应依赖站点页面域名策略”。客户端需要直接依赖稳定的认证 API 契约。

## 3. 目标

1. 客户端登录改用 `/v2/auth/login`。
2. 客户端注册改用 v2 邮箱验证码流程。
3. 登录页补齐忘记密码入口，支持发送重置密码邮件与重置密码。
4. 认证 API 域名、接口版本、错误处理和数据结构集中在一个适配层中维护。
5. 旧登录态能够平滑迁移，避免无故要求用户重新登录。
6. 认证模块不再跟随 aether-site 页面实现波动，只依赖后端 API 契约。

## 4. 非目标

1. 本阶段不实现 OAuth、MFA、组织账号或账号合并。
2. 本阶段不重做 Developer Console 的完整账号中心。
3. 本阶段不在客户端保存 Cookie 作为主要登录凭证，仍以 `session_token` 为客户端主凭证。
4. 本阶段不在 opencode 本地服务端复制 aether-site 的账号数据库或密码体系。

## 5. 功能需求

### 5.1 认证适配层

新增或重构一个客户端认证适配层，建议位于 `packages/app/src/context/auth.tsx` 附近，也可以拆为 `packages/app/src/auth/client.ts`。

适配层必须提供以下方法：

| 方法 | 说明 |
|------|------|
| `login(email, password)` | 调用 `/v2/auth/login`，保存返回会话 |
| `send(email)` | 调用 `/v2/auth/register/code` 发送注册验证码 |
| `register(email, password, name, code)` | 调用 `/v2/auth/register` 完成注册并保存会话 |
| `forgot(email)` | 调用 `/v2/auth/password/forgot` 发送重置密码邮件 |
| `reset(token, password)` | 调用 `/v2/auth/password/reset` 设置新密码 |
| `logout()` | 调用 `/v2/auth/logout`，并立即清理本地会话 |
| `me()` | 调用 `/v2/auth/me` 校验并刷新当前账号 |

适配层必须统一处理：

- `Authorization: Bearer <session_token>` 注入。
- `Content-Type: application/json`。
- 标准错误结构解析：`error.code`、`error.message`、HTTP status。
- 网络错误、JSON 解析失败、CORS 失败时的用户可读错误。
- 超时策略，避免登录弹窗无限等待。

### 5.2 API Base 配置

认证 API Base 不能继续硬编码为 `https://skill.aiphys.cn`。

建议优先级：

1. `import.meta.env.VITE_AETHER_AUTH_URL`
2. 构建期注入的全局变量，例如 `globalThis.__AETHER_AUTH_URL__`
3. 默认值：`https://aether.aiphys.cn`

要求：

- 配置值需要去除结尾 `/`。
- 开发环境可指向本地 aether-site API。
- 生产环境默认使用 v2 可用的认证服务域名 `https://aether.aiphys.cn`。
- 不应把 v2 认证 API Base 配置为 `https://skill.aiphys.cn`；Skill 域名只应作为 Skill Market 页面入口或兼容旧流程的历史域名。
- 文档中明确 CORS 需要允许 `http://127.0.0.1:<动态端口>` 和 `http://localhost:<动态端口>`。

### 5.3 注册流程

注册弹窗需增加验证码能力：

1. 用户输入邮箱后，可点击“发送验证码”。
2. 发送验证码前校验邮箱格式。
3. 点击后调用 `/v2/auth/register/code`。
4. 成功后按钮进入 60 秒倒计时，倒计时结束前不可重复发送。
5. 注册提交时必须包含 `email`、`password`、`name`、`verification_code`。
6. 注册成功后保存 `session_token`、`expires_at`、`account`，关闭弹窗并展示成功提示。

注册错误处理至少覆盖：

| 错误 | 客户端行为 |
|------|------------|
| 邮箱已注册 | 提示用户直接登录 |
| 验证码错误、过期或已使用 | 标记验证码输入错误 |
| 发送过于频繁 | 提示稍后重试，并保持倒计时或禁用短时间重试 |
| 弱密码 | 标记密码输入错误 |
| 参数错误 | 提示检查输入 |

### 5.4 登录流程

登录弹窗改用 `/v2/auth/login`。

登录成功后仍保存：

- `account`
- `session_token`
- `expires_at`

登录页需增加“忘记密码”入口。入口可以打开新弹窗，也可以在同一弹窗内切换视图。

登录错误处理至少覆盖：

| 错误 | 客户端行为 |
|------|------------|
| 邮箱或密码错误 | 显示统一错误，不区分账号是否存在 |
| 临时锁定或频率限制 | 提示稍后重试 |
| 会话响应缺字段 | 视为服务端协议异常，清理本地半成品状态 |

### 5.5 忘记密码与重置密码

忘记密码流程：

1. 用户输入邮箱。
2. 调用 `/v2/auth/password/forgot`。
3. 无论邮箱是否存在，成功响应都展示统一提示：“如果该邮箱已注册，重置邮件会发送到对应邮箱。”

重置密码流程：

1. 支持从重置链接打开客户端时读取 `reset_token`。
2. 在 Web 客户端中可以提供 `?reset_token=` 参数触发重置密码弹窗。
3. 用户输入新密码和确认密码。
4. 调用 `/v2/auth/password/reset`，请求体包含 `reset_token` 和 `new_password`。
5. 成功后清理本地会话，提示用户重新登录。

如果桌面端暂时无法承接重置链接，短期可跳转到 aether-site 的 `/auth/reset-password` 页面，但客户端内必须保留忘记密码入口和清晰提示。

### 5.6 会话迁移

当前本地持久化键为 `auth.v1`。迁移需要避免已有用户无故掉线。

建议策略：

1. 首次启动新版本时读取旧 `auth.v1`。
2. 如果存在 `session_token`，优先调用 `/v2/auth/me` 校验。
3. 校验成功后写入新结构，例如 `auth.v2`，并保留或清理旧键。
4. 校验失败则清理本地认证状态。

如果服务端 v1 和 v2 共享同一会话体系，旧 token 应该可以被 `/v2/auth/me` 接受。若不能接受，需要在发布说明中明确用户需重新登录。

### 5.7 UI 和文案

需要补充中文和英文文案。至少包括：

- 发送验证码
- 验证码
- 验证码已发送
- 重新发送倒计时
- 验证码错误或已过期
- 忘记密码
- 发送重置邮件
- 重置邮件统一成功提示
- 新密码
- 确认新密码
- 重置成功，请重新登录

其他语言可以先沿用英文或占位，但中文和英文必须完整。

### 5.8 CORS 与部署约束

由于 opencode Web 客户端通常运行在本地动态端口，认证 API 必须允许以下来源：

- `http://127.0.0.1:*`
- `http://localhost:*`
- 桌面端 WebView 对应 origin
- 生产 Web 域名

预检请求必须允许：

- `Authorization`
- `Content-Type`
- `GET`
- `POST`
- `OPTIONS`

若 v2 接口尚未对本地动态端口开放 CORS，客户端迁移会失败。该项应作为服务端与客户端联调前置验收。

## 6. 解耦方案

### 6.1 短期方案：客户端直连认证 API v2

短期内，客户端直接请求 `https://aether.aiphys.cn/v2/auth/*`。这样改动最小，可以快速恢复注册体验。

优点：

- 改动范围小。
- 可复用 aether-site 已有 v2 能力。
- 保持 `session_token` 模式，适合 Web、桌面和本地动态端口。

风险：

- 仍然依赖远程认证 API 的 CORS 与稳定性。
- 如果后端错误码变更，客户端仍需要同步更新。

### 6.2 中期方案：客户端认证契约层

在 `packages/app` 内建立明确的认证契约层，UI 只依赖本地方法，不直接感知接口路径。

要求：

- 所有 `/v2/auth/*` 路径只出现在认证适配层。
- UI 组件只处理表单状态和展示逻辑。
- 错误码映射集中维护，避免多个弹窗重复判断。
- API Base 集中配置。

这一步可以显著降低 aether-site 页面变化对客户端的影响。

### 6.3 长期方案：Aether Auth Gateway

长期可以考虑在 opencode 本地服务端或 Aether 统一后端中提供稳定的 Auth Gateway：

```text
packages/app UI -> local/opencode auth facade -> aether auth service
```

Gateway 负责：

- 统一 API 版本。
- 兼容服务端错误码变化。
- 做健康检查和降级提示。
- 为桌面端处理 deep link 重置密码。
- 隔离 aether-site 页面路由、Skill Market 域名和账号 API。

长期目标不是复制账号系统，而是让客户端依赖一个稳定 facade，而不是依赖站点页面实现细节。

## 7. 兼容与降级

1. 登录可临时保留 v1 fallback，但只应在 v2 返回 404、501 或明确不可用时触发。
2. 注册不建议静默 fallback 到 v1，因为 v1 不要求邮箱验证码，会绕过新的安全要求。
3. 若 v2 注册验证码不可用，应提示“账号注册服务暂不可用”，并提供跳转官网注册的入口。
4. 旧 token 校验失败时清理本地状态，不自动重试弱化认证流程。

## 8. 验收标准

1. 新用户可在客户端内输入邮箱、验证码、密码和昵称完成注册。
2. 点击发送验证码后，按钮进入 60 秒倒计时，倒计时期间不能重复发送。
3. 验证码错误、过期或已使用时，注册失败并提示验证码问题。
4. 注册成功后自动登录，侧边栏显示当前账号。
5. 已有用户可通过 `/v2/auth/login` 登录。
6. 登录成功后重启客户端，仍能通过 `/v2/auth/me` 恢复登录态。
7. 登出后本地状态立即清理，服务端会话失效。
8. 忘记密码入口可发送重置邮件，并展示统一成功提示。
9. 重置密码成功后，旧会话被清理，用户需要重新登录。
10. 本地动态端口访问生产认证 API 时，CORS 预检和实际请求都成功。
11. UI 组件中不再出现远程认证域名和 `/v1/auth/*` 硬编码。
12. 认证 API Base 可通过环境变量覆盖。

## 9. 分阶段实施建议

### Phase 1：最小 v2 迁移

- 将 `AuthProvider` 的登录、登出、me 改为 `/v2/auth/*`。
- 将默认 API Base 改为 `https://aether.aiphys.cn`。
- 注册弹窗增加验证码输入和发送验证码按钮。
- 补齐中文和英文文案。
- 验证本地动态端口 CORS。

### Phase 2：忘记密码与会话迁移

- 增加忘记密码弹窗。
- 增加重置密码弹窗或官网跳转方案。
- 实现 `auth.v1` 到 `auth.v2` 的本地状态迁移。
- 增加错误码集中映射。

### Phase 3：契约层与测试

- 将请求逻辑拆出为独立 auth client。
- UI 只调用 auth client 暴露的方法。
- 增加单元测试覆盖错误映射、注册验证码倒计时、会话迁移。
- 增加 E2E 覆盖登录、注册、忘记密码入口。

### Phase 4：Auth Gateway 评估

- 评估是否由 opencode 本地服务端代理认证请求。
- 评估桌面端 deep link 承接重置密码链接。
- 定义客户端与认证服务之间的长期稳定契约。

## 10. 开放问题

1. `https://aether.aiphys.cn/v2/auth/*` 是否已经对所有本地动态端口开放 CORS？
2. v1 登录产生的 `session_token` 是否一定能被 `/v2/auth/me` 接受？
3. 重置密码邮件中的链接应优先打开官网页面，还是支持桌面端 deep link？
4. 是否需要在客户端暴露账号中心入口，用于跳转 API Key 管理和昵称修改？
5. 错误码是否已有稳定枚举，能否作为客户端契约写入 shared schema？

## 11. 推荐结论

推荐先执行 Phase 1 和 Phase 2。短期内不要继续跟随 `skill.aiphys.cn` 的 v1 分支；客户端应默认直连 v2 认证 API，并把域名和接口路径集中在认证适配层。这样可以尽快恢复注册、登录、忘记密码体验，同时为后续 Auth Gateway 或 shared schema 留出空间。
