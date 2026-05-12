# Aether Cron 系统（当前实现）

本文描述当前代码中已经落地的 cron 基础设施实现，目标代码范围主要在：

- `packages/opencode/src/cron/`
- `packages/opencode/src/server/routes/cron.ts`
- `packages/opencode/src/server/server.ts`
- `packages/ui/src/components/message-part.tsx`
- `packages/app/src/components/settings-cron.tsx`

本文只描述**当前已经实现**的能力、接口和边界。

## 0. 当前已实现功能总览

当前已经落地的 cron 功能可以直接概括为：

- 全局 cron 基础设施
- JSON job definitions
- SQLite runtime state
- SQLite run log
- 分钟级 scheduler
- 四种执行模式：
  - `direct`
  - `isolated_agent`
  - `session_agent`
  - `agent_message`
- `/cron` HTTP API
- 可直接在后端复用的内部函数接口
- agent 可调用的 cron 工具
- Settings > Cron 管理页、全局执行开关、自然语言创建/修改入口
- cron 消息 metadata 与前端 `Cron` badge
- dev-only 的调试 direct action：
  - `debug_noop`

当前**还没有**落地的部分：

- Run log 专门页面
- 结构化 Job 创建/编辑表单 UI
- workspace-scope cron
- 秒级调度

## 1. 设计目标

当前 cron 系统被实现为一层**全局后端基础设施**，而不是某个业务模块的附属功能。设计目标是：

- 允许系统内部或后续 UI/API 创建定时任务
- 允许任务通过四种模式执行：
  - `direct`
  - `isolated_agent`
  - `session_agent`
  - `agent_message`
- job definition 可读、可编辑
- 运行态与历史记录可查询
- 尽量少改 agent/session/provider 内核

当前版本定位为：

- 本地单用户基础设施
- 分钟级调度
- 后端自动运行
- API 优先，UI 提供轻量管理与自然语言入口

## 2. 整体架构

当前实现可分成 4 层：

1. **Definition 层**
   - 一个 job 一个 JSON 文件
   - 存在 Aether data 目录下

2. **Runtime State 层**
   - SQLite 表 `cron_job_state`
   - 保存下一次触发时间、最后状态、是否在运行等运行态

3. **Run Log 层**
   - SQLite 表 `cron_run`
   - 保存每次执行/跳过的历史记录

4. **Scheduler / Executor 层**
   - server 启动后自动启动 scheduler
   - 每 60s 扫描一次 definitions 并尝试调度
   - 按 mode 分发到 direct 或 agent 执行链

## 2.1 核心代码入口

当前最关键的入口文件是：

- `packages/opencode/src/cron/index.ts`
  - 核心 cron 服务实现
- `packages/opencode/src/cron/schema.ts`
  - Zod schema 与公共类型
- `packages/opencode/src/cron/cron.sql.ts`
  - SQLite 表定义
- `packages/opencode/src/server/routes/cron.ts`
  - `/cron` HTTP 路由
- `packages/opencode/src/server/server.ts`
  - scheduler 挂载与 server 接入
- `packages/ui/src/components/message-part.tsx`
  - 前端 `Cron` badge

## 3. 持久化结构

### 3.1 job definition（JSON 文件）

job 定义文件保存在 Aether data 目录下：

```text
<Aether data dir>/cron/jobs/<job_id>.json
```

当前文件名固定为：

```text
job_id.json
```

definition 文件读取顺序：

- 由每次 tick 扫描 job 目录得到
- 列表返回按文件扫描顺序组织

### 3.2 runtime state（SQLite）

当前运行态保存在 `cron_job_state` 表中。

字段语义：

- `job_id`
- `enabled`
  - 运行态是否允许被调度
- `next_run_at`
- `last_run_at`
- `last_status`
  - `success | failed | skipped | expired | null`
- `running`
- `start_at`
  - 仅 `interval` 调度需要
