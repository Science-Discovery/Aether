子代理真正并行 — 修改计划

当前瓶颈

SessionPrompt.loop 中 tasks.pop() 每次只取一个 subtask，串行执行。即使 LLM 在一个 turn 中发起3个 task tool call，它们被序列化为3个 loop iteration，每个阻塞等待子 session 完成。

目标架构

主代理发起3个 task tool call
  → 3个子 session 同时启动（独立线程/进程）
  → 主代理继续工作（不阻塞）
  → Bus event 通知子 session 完成
  → 主代理取回结果
修改计划（5个步骤）

Step 1: Task 参数增加 run_in_background

// task.ts parameters 增加
run_in_background: z.boolean()
  .describe("Run subagent in background. Main agent continues immediately. Results retrieved via background_output.")
  .optional()
Step 2: 后台子 session 执行器

新建 session/background.ts：

namespace BackgroundTask {
  // 启动后台子 session（不阻塞主 loop）
  export async function spawn(input: {
    agent: string
    model: Provider.Model
    prompt: string
    category?: string
    parentSessionID: SessionID
  }): Promise<SessionID>

  // 取回后台结果（阻塞直到完成）
  export async function output(taskID: SessionID): Promise<string>

  // 查询后台状态
  export async function status(taskID: SessionID): Promise<"running" | "completed" | "error">
}
核心实现：

spawn() 创建子 session 后立即返回 session ID，不 await SessionPrompt.prompt()
prompt() 在独立的 Bun worker 或 Effect fiber 中运行
完成时发布 Bus event Session.Event.SubtaskCompleted
output() 阻塞等待结果（用于需要结果时取回）
Step 3: 主 loop 处理后台 task

修改 SessionPrompt.loop 中 subtask 处理逻辑：

当前：

const task = tasks.pop()  // 串行取一个
if (task?.type === "subtask") {
  // await SessionPrompt.prompt() — 阻塞
}
改为：

// 分离前台和后台 task
const foregroundTasks = tasks.filter(t => !t.runInBackground)
const backgroundTasks = tasks.filter(t => t.runInBackground)

// 后台 task：全部 spawn，立即继续
for (const bgTask of backgroundTasks) {
  await BackgroundTask.spawn(bgTask)
  // 不阻塞，主 loop 继续
}

// 前台 task：串行执行（保持现有逻辑）
const task = foregroundTasks.pop()
Step 4: Bus event + 新工具 background_output

// 新工具
const BackgroundOutputTool = Tool.define("background_output", {
  description: "Retrieve results from a background subagent task",
  parameters: z.object({
    task_id: z.string().describe("The background task ID returned by task tool"),
  }),
  async execute(params, ctx) {
    return BackgroundTask.output(SessionID.make(params.task_id))
  },
})
Bus event：

Session.Event.SubtaskCompleted = BusEvent.define(
  "session.subtask.completed",
  z.object({
    sessionID: SessionID.zod,
    taskID: SessionID.zod,
    result: z.string(),
  }),
)
主 loop 中监听：

// 当收到 SubtaskCompleted event，注入结果到主代理的上下文
Bus.subscribe(Session.Event.SubtaskCompleted, (event) => {
  // 创建 synthetic user message 包含子代理结果
  // 主 loop 下一个 iteration 会看到这个消息
})
Step 5: 并发控制

新建 session/concurrency.ts：

namespace Concurrency {
  // 配置
  interface Config {
    defaultConcurrency: number     // 全局上限（默认5）
    providerConcurrency: Record<string, number>  // 按 provider 限流
    modelConcurrency: Record<string, number>     // 按模型限流
  }

  // 运行时检查
  export async function canSpawn(agent: Agent.Info): Promise<boolean>
  // 检查当前活跃的后台 task 数量是否低于配置上限
  // 按 provider 和 model 分别计数
}
在 BackgroundTask.spawn() 中调用 Concurrency.canSpawn()，如果超出上限则排队等待。

修改文件清单

文件	改动
tool/task.ts	增加 run_in_background 参数，前台/后台分支执行
tool/background-output.ts	新建，background_output 工具
session/background.ts	新建，后台子 session 执行器
session/concurrency.ts	新建，并发控制
session/prompt.ts	loop 中分离前台/后台 task，监听 Bus event
session/index.ts	增加 SubtaskCompleted event
config/config.ts	增加 background_task 配置字段
tool/registry.ts	注册 BackgroundOutputTool
tool/task.txt	增加 category 和 run_in_background 说明
风险和依赖

