# Aether Cron 前端 UI 设计建议（基于当前已实现后端）

本文不是当前实现说明，而是基于现有 cron 后端能力给出的 UI 设计建议。目标是：

- 不偏离已落地接口
- 先做最小可用体验
- 尽量避免 UI 设计倒逼内核返工

参考对象：

- Hermes Agent cron
  - https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/
  - https://hermes-agent.nousresearch.com/docs/developer-guide/cron-internals
- OpenClaw scheduled tasks / automation
  - https://docs.openclaw.ai/automation/cron-jobs
  - https://docs.openclaw.ai/automation

这些系统给 Aether UI 的主要启发是：

- cron 必须有清楚的状态与运行历史入口
- isolated / session 类任务要把上下文差异讲明白
- 用户需要一条“为什么没跑”的排障路径
- cron 和 heartbeat / 后台任务不是同一种产品语义
- 创建入口可以简单，但详情页和日志必须可信

## 0. 当前 UI 现状

目前真正已经落地的 cron UI 只有一项：

- cron 注入消息在消息头显示一个简单 badge：
  - `Cron`

也就是说：

- 当前没有 cron 管理页
- 没有 run log 页面
- 没有 job 创建/编辑表单

因此这份文档的重点不是“描述已有 UI”，而是“给下一步 UI 实现提供不返工的落地方向”。

## 1. 设计原则

当前后端已经具备：

- job CRUD
- run now
- run history 查询
- job definition + runtime state 分离
- 四种 mode
- cron message badge

外部参考中的可借鉴点：

- Hermes 把 cron 管理收成一个清晰的生命周期：
  - list / pause / resume / run / remove / status
- OpenClaw 把 scheduled tasks、heartbeat、background tasks 分开解释，降低用户误用成本
- OpenClaw 的排障文档强调：
  - gateway 是否运行
  - cron 是否 enabled
  - job 是否 due
  - run history / logs 里发生了什么

对应到 Aether，第一版 UI 不应只做“创建任务”，而应优先做：

- 看 job 当前状态
- 看下一次运行时间
- 看最近运行结果
- 手动 run now
- 看清楚这次 run 落到了哪个 session

所以前端第一版应遵守三个原则：

1. **以 definition + state 为核心展示单位**
   - 不要只展示 definition
   - 否则 `expired / running / next_run_at` 这些关键信息会丢

2. **先管理全局 cron，不提前做 workspace 级 UI**
   - 当前后端就是 global cron
   - 前端不应提前制造 workspace-scope 幻觉

3. **表单设计要服务于 mode，不强行抽象成一种统一任务卡**
   - `direct`
   - `isolated_agent`
   - `session_agent`
   三者输入项差异是真实存在的

## 2. UI 信息架构建议

我建议第一版 cron UI 放在：

- `Settings > Cron`

并拆成 4 个区域：

1. **Global**
   - 展示全局执行开关状态
   - 展示 scheduler 正在运行但 execution 是否被禁用

2. **Jobs**
   - 列表展示所有 job
   - 每条展示：
     - name
     - mode
     - schedule_type
     - definition.enabled
     - state.enabled
     - next_run_at
     - last_status
     - running

3. **Job Detail / Editor**
   - 查看 definition 原文
   - 查看 state
   - 编辑 definition
   - 手动 run now
   - 删除 job

4. **Recent Runs**
   - 按 job 查看最近 runs
   - 先做每个 job 的最近 N 条
   - 不必一开始做全局 run timeline

5. **Troubleshooting**
   - 给出一组只读诊断信息
   - 不需要做复杂 doctor
   - 但要让用户知道下一步该查什么

## 2.1 组件拆分建议

如果按现有前端结构实现，我建议大致拆成：

- `settings-cron.tsx`
  - 顶层容器
- `settings-cron-global.tsx`
  - 全局 execution 状态
- `settings-cron-job-list.tsx`
  - job 列表
- `settings-cron-job-detail.tsx`
  - 单 job detail / runtime state / recent runs
- `settings-cron-editor.tsx`
  - create / edit 表单
- `settings-cron-run-list.tsx`
  - run 列表区块

这样后续就算不一次性做完整页面，也能按模块逐步上。

## 3. Job 列表建议

列表项建议至少包含这些视觉元素：

- 标题：`name`
- 次级信息：
  - `mode`
  - `schedule_type`
  - `schedule_value`
- 状态 badge：
  - `Enabled`
  - `Disabled`
  - `Expired`
  - `Running`
  - `Skipped`
  - `Failed`
- 时间信息：
  - `Next run`
  - `Last run`

受 OpenClaw `cron list --verbose` 这类命令启发，列表里最好直接展示 `next_run_at`，不要只展示“enabled”。
用户判断 cron 是否正常，第一眼最关心的通常就是：

- 这个任务现在是不是 active
- 下一次到底什么时候跑
- 上一次结果是什么

建议把 `definition.enabled` 和 `state.enabled` 的组合收成一个更易懂的展示：

- `Active`
  - 两者都为 true
- `Paused`
  - definition false
- `Expired`
  - state false + last_status expired
- `Blocked`
  - 其他 state false 场景

