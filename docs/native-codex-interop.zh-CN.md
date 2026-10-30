# Codex 互通验证：历史、实时流与执行归属

状态：**第一阶段验证报告**。验证日期为 2026-10-26，基于本机 `codex-cli 0.164.0-alpha.11.1`。后续已接入的历史读取与权限界面见[当前产品说明](native-codex.zh-CN.md)，更完整的目标见[数据边界设计](native-codex-history-design.zh-CN.md)；本报告中的共享服务实验不表示已实现 Desktop 实时同步。

## 结论

Codex 可以作为 Aether 原生会话历史的权威来源。本次已用真实 Codex 进程验证历史持久化、跨进程读取、轮次与 item 分页，以及连接同一个 app-server 的两个客户端接收相同流式事件。

**独立启动 app-server 并共享存储，不能据此判断另一个客户端的执行状态。** 在本次可重复的实验中，进程 A 仍在生成并报告 `active`，进程 B 却报告 `notLoaded`，读出的未完成轮次显示 `interrupted`，且没有收到 A 的文字增量。A 完成后，B 再次读取才能得到一致的完整历史。因此不能据此自动重发、恢复“中断”任务或接管 Desktop。

同一 app-server 多客户端流式验证，也不等于接入了 Desktop 正在使用的服务。正式客户端之间还有额外协调层，见下文。

## 可复现的运行验证

在仓库根目录执行诊断脚本；这不是从仓库根目录运行 `bun test`：

```powershell
bun script/codex-interop.ts "C:/path/to/codex.exe"
```

脚本为每次运行创建独立临时 home、项目和配置，不使用 Aether 数据库。子进程仅继承操作系统所需环境变量，`CODEX_HOME` 和用户目录均指向临时位置；不继承账户密钥。它运行真实 `codex app-server`，仅把上游模型服务替换为本地确定性 Responses SSE fixture。配置中的模型名只是协议测试标识，不会调用该远端模型；fixture 拒绝携带 Authorization 的模型请求。

总共发送五轮合成输入，无工具调用。WebSocket 监听由操作系统分配端口，端点取自本次子进程的输出，并使用每次随机的 capability token；握手后检查返回的 Codex home，避免连接已有服务。脚本不连接 Desktop IPC，不重启 Aether 或 Desktop，不读取真实对话。它验证的是配置隔离与协议行为，不是对 Codex 所有后台网络活动的审计。

标准输出给出临时证据目录，包含 `report.json`、双向 `protocol.jsonl`、fixture 收到的 `requests.json` 和子进程日志。目录保留供审查；脚本只关闭自己启动的进程和监听。退出码 0 表示本次断言及清理通过，非 0 时查看失败项。

| 验证项           | 结果与范围                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| 原生持久化历史   | 用户输入、回复、turn/item ID 可从真实原生历史取回                                                         |
| 发送关联         | `clientUserMessageId` 在用户 item 的 `clientId` 中返回；**没有证明重复请求会被去重**                      |
| 独立进程读取     | 进程 B 可在不 resume 的情况下读到与 A 一致的已完成历史                                                    |
| 轮次与 item 分页 | 每页仅取一条，遍历游标；完整 item 内容与轮次历史匹配                                                      |
| 历史格式         | 显式创建的 `paginated` 和 `legacy` 线程均可通过轮次接口读取；本次仅在 paginated 线程验证 item 分页        |
| 外部生成期间读取 | 记录到上述 `active` / `notLoaded` / `interrupted` 差异；这是该版本的观测，不是未来版本的固定断言          |
| 同服务双客户端   | 两个客户端同时连接独立测试 WebSocket app-server，经 resume 后收到相同 turn/item 的两段文字增量和完成事件  |
| 重连             | 跟随客户端断开重连并 resume，读取到相同原生历史；不表示重连期间所有事件可重放                             |
| 自动审批参数     | `thread/start` 和 `turn/start` 接受 `auto_review`；测试没有需要审批的工具调用，**未验证实际风险审查执行** |
| Desktop 实时接入 | 未实测；不能用同服务测试替代                                                                              |

首次探索还发现：新线程尚未发送第一轮时，另一个客户端直接 resume 返回 `no rollout found`。验证脚本先完成一轮，再验证 resume。生产实现需区分尚未持久化的新线程和既有线程丢失，不能把两者都当作可重新建线程的理由。

实验显式选择历史格式，因此初始化启用了 `experimentalApi`。这不意味着下表所有方法都是实验接口。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)介绍了分页接口，同时将 app-server 命令与 WebSocket 传输标为实验性、尚不支持生产工作负载；本次没有因此把 Aether 的 stdio 适配改成 WebSocket。

## 本机 schema 核查

对安装程序分别运行 `app-server generate-json-schema`，比较带与不带 `--experimental` 的输出。下表的“非实验输出”只指该版本的生成分类，不承诺所有历史版本支持，也不代替运行验证。