Effect fiber 或 Bun worker：需要选择后台执行机制。Effect Effect.forkScoped 更适合现有架构，Bun worker 更独立但需要进程间通信。
Bus event 时序：主 loop iteration 和 Bus event 的时序需要精确控制——不能在主代理正在生成 assistant message 时注入 synthetic message。
权限兼容：后台 task 的 permission 仍由 agent config 决定，但 background_output 工具需要在主代理权限中 allow。
Abort 处理：主 session abort 时需要取消所有后台子 session。


我发现实现中有如下比较危险的内容：
1. Step 2: 后台子 session 执行器与现在的subagent方案之间是否存在冲突？如何把前台和后台 task 在实际使用时正确分离，或者说，什么时候使用前台task，什么时候使用后台task该如何决定？
2. 如何正确的处理出现错误的后台 task？可能需要一套严格的兜底方案处理各种错误。

除此之外，我认为需要对subagent的权限有明确且灵活的控制方法，按照主agent的要求，subagent可以只限定于做单一任务，也可以做更独立的探索性任务，甚至可以像主agent一样再派生更多的subagent。你觉得为了实现这种权限的灵活性，我们还需要注意哪些内容？


这三个问题都非常关键，让我逐一深入分析。

---

## 1. 前台/后台 Task 的冲突与决策

### 冲突分析

当前 subtask 执行与后台方案的核心冲突在于**消息流所有权**：

```
当前架构：
  主 loop iteration → SubtaskPart 存储在 user message 的 parts 中
  → tasks.pop() 取出 → 同步执行 → 结果写入 assistant message 的 tool part
  → 主 loop 继续下一个 iteration

  整个过程中，主 loop 是消息流的唯一写入者。

后台方案：
  主 loop spawn 后台子 session → 立即继续
  → 后台子 session 在独立线程中运行
  → 完成时通过 Bus event 通知
  → 需要向主 session 注入 synthetic message

  问题：两个写入者同时向主 session 写消息 → 时序冲突
```

**具体冲突场景**：

| 场景 | 冲突点 |
|------|--------|
| 主代理正在生成 assistant message 时，后台 task 完成 | Bus event 试图插入 synthetic user message，但主代理的 generation 还没结束 → 消息序号冲突 |
| 前台 task 阻塞等待时，后台 task 完成 | 主 loop 被 `await SessionPrompt.prompt()` 阻塞，Bus event 无法被处理 → 后台结果丢失 |
| 3个后台 task 同时完成 | 3个 Bus event 同时触发 → 需要排序合并，不能随意插入 |
| 后台 task 完成后主代理取回结果 | `background_output` 工具在主 loop 的哪个 iteration 中执行？需要新的 tool call cycle |

### 决策框架：何时前台、何时后台

核心原则是**依赖关系**：

```
主代理是否需要子代理的结果才能决定下一步？
  → YES → 前台 task（阻塞等待）
  → NO  → 后台 task（立即继续）

具体场景：

| 场景 | 模式 | 理由 |
|------|------|------|
| "搜索认证实现，然后我决定怎么改" | 前台 | 主代理依赖结果做决策 |
| "同时搜索3个方向，我等结果再分析" | 后台 | 可以并行，但最终需要汇总 |
| "搜索代码库同时我继续写代码" | 后台 | 完全独立，不需要等 |
| "搜索然后立即执行修复" | 前台 | 紧密依赖链 |
```

**关键设计决策**：不应该让 LLM 自由选择前台/后台——LLM 会倾向于全部用前台（更简单、结果更可控）。应该由 **系统根据 task prompt 的依赖声明自动决策**，或者由主代理的 system prompt 指导选择。

对于 research agent 来说，Phase 1 的3个并行搜索应**全部后台**——因为 research 代理需要等3个结果都返回后才做综合分析，而不是逐个等待。Phase 2 的深度分析可以**前台**——因为只有一个子代理，且结果直接用于写报告。

### 解决冲突的架构方案

不通过 Bus event 注入消息（时序不可控），而是通过**结果缓冲池**：

```
后台 task 完成后：
  → 结果存入 BackgroundTask.resultStore（内存 + DB）
  → 不注入 synthetic message
  → 状态通过 SessionStatus 广播（UI 可以显示"3/3 tasks completed"）

主代理取回结果时：
  → 主代理主动调用 background_output 工具
  → 工具从 resultStore 取回结果
  → 作为 tool call result 返回给主代理
  → 主代理在自己的 assistant turn 中处理结果

这避免了两个写入者同时向主 session 写消息的问题。
```

---

## 2. 后台 Task 错误兜底方案