这样用户不需要理解两层 enabled 才能读懂列表。

列表上的主操作我建议直接放：

- `Run now`
- `Edit`
- `Delete`

把不常用动作收进二级菜单，避免第一版太重。

我暂时不建议第一版做 `Pause` / `Resume` 两个单独按钮。
原因是 Aether 当前 definition/state 有两层 enabled，直接显示一个 `Enabled` 开关更贴合现有实现；等 UI 更成熟后，再把它包装成 pause/resume 语义。

## 4. 创建 / 编辑表单建议

第一版不建议让用户直接手写完整 JSON。
更好的做法是：

- 默认表单编辑
- 高级模式再显示原始 JSON 预览

我建议 create/edit 流程默认是：

1. 先选 `mode`
2. 再选 `schedule_type`
3. 然后根据 mode 显示必要字段
4. 最后再展开 `payload` 的高级 JSON 视图

这样用户不需要先理解全部 schema 才能开始创建 job。

从 Hermes / OpenClaw 可以借鉴的一点是：创建 cron 的入口要“任务导向”，不要让用户一上来面对完整 JSON。
但 Aether 当前 payload 是自由 JSON，所以 UI 也不能隐藏太多细节。比较稳的折中是：

- 常规字段用表单
- `payload` 提供 mode-specific 简表单
- 同时保留高级 JSON 预览

### 4.1 通用字段

- `name`
- `enabled`
- `mode`
- `schedule_type`
- `schedule_value`
- `timezone`

### 4.2 mode 切换后的条件字段

**direct**
- `payload.action`

**isolated_agent**
- `project_id`
- `payload.message`

**session_agent**
- `project_id`
- `session_id`
- `payload.message`

### 4.3 交互建议

不要把不适用字段隐藏得完全不可见；建议：

- 折叠掉不适用字段
- 但在高级视图里仍然能看到完整 definition

原因：
- 后端会保留未知/多余字段
- UI 不应擅自把用户 definition 洗掉

## 4.4 表单字段映射建议

推荐的最小表单映射：

- 通用区：
  - `name`
  - `enabled`
  - `mode`
  - `schedule_type`
  - `schedule_value`
  - `timezone`
- Mode-specific 区：
  - `direct` -> `payload.action`
  - `isolated_agent` -> `project_id`, `payload.message`
  - `session_agent` -> `project_id`, `session_id`, `payload.message`
  - `agent_message` -> `project_id`, `session_id`, `payload.message`, optional `payload.agent`
- 高级区：
  - 原始 `payload` JSON 预览/编辑

## 5. 运行态展示建议

Job detail 页面建议单独有一个 “Runtime State” 区块，展示：

- `state.enabled`
- `next_run_at`
- `last_run_at`
- `last_status`
- `running`
- `start_at`（仅 interval 时展示）

重点是：
- 让用户清楚知道 definition 和 runtime state 是两层
- 尤其对 `once` 的 `expired` 很关键

这个区块我建议用只读 key-value 风格，不要做成可编辑表单，避免让人误解这些字段可以直接改。

## 6. Run Log 视图建议

每条 run 建议展示：

- `status`
- `started_at`
- `finished_at`
- `trigger_reason`
- `mode`
- `project_id`
- `session_id`
- `created_session_id`
- `output_summary`

默认不要直接展开 `payload_snapshot`，而是：

- 提供一个折叠区域
- 点开后再看 JSON

否则 run 列表会非常吵。

我建议 run 列表的默认密度偏紧凑，先展示：

- 时间
- 状态
- `trigger_reason`
- `output_summary`

需要排障时再展开详细字段。

这里应当把 run log 当作 Aether cron 的“任务 ledger”。
OpenClaw 明确把 cron 执行和 background task records 关联起来；Aether 当前没有单独 task ledger，因此 `cron_run` 就是第一版最重要的审计入口。

所以 run log UI 不只是“历史记录”，还承担：

- 证明任务确实触发过
- 解释任务为什么 skipped / failed
- 链接 cron 消息与 session
- 帮助排查 session fallback

## 7. 四种 mode 的 UI 细节

### 7.1 direct

建议给用户明确提示：

- 不会进入任何 session
- 结果只体现在 run log

这类任务更接近 Hermes 的 script-backed / tool-backed job 思路：它适合稳定后端动作，不适合依赖聊天上下文。

### 7.2 isolated_agent

建议提示：

- 会创建一个新的正常 session
- 第一条消息会带 `Cron` 标记

并在 run detail 里给出：

- `created_session_id`

未来如果前端已有 session 跳转能力，可以把它做成链接。

Hermes 默认强调 fresh agent session；OpenClaw 也把 isolated 作为避免污染主会话的推荐路径。
所以 Aether UI 应该把 `isolated_agent` 呈现为“安全、独立、可追踪”的默认 agent 模式，而不是一个高级隐藏选项。

### 7.3 session_agent

这里最容易让用户误解，UI 必须解释清楚：

- 系统会优先尝试指定 session
- 若 session 无效但 project 仍有效，可能新建 session 回退执行

建议 detail 区显式展示：

- `requested_session_id`
  - 来自 definition