- `updated_at`
- `definition_snapshot`
  - 内部运行态快照，用于扫描/对比/恢复

注意：
- `definition.enabled` 是用户意图
- `state.enabled` 是运行态实际许可
- scheduler 只有在两者都为 `true` 时才会调度

### 3.3 run log（SQLite）

运行历史保存在 `cron_run` 表中。

当前字段集合为：

- `run_id`
- `job_id`
- `started_at`
- `finished_at`
- `status`
  - `success | failed | skipped`
- `output_summary`
- `mode`
- `project_id`
- `session_id`
- `created_session_id`
- `payload_snapshot`
- `trigger_reason`
  - `scheduled | manual`

run log 当前不单独保存：

- `skip_reason`
- `error_message`
- `job_name_snapshot`
- `job_file_path_snapshot`

## 4. job definition 格式

当前顶层字段固定为：

- `id`
- `name`
- `enabled`
- `mode`
- `project_id`
- `session_id`
- `schedule_type`
- `schedule_value`
- `timezone`
- `payload`

一个最小 definition 例子：

```json
{
  "id": "01JS8Q7MKG7WQ1M7B64P73JYQE",
  "name": "Nightly Health Check",
  "enabled": true,
  "mode": "direct",
  "project_id": null,
  "session_id": null,
  "schedule_type": "cron",
  "schedule_value": "0 3 * * *",
  "timezone": "Asia/Shanghai",
  "payload": {
    "action": "debug_noop"
  }
}
```

未知额外字段允许存在，并会被原样保留。

### 4.1 mode

当前合法值固定为：

- `direct`
- `isolated_agent`
- `session_agent`
- `agent_message`

### 4.2 schedule_type

当前合法值固定为：

- `cron`
- `interval`
- `once`

### 4.3 schedule_value

- `cron`
  - 5 段 cron 表达式
  - 例如：`0 3 * * *`
- `once`
  - 同样使用 5 段 cron 表达式
  - 但系统只消费第一次命中
- `interval`
  - 正整数秒数
  - 例如：`3600`

### 4.4 timezone

- 对 `cron` / `once`
  - 可省略
  - 默认使用系统时区
- 对 `interval`
  - 可以存在，但会被忽略

### 4.5 payload

`payload` 当前是**自由 JSON**，不做统一业务 schema。

但不同 mode 有最低要求：

- `direct`
  - `payload.action: string`
- `isolated_agent`
  - `payload.message: string`
- `session_agent`
  - `payload.message: string`
- `agent_message`
  - `payload.message: string`
  - 可选 `payload.agent: string`
  - 可选 `payload.model: { providerID: string, modelID: string }`

这些字段：

- 校验时会使用 trim 后结果判断是否为空
- 但存储时保留原始值，不自动 trim

## 5. 校验与更新语义

### 5.1 创建

通过 API / 内部函数创建 job 时：

- `id` 由系统自动生成
- 用户不能手工传入 `id`
- 创建后立即：
  - 写入 definition 文件
  - 初始化 runtime state

默认值：

- `enabled` 默认 `true`
- `project_id` 默认 `null`
- `session_id` 默认 `null`
- `payload` 默认空对象
- `timezone` 对 `cron/once` 默认为系统时区

### 5.2 更新

更新采用 patch 语义：

- patch 合并到现有 definition
- 然后做完整校验
- 通过后才写回文件

当前不可变字段：

- `id`

允许更新：

- `name`
- `enabled`
- `mode`
- `project_id`
- `session_id`
- `schedule_type`
- `schedule_value`
- `timezone`
- `payload`

更新成功后会立即重算 runtime state，不等下一次 tick。

### 5.3 创建/更新后的返回结构

`createJob` / `updateJob` / 对应 HTTP API 返回结构统一为：

```json
{
  "definition": { "...": "..." },
  "state": {
    "job_id": "01JS8Q7MKG7WQ1M7B64P73JYQE",
    "enabled": true,
    "next_run_at": 1776702000000,
    "last_run_at": null,
    "last_status": null,
    "running": false,
    "start_at": null,
    "updated_at": 1776699200000
  }
}
```