### 错误分类与处理

| 错误类型 | 严重度 | 处理策略 |
|---------|--------|---------|
| **API 临时错误** (429, 503, 529) | 中 | 自动 retry + fallback_models 降级 |
| **模型不存在** | 高 | 直接失败，结果标记为 error |
| **权限拒绝** | 中 | 子代理被 Permission.ask 拒绝 → 记录拒绝信息，继续尝试下一个工具 |
| **上下文溢出** | 高 | 触发 compaction 或截断，如果能恢复则继续，否则标记 partial_result |
| **超时** | 中 | 可配置 max_execution_time（默认300秒），超时后保存已完成部分 |
| **主 session abort** | 高 | 所有后台 task 立即 cancel，不保存结果 |
| **子代理空转/停滞** | 中 | Todo Enforcer 检测 → 强制继续或超时终止 |
| **子代理产出无结果** | 低 | 返回空 text → 主代理应处理空结果 |

### 兜底方案设计

```ts
// background.ts 核心兜底逻辑

interface BackgroundResult {
  status: "completed" | "error" | "partial" | "timeout" | "cancelled"
  text: string                          // 完整或部分结果文本
  error?: {                             // 错误详情
    type: "api_error" | "permission" | "overflow" | "timeout" | "unknown"
    message: string
    statusCode?: number
    retryable: boolean                   // 是否值得重试
  }
  partialToolsUsed: string[]             // 子代理使用了哪些工具
  executionTime: number                  // 实际运行时间（秒）
  stepsCompleted: number                 // 完成了多少步
  stepsTotal: number                     // 总步数（如果已知）
}

async function spawn(input): Promise<SessionID> {
  const session = await Session.create(...)
  const timeout = input.maxExecutionTime ?? 300
  
  // 在 Effect fiber 中运行，带超时和错误捕获
  Effect.forkScoped(
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () => SessionPrompt.prompt({...}),
        catch: (e) => classifyError(e),
      }).pipe(
        Effect.timeout(Duration.seconds(timeout)),
        Effect.catchTag("api_error", handleApiError),
        Effect.catchTag("overflow", handleOverflow),
      )
      
      // 无论如何，保存结果到 resultStore
      yield* saveResult(session.id, {
        status: result.isSuccess ? "completed" : classifyStatus(result.error),
        text: extractText(result),
        error: result.error,
        ...
      })
      
      // 广播状态（非消息注入）
      yield* SessionStatus.set(input.parentSessionID, {
        type: "background_task_completed",
        taskId: session.id,
        status: result.status,
      })
    })
  )
  
  return session.id  // 立即返回
}
```

**关键兜底原则**：

1. **永远保存结果** — 即使子代理失败，也保存 `partial_result` 和 `error` 详情。主代理不应面对"结果凭空消失"的情况。
2. **永远不注入消息** — 后台结果只存 resultStore，主代理主动取回。避免时序冲突。
3. **超时后保存已完成部分** — 如果子代理超时但已完成了5步中的3步，保存这3步的产出而非丢弃。
4. **error.retryable 标记** — 如果错误是 retryable（429/503），主代理可以决定是否重试。
5. **主代理必须处理所有状态** — 主代理的 system prompt 应包含："如果 background_output 返回 error 或 partial，你应该：评估 partial 是否足够 → 决定是否重试 → 或调整后续计划"。

---

## 3. 子代理权限灵活控制

你提到的三级自主度：

| 自主度 | 子代理能做什么 | 场景 |
|--------|---------------|------|
| **Restricted** | 单一任务、只读、不能委派 | Explore 搜索特定模式 |
| **Moderate** | 多步任务、受限写、不能委派 | General 实现特定功能 |
| **Autonomous** | 完全探索、可写、可再委派 | Hephaestus 式自主深度工作 |

### 需要注意的核心问题

**问题1: 委派深度限制（防止无限委派链）**

```
主代理 → 委派子代理 → 子代理再委派 → 子子代理再委派 → ...
                                       ↑ 无限嵌套
```

当前 `task.ts:118-119` 禁止无 `task` 权限的子代理委派。但如果允许 `task: allow`，就需要**委派深度计数器**：

```ts
// 在 Session.create 或 task call 中传递 delegation_depth
task({
  subagent_type: "general",
  delegation_depth: 1,  // 此子代理最多再委派1层
})

// 子代理委派时：
task({
  subagent_type: "explore",
  delegation_depth: parent_depth - 1,  // 递减
})
// 如果 delegation_depth === 0 → task 工具权限自动 deny
```