| 能力                           | 本机 schema 证据                                                 | 实现决策                                                               |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `thread/turns/list`            | 非实验输出存在；默认降序、`itemsView: summary`                   | 显式请求 full 或继续 item 分页，不能把 summary 当完整历史              |
| `thread/items/list`            | 非实验输出存在；默认升序，可按 turn 限定                         | 顺序和游标交给 Codex，处理存储不支持该方法的情况                       |
| `turn/start.approvalsReviewer` | 非实验输出含 `user`、`auto_review`、旧兼容值 `guardian_subagent` | 可以逐轮应用会话选择，无需改全局配置；新会话计划默认 auto_review       |
| `thread/settings/update`       | 仅实验输出存在                                                   | 不将其作为首版权限切换的必需依赖                                       |
| `turn/steer`                   | 非实验输出存在，必须传 `expectedTurnId`                          | 后续可加入，但需确定执行归属并处理轮次变化                             |
| `thread/fork`                  | `lastTurnId` 非实验，包含指定轮；不能指定运行中轮次              | 分叉后重读原生历史；带 goal 的分叉可能自动继续，不能一律视为无推理操作 |
| `thread/compact/start`         | 非实验输出存在；旧 `thread/compacted` 通知已弃用                 | 观察 `contextCompaction` item 等完成证据，不能将 RPC 返回当作完成      |

线程顶层的 model/reasoningEffort 描述的是当前或最近持久化配置，不能用它给每个历史轮次标注同一个模型。`thread/resume.history` 标为 Cloud 专用，不应通过拼接 Aether 历史再上传来实现同步。

## 官方客户端之间的协调层

静态核查本机 VS Code 扩展 `openai.chatgpt-26.1021.22027-win32-x64` 的 `out/extension.js` 与 `webview/assets/src-622b307a9baf.js`，确认存在以下实现；没有连接其 IPC 或读取真实会话：

- IPC 使用长度前缀 JSON 帧，initialize 分配 clientId，与 app-server JSONL 不同。
- `thread-owner-discovery` 发现执行方；follower 将发送、steer、中断、审批等请求交给 owner，由 owner 调用自身 app-server。
- 跟随时取得 `snapshot {revision, conversationState}`，随后接收带 `baseRevision` 的 patches；owner 或版本不匹配时不直接应用增量。
- 各方法独立版本化；本安装的状态广播版本 11、start 版本 2、中断版本 4，另有兼容分支。

[官方开发者设置说明](https://learn.chatgpt.com/docs/developer-settings)确认桌面端与 IDE 可以共享活跃会话和上下文。但本次没有找到上述内部协调协议面向第三方的公开兼容承诺，静态实现不能当作稳定 API 契约。

因此后续先落地权威历史读取、独立待发送记录和科研资源管理，再单独验证实时跟随的连接方式。不能在 owner 不明时直接启动第二个执行方；不能为追求表面实时效果，用轮询磁盘冒充可靠的实时会话同步。

## 当前未覆盖

此次验证使用短文本和本地固定回复，尚未覆盖真实 Desktop/VS Code 互通、图片与 PDF 的完整历史恢复、工具结果与子智能体、长历史分页更新竞态、实际自动审批、steer/fork/compact 执行，以及旧版 Codex 的兼容行为。这些仍是后续实现和验收项。

现有产品实现与限制见 [Codex 原生智能体](native-codex.zh-CN.md)；数据拆分、迁移与验收见[历史设计](native-codex-history-design.zh-CN.md)。

## 2026-10-30：原生写入归属与主动释放

使用同一 `0.164.0-alpha.11.1` 安装、独立临时 `CODEX_HOME` 和本地固定 Responses 回复追加核查；不读取真实账户、不调用在线模型，也不接入 Desktop 私有 IPC。可通过 `script/codex-interop.ts` 重现。

| 观察                                                                                                | 结论                                                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A 正在生成时，B 的 `thread/read` 仍显示 `notLoaded`，历史末轮可显示 `interrupted`                   | 独立读取结果不能用来断言其他客户端空闲                                                      |
| B 调用 `thread/resume` 返回 `-32600: thread … already has an active writer`                         | 该版本由 Codex 原生进程锁拒绝第二个写入方，Aether 不读写锁文件                              |
| A 已结束生成但仍加载线程时，B 的 resume 仍被拒绝                                                    | 保留进程及已加载线程会保留写入归属；“当前没生成”不等于已交接                                |
| A 正在生成时，B 能对已完成的前缀执行 `thread/fork`                                                  | fork 本身不取得源线程写锁；Aether 分叉前先检查 goal、resume 源线程、确认 idle，再读取并分叉 |
| 诊断线程设置 `thread_unload_delay_secs: 0` 后 unsubscribe，收到 `thread/closed`，B 随后 resume 成功 | 原生卸载会释放写入归属，但每轮卸载也会丢失进程内工具状态，因此未将其作为 Aether 默认策略    |

当前 Aether 保持空闲进程复用，增加手动释放入口。释放只关闭该会话自己的空闲执行进程；本地仍在运行、排队、回答问题、验证回退/压缩结果或存在未确认提交时会拒绝。对已绑定的连接还读取该进程加载的线程与 goal，检查子任务，未知状态会拒绝。再次在 Aether 发送时重新 resume 原线程，不复制历史、不重发旧输入。

发送、回退及压缩沿用原生 resume；本次统一将写锁冲突转成可操作的提示。审批和 MCP 表单仍只回复发出请求的原连接，不能在 Aether 中代答 Desktop 正在等待的卡片。尚未实现 Desktop 与 Aether 同时控制同一任务、实时转发审批或自动抢占；旧 Codex 版本也不能仅凭上述单版本诊断承诺具有相同写锁语义。