### 5.4 definition 与 state 的关系

重要语义：

- `definition.enabled`
  - 表示用户/调用方是否想启用这个任务
- `state.enabled`
  - 表示运行态是否仍允许调度

举例：

- 普通启用 job
  - 两者都可能是 `true`
- `once` 任务过期
  - `definition.enabled` 保留原始意图
  - `state.enabled = false`
  - `last_status = expired`

## 6. 四种执行模式

### 6.1 direct

语义：

- 不经过 session
- 直接执行后端 direct action handler

要求：

- `payload.action`

执行结果：

- 只写 run log
- 不自动往任何 session 写消息

### 6.2 isolated_agent

语义：

- 在指定 `project_id` 下创建一个新的正常 session
- 以 `payload.message` 作为首条普通用户消息

要求：

- `project_id`
- `payload.message`

行为：

- 新 session 是可见的正常 session
- 首条消息会带 cron metadata
- run log 会记录：
  - `session_id`: 实际投递的 session
  - `created_session_id`: 本次新建的 session
- Settings > Cron 的最近运行记录会提供“打开会话”链接，直接跳转到这个新 session
- 如果前端收到该 session 的 `session.created` 事件时发现对应 project 不在侧边栏项目列表里，会用事件里的 `projectID + directory` 自动补一个最小 project 记录，避免新会话成为无法打开的“幽灵会话”
- 前端收到后台 `session.created` 时会同时预热对应 project 的 child store，使后续 `message.part.delta` 等流式事件有接收目标；点击“打开会话”时会先把该 project 加入侧边栏项目列表，再加载该 project 的 session 列表并跳转
- Layout 路由层也会在进入 project/session URL 时确保对应 root project 已加入侧边栏，覆盖刷新或外部链接进入的情况

### 6.3 session_agent

语义：

- 尝试在指定的 `session_id` 上继续发一条普通用户消息

要求：

- `project_id`
- `session_id`
- `payload.message`

回退规则：

- 如果原 `session_id` 已失效
- 但 `project_id` 仍有效
- 则在同 project 下新建一个 session 并继续执行

若 `project_id` 无效：

- run 记为 `failed`

### 6.4 agent_message

语义：

- 尝试在指定的 `session_id` 上直接写入一条 assistant 消息
- 不触发 LLM 推理，也不会插入新的用户消息
- 适合“定时提醒我”“系统主动通知我”这类通知型任务

要求：

- `project_id`
- `session_id`
- `payload.message`

可选字段：

- `payload.agent`
  - 控制这条 assistant 消息显示为哪个 agent
  - 省略时使用默认 agent
- `payload.model`
  - 控制消息记录里的模型标识
  - 省略时依次使用 agent model、目标 session 最近用户消息的 model、默认 model

回退规则：

- 如果原 `session_id` 已失效
- 但 `project_id` 仍有效
- 则在同 project 下新建一个 session 并写入 assistant 消息

注意：

- 这不是“让 LLM 回复”，只是直接生成一条 assistant 侧通知消息
- 如果需要 LLM 读取上下文并生成回复，应使用 `session_agent`

## 6.5 dev-only 调试 direct action

当前实现里还带了一个只用于开发/测试的 direct action：

- `debug_noop`

它的目的只是：

- 验证 cron scheduler
- 验证 direct mode 接线
- 验证 run log 与状态流

它不是正式业务能力，不应被视为产品功能。

## 6.6 自然语言 Cron Assistant

Settings > Cron 页面提供一个简短自然语言输入框，用于创建新任务或修改当前选中的任务。

入口行为：

- 未选中 job 时，提示为“创建新的定时任务”。
- 选中 job 时，提示为“修改定时任务：<任务名>”。
- 点击页面空白区域会取消当前选中，恢复为创建模式。
- assistant 只允许创建/修改 cron job；如果输入不是 cron 创建/修改意图，应返回 `reject`。