**问题2: 权限降级原则（子代理不能超越主代理）**

```ts
// 权限降级规则：子代理的权限是主代理权限与自身配置权限的交集
const effectivePermission = Permission.intersection(
  callerPermission,     // 主代理的权限
  agentConfigPermission, // 子代理的静态配置权限
  taskOverridePermission, // task call 中动态指定的权限覆盖
)

// 交集规则：
// - 如果主代理禁止 X，子代理绝对不能允许 X
// - 如果主代理允许 X，子代理可以禁止 X（更严格）
// - 子代理永远不能获得主代理没有的权限
```

当前 Aether 的权限系统是 **合并**（`Permission.merge`）而非交集。这意味着子代理可以通过自身配置获得主代理没有的权限——这是一个安全漏洞。需要改为交集逻辑。

**问题3: Task 级别的动态权限覆盖**

当前子代理权限是静态的——由 agent config 决定。但主代理可能需要**按任务动态调整**：

```ts
task({
  subagent_type: "general",
  permission_override: {
    edit: "allow",    // 此任务允许编辑（覆盖 general 的默认 deny）
    bash: "deny",     // 此任务禁止 bash
    task: "deny",     // 此任务禁止再委派
  },
  max_steps: 10,      // 最多10步
  file_scope: ["src/auth/**"],  // 只能访问这些文件
})
```

这需要：
1. `permission_override` 参数合并到子 session 的 permission ruleset
2. `max_steps` 限制子代理的 loop iteration 数
3. `file_scope` 是一个全新的概念——限制 read/edit/write/glob 的路径范围

**问题4: file_scope 的实现**

`file_scope` 限制子代理只能访问特定路径。这是 OMO 没有但 Aether 可以创新的地方：

```ts
// 在 Permission.evaluate 中增加路径范围检查
function evaluateWithScope(
  permission: string,
  pattern: string,
  ruleset: Permission.Ruleset,
  scope?: string[],  // 允许的路径 glob
): { action: Permission.Action, scopeMatch: boolean } {
  
  const base = evaluate(permission, pattern, ruleset)
  if (base.action === "deny") return { action: "deny", scopeMatch: false }
  
  // 对于 file-affecting tools (edit, write, glob, grep)，检查路径范围
  if (scope && isFileTool(permission)) {
    const matchesScope = scope.some(s => minimatch(pattern, s))
    if (!matchesScope) return { action: "deny", scopeMatch: false }
  }
  
  return { action: base.action, scopeMatch: true }
}
```

**问题5: 子代理行为约束（不是权限，而是纪律）**

除了工具权限，还需要约束子代理的**行为模式**：

| 约束 | 实现 | 作用 |
|------|------|------|
| **single_task** | max_steps: 1 + task: deny | 子代理只能做一件事 |
| **focused_exploration** | max_steps: 5 + edit: deny + bash: deny | 只搜索不修改 |
| **autonomous_work** | max_steps: 20 + task: allow | 完全自主，可委派 |
| **return_format** | task prompt 中明确指定输出格式 | 确保结果可解析 |

**问题6: 子代理与主代理的 Prompt 上下文隔离**

当子代理权限不同时，它的 system prompt 应**只包含与其权限匹配的工具描述**。当前 Aether 的工具描述是全局的——所有工具都出现在 system prompt 中，子代理看到 `edit` 工具描述但被权限禁止。

更好的做法是：**不向子代理展示它无权使用的工具**。这减少了子代理"看到工具但被拒绝"的挫败感，也减少了 context window 浪费。

```ts
// resolveTools 中根据权限过滤工具描述
const tools = allTools.filter(tool => {
  const perm = Permission.evaluate(tool.id, "*", agent.permission)
  return perm.action !== "deny"
})
```

### 总结：权限灵活性需要的完整改动清单

| 改动 | 文件 | 优先级 |
|------|------|--------|
| **委派深度计数器** | `task.ts`, `session/schema.ts` | 高 |
| **权限交集逻辑** | `permission.ts` | 高 |
| **Task 级别 permission_override** | `task.ts` schema | 高 |
| **max_steps 参数** | `task.ts`, `SessionPrompt.loop` | 中 |
| **file_scope 路径范围** | `permission.ts`, `task.ts` | 中 |
| **工具描述按权限过滤** | `prompt.ts resolveTools` | 低 |

前3项是核心安全改动（委派深度 + 权限降级 + 动态覆盖），必须先实施。后3项是增强能力，可以迭代加入。

你想先从哪一项开始？还是先把所有改动整合到一个完整的设计文档中？