- `actual_session_id`
  - 来自 run log `session_id`
- `created_session_id`
  - 若回退新建了 session

否则用户会看到“成功”，但不知道其实已经换线程了。

OpenClaw 文档里反复提醒 main/session 类任务可能受 heartbeat、active chat、session busy 等因素影响。
Aether 当前没有 heartbeat 依赖，但 `session_agent` 仍有“原 session 不可用时回退新建”的语义。UI 必须把这个风险前置展示。

## 7.4 mode 文案建议

为了避免用户误选 mode，表单里最好给每个 mode 一句非常短的解释：

- `direct`
  - 直接执行后端 action，不进入会话
- `isolated_agent`
  - 新建独立 session 执行
- `session_agent`
  - 在指定 session 继续发消息，必要时可能回退到新 session
- `agent_message`
  - 直接写入一条 assistant 通知，不触发 LLM 推理

## 8. Global 开关 UI 建议

当前后端已有：

- scheduler 一直运行
- `cron.enabled` 只控制 execution

所以前端全局区域建议明确写：

- `Scheduler: Running`
- `Execution: Enabled / Disabled`

不要只写一个模糊的 “Cron enabled”，否则会误导用户以为整个 scheduler 都停了。

这里可以借鉴 OpenClaw troubleshooting 的思路，把顶部卡片做成一个小型 status panel：

- `Scheduler`
  - Running
- `Execution`
  - Enabled / Disabled
- `Jobs`
  - total / active / expired / running
- `Last activity`
  - 最近一次 run 的时间和状态

## 9. 错误与边界提示建议

UI 第一版最好把这些边界直接写进帮助文案：

- 调度精度是分钟级，不是秒级
- server 启动后第一次执行要等到下一个 60s tick
- `once` 过期后不会自动补跑
- `session_agent` 可能回退到新 session
- `direct` 不进入会话，只写 run log

这会极大减少误解。

另外建议加一个很短的 “When should I use Cron?” 帮助块，借鉴 OpenClaw 的 Cron vs Heartbeat 说明：

- 用 cron：
  - 精确时间
  - 独立任务
  - 周期报告
  - 一次性提醒
- 不要用 cron：
  - 需要持续感知但不要求精确时间
  - 多个轻量检查可以批处理
  - 需要复杂条件判断但没有 direct action 支持

Aether 当前还没有 heartbeat UI，但提前保留这个文案位置，后续加 heartbeat 时不会返工。

## 9.1 排障入口建议

第一版建议在 Job Detail 下放一个 `Troubleshooting` 折叠块，内容直接根据当前 state/run 生成：

- `No runs yet`
  - 提示检查 `next_run_at`
- `Execution disabled`
  - 提示全局 cron 或 job enabled 状态
- `Expired once`
  - 提示 once 已过期，不会自动补跑
- `Last run failed`
  - 展示最近一次 `output_summary`
- `session_agent created a new session`
  - 提示原 session 不可用，已回退新 session

这会比单纯给用户一堆字段更友好。

## 10.1 全局开关展示建议

因为当前后端设计里：

- scheduler 一直运行
- `cron.enabled` 只控制 execution

所以全局顶部卡片建议拆成两行：

- `Scheduler`
  - 固定显示 `Running`
- `Execution`
  - `Enabled` / `Disabled`

不要只做一个布尔开关文字，不然很容易让人误读成“整个 cron 后端已经停了”。

## 10. 推荐的 v1 实现顺序

### Phase 1

- `Settings > Cron`
- 全局 status panel
- job 列表
- 单 job detail
- run now
- delete
- recent runs
- job troubleshooting 折叠块

### Phase 1.5

- create / edit 先做最小表单
- 不做复杂 JSON editor
- 不做 run detail drawer

### Phase 2

- create / edit 表单
- mode-specific 帮助文本
- payload JSON 高级视图

### Phase 3

- session 跳转链接
- run detail drawer
- 更完整的过滤/搜索/状态标签
- delivery / notification 预留位
- heartbeat / cron 决策帮助

## 11. 当前已经有的 UI 行为

当前唯一已落地的 cron 前端可见行为是：

- cron 注入消息在消息头显示一个简单 badge：
  - `Cron`

这说明后面做 Cron 页面时，视觉语言可以沿用这一点：

- badge / tag 风格
- 简单、明确
- 不做太重的装饰

## 12. 我的建议

如果现在就开始做前端，我建议顺序不要太大：

1. 先做 `Settings > Cron` status panel + 只读列表
2. 补单 job detail、recent runs、troubleshooting
3. 加 `Run now` / `Delete`
4. 最后补 create / edit 表单

原因很简单：

- 当前后端的 definition/state/run 三层语义已经比较完整
- UI 第一阶段最重要的是把“看得见”和“能手工触发”先做出来
- 表单是最容易在 v1 里做重的部分，适合后放

相比 Hermes / OpenClaw，Aether 现在缺的不是 scheduler 能力，而是：

- 状态可见性
- run log 可读性
- mode 选择解释
- 失败/跳过原因的可理解性

所以前端第一阶段应该优先解决这些，而不是急着做一个功能很全但解释不足的创建器。