上下文绑定规则：

- 默认创建普通提醒或 agent 任务时使用 `isolated_agent`。
- `isolated_agent` 只绑定 `project_id`，不要求 `session_id`。
- 只有用户明确说“当前会话”“继续这个 session”“在这个对话里提醒我”等会话绑定意图时，才应使用 `session_agent` 或 `agent_message`。
- 如果 UI 当前没有 `session_id`，普通提醒不得因为缺少 session 而 reject；应降级为 `isolated_agent`。
- 如果 assistant 仍然在无 `session_id` 时产出 `session_agent` / `agent_message`，后端会在存在 `project_id` 的情况下兜底改写为 `isolated_agent`。
- 如果缺少必要的 `project_id`，则不能凭空编造，应返回 `reject`。

UI 反馈规则：

- assistant 返回 `create` / `update` 时，UI 显示正常成功 toast，并刷新任务列表。
- assistant 返回 `reject` 时，UI 显示“未创建任务”，description 显示 reject summary。
- reject 不会清空输入框，方便用户修改后重试。

## 7. cron 消息 metadata 与 UI 可见性

agent 模式下，注入消息使用普通用户消息语义，但会附加 metadata：

- `source: "cron"`
- `job_id`
- `run_id`

当前 UI 已实现的部分：

- 如果消息 metadata 里 `source = cron`
- 前端在消息头部显示一个简单 badge：
  - `Cron`
- Settings > Cron 可以查看 job、运行态、最近 run log。
- 最近 run log 中若存在 `session_id` / `created_session_id`，会显示“打开会话”链接。
- “打开会话”会先把目标 project 加入侧边栏项目列表，然后预热并刷新目标 project 的 session 列表，再进入对应 session 路由，避免侧边栏仍停留在旧 project。

当前没有实现：

- run log 页面
- 结构化 job 创建/编辑表单 UI

## 7.1 cron 注入消息的实际表现

在当前实现中：

- `session_agent`
  - 会向既有或回退新建的 session 注入一条普通用户消息
- `isolated_agent`
  - 会创建一个新 session，并用首条普通用户消息启动它

这些消息带有 metadata：

```json
{
  "source": "cron",
  "job_id": "<job_id>",
  "run_id": "<run_id>"
}
```

前端目前会基于 `source = cron` 显示一个 `Cron` badge。

## 8. Scheduler 行为

### 8.1 生命周期

- scheduler 随 server 自动启动
- 不需要单独起进程
- 但全局开关只控制“是否执行”，不停止 scheduler 本身

### 8.2 启动阶段

server 启动后会先做一次**恢复扫描**：

- 刷新 definition
- 初始化缺失 state
- 清理 stale `running = true`

恢复扫描：

- 不执行任务
- 不写 run log

真正第一次调度执行：

- 要等 60s 后的第一个 tick

### 8.3 Tick

当前 tick 周期：

- 60 秒

每次 tick 做的事情：

1. 扫描 job 文件
2. 处理非法 definition
3. 初始化/更新 state
4. 清理孤儿 state
5. 找到 due jobs
6. 调度执行

### 8.4 并发

- 同一个 job
  - 不允许并发执行
  - 若已在运行，则本次 `skipped`
- 不同 job
  - 可以并发执行
  - 当前不设全局并发上限

### 8.5 启动恢复与首次执行

当前 server 启动后分成两个阶段：

1. 恢复阶段
   - 只恢复 definitions 与 state
   - 不执行任务
2. 正常调度阶段
   - 等 60s 后进入第一个真正 tick

这意味着：

- 启动后存在最长约 60s 的执行空窗
- 这是 v1 明确接受的设计边界

## 9. `cron_enabled` 与单 job `enabled`

### 9.1 全局 `cron.enabled`

配置位置：

- `config.cron.enabled`

语义：

- scheduler 仍然运行
- 但任何执行都会被拦住

当前行为：

- 自动 `cron/interval`
  - 不执行
  - 不写 run log
  - 但推进 `next_run_at`
- 自动 `once`
  - 不执行
  - 不写 run log
  - 直接静默过期：
    - `state.enabled = false`
    - `last_status = expired`
- 手动 `run now`
  - 不执行
  - 写一条 `skipped` run

### 9.2 单 job `enabled`

job 是否参与调度，需要同时满足：

- `definition.enabled = true`
- `state.enabled = true`

其中：

- definition 层关闭
  - 更像“用户暂停”
- state 层关闭
  - 更像“系统判定当前不可继续调度”

## 10. `once` 任务语义

`once` 使用 cron 表达式，但只消费第一次命中。

执行后：

- 不论成功还是失败
- 都进入终态，不再自动执行

如果在 `cron.enabled = false` 时第一次命中被错过：

- 不补跑
- 直接静默过期
- `state.enabled = false`
- `last_status = expired`

如果用户之后改了调度定义：

- 该 `once` 可从 `expired` 重新恢复为有效任务

## 11. API 接口（已实现）

当前路由统一挂在：

```text
/cron
```

### 11.1 Jobs

- `GET /cron/jobs`
  - 返回所有 job
  - 每项结构：
    - `definition`
    - `state`

  响应示例：

  ```json
  [
    {
      "definition": { "...": "..." },
      "state": { "...": "..." }
    }
  ]
  ```

- `POST /cron/jobs`
  - 创建 job
  - 返回：
    - `definition`
    - `state`

- `GET /cron/jobs/:id`
  - 查询单个 job
  - 返回：
    - `definition`
    - `state`

- `PATCH /cron/jobs/:id`
  - patch 更新 job
  - 返回：
    - `definition`
    - `state`

- `DELETE /cron/jobs/:id`
  - 删除 job definition
  - 返回：
    - `ok`
    - `job_id`
    - `definition`

### 11.2 Assistant

- `POST /cron/assistant`
  - 从简短自然语言指令创建或修改 cron job。
  - 请求字段：
    - `instruction`
    - 可选 `selected_id`
    - 可选 `project_id`
    - 可选 `session_id`
  - 返回字段：
    - `action: "create" | "update" | "reject"`
    - `summary`
    - `job`
      - create/update 成功时为 job view
      - reject 时为 `null`
  - 该接口遵守 6.6 的上下文绑定规则：普通提醒默认 `isolated_agent`；无 session 时不应拒绝普通提醒；无 project 时不能编造 project。

### 11.3 Runs

- `POST /cron/jobs/:id/run`
  - 手动立即执行
  - 返回单条 run

  响应示例：

  ```json
  {
    "run_id": "01JS8QJCV8J1YQZW4V3T9J6PKA",
    "job_id": "01JS8Q7MKG7WQ1M7B64P73JYQE",
    "started_at": 1776699300000,
    "finished_at": 1776699300000,
    "status": "success",
    "output_summary": "handled direct action",
    "mode": "direct",
    "project_id": null,
    "session_id": null,
    "created_session_id": null,
    "payload_snapshot": {
      "action": "debug_noop"
    },
    "trigger_reason": "manual"
  }
  ```

- `GET /cron/jobs/:id/runs?count=N`
  - 返回最近 N 条 run
  - 默认 `10`
  - 最大 `100`
  - `count <= 0` 返回空数组
  - 非法非整数参数报错

- `GET /cron/runs/:run_id`
  - 查询单条 run

## 12. 内部函数接口（已实现）

当前 `Cron` namespace 暴露的核心函数包括：

- `createJob`
- `updateJob`
- `deleteJob`
- `listJobs`
- `getJob`
- `assist`
- `runJobNow`
- `listRuns`
- `getRun`
- `recover`
- `tick`
- `start`
- `stop`
- `registerDirectAction`
- `unregisterDirectAction`
- `setAgentDispatcher`
- `resetAgentDispatcher`

这意味着：

- HTTP route 只是薄包装
- 其他后端模块也可以直接复用内部函数

## 13. Agent 工具接口（已实现）

当前 cron 已经暴露为主 agent 可以调用的内置工具，注册位置在：

- `packages/opencode/src/tool/cron.ts`
- `packages/opencode/src/tool/registry.ts`

已注册工具包括：

- `cron_list`
  - 列出所有 cron job 与 runtime state
- `cron_get`
  - 查询单个 job，可附带最近 run logs
- `cron_create`
  - 创建全局 cron job
  - `id` 仍由后端自动生成
- `cron_update`
  - patch 更新 job
  - `id` 不允许修改
- `cron_delete`
  - 删除 job definition
  - 历史 run logs 保留
- `cron_run_now`
  - 手动触发 job
  - 如果全局 cron 关闭，会产生 `skipped` run
- `cron_runs`
  - 查询某个 job 的最近 run logs
  - 较新的 run 优先返回
- `cron_set_global_enabled`
  - 开启/关闭全局 cron execution
  - scheduler 本身仍然保持运行

这些工具的意义是：用户现在可以在普通 Aether 会话里要求 agent 创建或管理 cron，而不需要 agent 猜测 JSON 文件路径或直接 curl HTTP API。

涉及写入或触发执行的工具会申请 `cron` 权限：

- `cron_create`
- `cron_update`
- `cron_delete`
- `cron_run_now`
- `cron_set_global_enabled`

只读工具不额外申请权限：

- `cron_list`
- `cron_get`
- `cron_runs`

## 14. 当前测试覆盖

当前已经补上的 cron 专项测试主要覆盖：

- create job / reject manual id
- run now direct success
- same-job running 时 `skipped`
- `cron.enabled = false` 下：
  - `cron/interval` 静默推进
  - `once` 静默过期
- `recover()` 只恢复状态、不偷跑任务
- `expired once` 在调度定义更新后可复活
- `schedule_type` 在 `interval` 与其他类型之间切换
- 非法 job 文件扫描时跳过但不误删 state
- route CRUD / run / runs 查询
- `/cron/assistant` 创建、上下文填充、无 session 降级、非法输出 reject
- ToolRegistry 暴露 cron agent tools
- agent tools 创建、列出、运行、关闭全局 cron
- Settings > Cron 自然语言入口、reject toast、打开新建 session 链接
- `session.created` 自动补全缺失 project 到侧边栏项目列表，并为后台流式事件预热 child store

当前的仿真验证还覆盖了：

- 真实 direct interval job
- 真实 once-disabled 过期行为
- `isolated_agent`
- `session_agent`

这些测试说明 cron v1 不只是 schema/route 通过，而是几条核心执行链也已经跑通。

## 15. 设计边界

当前版本最重要的边界有：

- 分钟级调度，不是秒级
- 启动后第一轮执行要等 60s
- `session_agent` 可能回退到新 session
- `direct` 与 agent mode 并不等价
- 全局 `cron.enabled` 与单 job `enabled` 语义不同
- `once` 使用 cron 表达式，但只消费第一次命中
- definition 非法时，系统优先保守保留旧 state

这些都不是当前实现 bug，而是 v1 的设计取舍。

## 16. 建议验证命令

当前这套 cron 改动建议至少跑：

```bash
bun run --cwd packages/opencode typecheck
```

```bash
bun run --cwd packages/opencode test test/cron/cron.test.ts --timeout 60000
```

```bash
bun run --cwd packages/app ./script/vitest.ts run --config ./vitest.config.ts src/components/settings-cron.vitest.tsx
```

```bash
bun --cwd packages/app test --preload ./happydom.ts src/context/global-sync/event-reducer.test.ts
```

```bash
git diff --check
```
