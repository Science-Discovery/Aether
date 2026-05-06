# 子代理并行执行与行为纪律控制 — 统一设计方案

> 本文档是对 `parallel-agents-design.md` 的全面重构，将"并行执行能力"与"行为纪律控制"统一在一个框架中，消除此前方案中的架构冲突与安全漏洞。

---

## 一、现状分析与核心问题

### 1.1 串行瓶颈

当前 `SessionPrompt.loop` 通过 `tasks.pop()` 逐个取出 subtask，串行执行。LLM 在一个 turn 中发起 3 个 task tool call 时，被序列化为 3 个 loop iteration，每个阻塞等待子 session 完成。

**代码位置**: `session/prompt.ts:384-571` — 每次只处理一个 subtask，await 完成后才 continue 回 loop 顶部取下一个。

### 1.2 权限安全漏洞

当前 `Permission.merge()` 实现为 `rulesets.flat()` — 简单的数组拼接，后出现的规则覆盖前面的（`findLast` 语义）。这意味着子代理可以通过自身配置获得主代理没有的权限——子代理的 allow 规则会覆盖主代理的 deny 规则。

**代码位置**: `permission/index.ts:292-294`

### 1.3 静态权限、无动态约束

子代理权限完全由 `Agent.Info.permission` 静态配置决定。主代理无法按任务动态调整子代理的：

- 工具权限（如：本次允许 edit）
- 行为边界（如：最多 10 步、只能访问 `src/auth/**`）
- 委派能力（如：允许再委派 1 层）

### 1.4 工具描述浪费

当前 `resolveTools()` 向子代理展示所有工具描述，包括它无权使用的工具。这浪费了 context window，并让子代理"看到工具却被拒绝"。

---

## 二、统一设计框架：Agent Discipline

本方案引入 **Discipline**（纪律）概念，作为子代理行为的统一控制层。一个 Discipline 对象涵盖了并行模式、权限约束、行为边界、委派深度等所有维度。

### 2.1 Discipline Schema

```ts
export const Discipline = z.object({
  // ─── 并行模式 ───
  mode: z
    .enum(["serial", "concurrent", "background"])
    .describe(
      "serial: await result before proceeding (current behavior). " +
        "concurrent: start with other concurrent tasks, await all results together. " +
        "background: spawn immediately, main agent continues without waiting.",
    )
    .default("serial"),

  // ─── 权限约束 ───
  permission_override: z
    .record(Permission.Action, z.string().array().optional())
    .describe(
      "Dynamic permission overrides for this task. Keys are permission names (edit, bash, task, etc.), " +
        "values are action + optional pattern pairs. Merged into sub-agent's effective ruleset " +
        "but capped by parent's permissions via intersection.",
    )
    .optional(),
  // 示例: { edit: ["allow"], bash: ["deny"], task: ["deny"], glob: ["allow", "src/auth/**"] }

  // ─── 委派深度 ───
  delegation_depth: z
    .number()
    .int()
    .min(0)
    .max(3)
    .describe(
      "How many more delegation levels this sub-agent is allowed. " +
        "0 = cannot delegate at all (task tool denied). " +
        "1 = can delegate one more layer, but its children cannot. " +
        "Default: 0 for all subagents unless explicitly set.",
    )
    .default(0),

  // ─── 行为边界 ───
  max_steps: z
    .number()
    .int()
    .min(1)
    .max(50)
    .describe("Maximum loop iterations for this sub-agent session. Enforced by the loop counter.")
    .optional(),
  // Agent.Info.steps 作为默认值，此字段覆盖

  timeout_seconds: z
    .number()
    .int()
    .min(30)
    .max(600)
    .describe("Maximum execution time in seconds. On timeout, partial results are saved.")
    .default(300),

  file_scope: z
    .string()
    .array()
    .describe(
      "Glob patterns restricting file-affecting tools (read, edit, write, glob, grep, apply_patch). " +
        "If specified, the sub-agent can only operate on files matching these patterns. " +
        "Example: ['src/auth/**', 'package.json']",
    )
    .optional(),

  // ─── 输出纪律 ───
  return_format: z
    .enum(["text", "structured", "raw"])
    .describe(
      "text: final assistant text (default, current behavior). " +
        "structured: enforce JSON/Markdown output format via prompt instruction. " +
        "raw: return full conversation trace including tool call results.",
    )
    .default("text"),
})
export type Discipline = z.infer<typeof Discipline>
```

### 2.2 Discipline 的三大维度

| 维度         | 控制什么                           | 核心参数                                                |
| ------------ | ---------------------------------- | ------------------------------------------------------- |
| **并行模式** | 子代理与主代理的时序关系           | `mode`                                                  |
| **权限约束** | 子代理能使用什么工具、访问什么资源 | `permission_override`, `delegation_depth`, `file_scope` |
| **行为边界** | 子代理能走多远、跑多久、输出什么   | `max_steps`, `timeout_seconds`, `return_format`         |

---

## 三、Part I — 真正并行执行

### 3.1 三种执行模式

#### Serial（当前行为，默认）

主代理发起一个 task → 阻塞等待结果 → 继续。适用于主代理**依赖结果做下一步决策**的场景。

#### Concurrent（并行等待）

主代理在同一 turn 中发起 N 个 task → N 个子 session 同时启动 → 主代理**等待所有结果返回**后汇总处理。适用于"并行搜索、汇总分析"场景。

**关键区别**：Concurrent 不需要新的工具或消息注入机制——主代理仍然在同一个 loop iteration 中等待所有结果，只是启动方式从串行变为并行。

#### Background（后台执行）

主代理发起一个 task → 立即继续工作 → 后台子 session 在独立 fiber 中运行 → 完成后结果存入缓冲池 → 主代理通过 `background_output` 工具主动取回。

适用于"子代理搜索代码库，主代理继续写代码"等场景。

### 3.2 Loop 改造：从串行到并行

当前 loop 的 subtask 处理逻辑（`prompt.ts:384-571`）：

```
while (true) {
  ...
  const task = tasks.pop()   // 逐个取出
  if (task?.type === "subtask") {
    // await 执行 → continue
  }
}
```

改造为：

```ts
while (true) {
  ...
  // 1. 分离三种模式的 task
  const serialTasks    = tasks.filter(t => t.discipline?.mode !== "concurrent" && t.discipline?.mode !== "background")
  const concurrentTasks = tasks.filter(t => t.discipline?.mode === "concurrent")
  const backgroundTasks = tasks.filter(t => t.discipline?.mode === "background")

  // 2. 后台 task：全部 spawn，立即继续
  for (const bg of backgroundTasks) {
    BackgroundTask.spawn(bg, sessionID, abort)  // 不阻塞
  }

  // 3. 并行 task + 前台 task：一起执行
  const parallelBatch = [...serialTasks, ...concurrentTasks]
  if (parallelBatch.length > 0) {
    // 串行 task 和并行 task 一起并行执行
    // 如果只有一个串行 task 且无并行 task，退化为当前逻辑
    const results = await Promise.all(
      parallelBatch.map(task => executeSubtask(task, sessionID, abort, msgs))
    )
    // 所有结果作为 tool call results 返回给主代理
    continue
  }

  // 4. 无 task → 正常处理
  ...
}
```

**关键设计**：`executeSubtask()` 是从当前 loop 中提取出来的独立函数，包含创建 assistant message、tool part、调用 `taskTool.execute()` 的完整逻辑。它不再直接修改 loop 状态，而是返回结果供 loop 统一处理。

### 3.3 SubtaskPart Schema 扩展

```ts
export const SubtaskPart = PartBase.extend({
  type: z.literal("subtask"),
  prompt: z.string(),
  description: z.string(),
  agent: z.string(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  command: z.string().optional(),
  // ─── 新增 ───
  discipline: Discipline.optional(),
})
```

### 3.4 后台执行：Result Buffer Pool

后台子 session 完成后，**不注入 synthetic message**（避免两个写入者的时序冲突），而是存入结果缓冲池：

```ts
// session/background.ts
namespace BackgroundTask {
  // 结果存储（内存 + DB 持久化）
  interface Result {
    taskID: SessionID
    status: "completed" | "error" | "partial" | "timeout" | "cancelled"
    text: string
    error?: {
      type: "api_error" | "permission" | "overflow" | "timeout" | "unknown"
      message: string
      statusCode?: number
      retryable: boolean
    }
    toolsUsed: string[]
    executionTime: number
    stepsCompleted: number
    delegationDepthRemaining: number // 委派深度剩余
  }

  // spawn: 创建子 session，在 Effect fiber 中执行，立即返回
  export async function spawn(input: {
    subtask: SubtaskPart
    parentSessionID: SessionID
    parentAbort: AbortSignal
    parentPermission: Permission.Ruleset // 用于权限交集
    parentDelegationDepth: number // 用于委派深度递减
  }): Promise<SessionID> {
    const session = await Session.create({
      parentID: input.parentSessionID,
      title: input.subtask.description + ` (@${input.subtask.agent} subagent)`,
      permission: computeEffectivePermission(input), // 见第四节
    })

    const timeoutMs = (input.subtask.discipline?.timeout_seconds ?? 300) * 1000

    // 在 Effect fiber 中运行
    Effect.runFork(
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () =>
            SessionPrompt.prompt({
              sessionID: session.id,
              model: resolveModel(input.subtask, session),
              agent: input.subtask.agent,
              parts: resolvePromptParts(input.subtask),
              tools: computeToolOverrides(input),
              maxSteps: input.subtask.discipline?.max_steps,
            }),
          catch: (e) => classifyError(e),
        }).pipe(Effect.timeout(Duration.millis(timeoutMs)), Effect.catchAll(handleError))

        // 无论如何保存结果到缓冲池
        yield* saveResult(session.id, {
          taskID: session.id,
          status: classifyStatus(result),
          text: extractText(result),
          error: result.error,
          toolsUsed: extractToolsUsed(result),
          executionTime: computeTime(result),
          stepsCompleted: result.stepsCompleted ?? 0,
          delegationDepthRemaining: session.delegationDepth - 1,
        })

        // 广播完成状态（UI 可显示 "2/3 tasks completed"）
        yield* Bus.publish(Session.Event.SubtaskCompleted, {
          sessionID: input.parentSessionID,
          taskID: session.id,
          status: result.status,
        })
      }),
    )

    // Abort 传播：父 session 取消时，取消所有后台子 session
    input.parentAbort.addEventListener("abort", () => {
      SessionPrompt.cancel(session.id)
      markResultCancelled(session.id)
    })

    return session.id // 立即返回
  }

  // output: 从缓冲池取回结果（阻塞等待完成）
  export async function output(taskID: SessionID): Promise<Result> {
    // 如果 task 仍在运行，await 完成
    // 如果已完成/出错，直接返回缓冲池中的结果
  }

  // status: 查询后台 task 当前状态
  export async function status(
    taskID: SessionID,
  ): Promise<"running" | "completed" | "error" | "partial" | "timeout" | "cancelled"> {}
}
```

### 3.5 background_output 工具

```ts
const BackgroundOutputTool = Tool.define("background_output", async (ctx) => ({
  description:
    "Retrieve results from a background subagent task. Use this when a background task has completed and you need its output.",
  parameters: z.object({
    task_id: z.string().describe("The background task ID returned by the task tool when mode=background"),
  }),
  async execute(params, ctx) {
    const result = await BackgroundTask.output(SessionID.make(params.task_id))

    if (result.status === "completed") {
      return formatSuccess(result)
    }

    // 非 completed 状态也要返回完整信息，让主代理自行决策
    return formatPartialOrError(result)
  },
}))
```

### 3.6 并发控制

```ts
// session/concurrency.ts
namespace Concurrency {
  interface Config {
    maxConcurrent: number // 全局上限（默认 5）
    providerLimits: Record<string, number> // 按 provider 限流
    modelLimits: Record<string, number> // 按模型限流
  }

  // 当前活跃的后台 task 计数
  const active = new Map<SessionID, { model: string; provider: string; startedAt: number }>()

  export function canSpawn(model: Provider.Model, cfg: Config): boolean {
    const globalCount = active.size
    if (globalCount >= cfg.maxConcurrent) return false

    const providerCount = [...active.values()].filter((a) => a.provider === model.providerID).length
    if (providerCount >= (cfg.providerLimits[model.providerID] ?? cfg.maxConcurrent)) return false

    const modelCount = [...active.values()].filter((a) => a.model === model.id).length
    if (modelCount >= (cfg.modelLimits[model.id] ?? cfg.maxConcurrent)) return false

    return true
  }

  // 超出上限时排队等待（而非拒绝）
  export async function awaitSlot(model: Provider.Model, cfg: Config): Promise<void> {
    while (!canSpawn(model, cfg)) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}
```

在 `BackgroundTask.spawn()` 中调用 `Concurrency.awaitSlot()` 排队等待。

---

## 四、Part II — 行为纪律灵活控制

### 4.1 权限交集逻辑（核心安全修复）

当前 `Permission.merge()` 是 `flat()` — 子代理可以通过自身 allow 规则覆盖主代理的 deny 规则。必须改为**交集逻辑**。

#### 交集规则

```
子代理的有效权限 = 主代理权限 ∩ 子代理配置权限 ∩ 任务级覆盖权限

规则：
  主代理 deny X → 子代理绝对不能 allow X（无论子代理配置或覆盖怎么说）
  主代理 allow X → 子代理可以 deny X（更严格）
  子代理永远不能获得主代理没有的权限
```

#### 实现

```ts
// permission/index.ts 新增
export function intersection(parent: Ruleset, child: Ruleset, override?: Ruleset): Ruleset {
  // 1. 合并 child + override（override 覆盖 child）
  const childEffective = merge(child, override ?? [])

  // 2. 对每条 childEffective 规则，检查 parent 是否允许
  const result: Ruleset = []
  for (const rule of childEffective) {
    const parentRule = evaluate(rule.permission, rule.pattern, parent)

    if (parentRule.action === "deny") {
      // parent deny → 子代理也必须 deny
      result.push({ permission: rule.permission, pattern: rule.pattern, action: "deny" })
    } else if (rule.action === "deny" && parentRule.action === "allow") {
      // 子代理 stricter deny → 允许（子代理可以比主代理更严格）
      result.push(rule)
    } else if (rule.action === "allow" && parentRule.action === "allow") {
      // 双方都 allow → 允许
      result.push(rule)
    } else if (rule.action === "ask" && parentRule.action === "allow") {
      // 子代理 ask → 允许（ask 是比 allow 更严格的控制）
      result.push(rule)
    } else {
      // 其他情况：跟随 parent
      result.push({ permission: rule.permission, pattern: rule.pattern, action: parentRule.action })
    }
  }

  // 3. 补上 parent 中存在但 child 中没有的规则（继承 parent 的 deny）
  for (const parentRule of parent) {
    const alreadyCovered = result.some(
      (r) => Wildcard.match(r.permission, parentRule.permission) && Wildcard.match(r.pattern, parentRule.pattern),
    )
    if (!alreadyCovered && parentRule.action === "deny") {
      result.push(parentRule)
    }
  }

  return result
}
```

#### 应用点

```ts
// task.ts 中 Session.create 的 permission 计算
const effectivePermission = Permission.intersection(
  ctx.agent.permission, // 主代理权限（上限）
  agent.permission, // 子代理配置权限
  discipline.permission_override ? Permission.fromOverride(discipline.permission_override) : undefined,
)
```

```ts
// loop 中 subtask 的 Permission.ask
async ask(req) {
  await Permission.ask({
    ...req,
    sessionID: sessionID,
    ruleset: Permission.intersection(
      callerPermission,         // 主代理权限
      taskAgent.permission,     // 子代理配置权限
    ),
  })
}
```

### 4.2 委派深度控制

#### 原理

```
主代理 (depth=∞) → 委派子代理 A (depth=2)
  → A 委派子代理 B (depth=1)
    → B 委派子代理 C (depth=0) → C 无法再委派（task tool 自动 deny）
```

#### 实现

```ts
// session/schema.ts 新增字段
export const Info = z.object({
  ...existingFields,
  delegationDepth: z.number().int().min(0).optional(),
  // undefined = 无限制（主代理）；0 = 不能委派；N = 最多再委派 N 层
})

// task.ts 中设置委派深度
const depth = discipline.delegation_depth ?? 0
const session = await Session.create({
  parentID: ctx.sessionID,
  title: ...,
  permission: [
    ...effectivePermission,
    // depth=0 时自动 deny task
    ...(depth === 0 ? [{ permission: "task", pattern: "*", action: "deny" }] : []),
  ],
  delegationDepth: depth,
})

// 子代理委派时，深度递减
// 在 TaskTool.init() 中，动态注入规则：
// 当前 session 的 delegationDepth - 1 作为子 session 的 delegationDepth
```

**委派深度在后台 task 中的传递**：

后台子 session 的 `delegationDepth` 来自主代理传入的 `discipline.delegation_depth`。子代理若再委派，其 TaskTool 的 `init()` 会读取当前 session 的 `delegationDepth`，减 1 后传给下一层。

### 4.3 max_steps 行为边界

#### 实现

```ts
// SessionPrompt.loop 中增加 step limit 检查
while (true) {
  step++
  // 读取 session 的 maxSteps 配置
  const maxSteps = session.maxSteps ?? (await Agent.get(session.agent)).steps ?? Infinity
  if (step > maxSteps) {
    // 达到步数上限，生成一条最终总结消息后退出
    const summary = "Maximum steps reached. Summarizing current progress..."
    // 创建最终的 assistant message 包含 summary
    break
  }
  ...
}
```

```ts
// task.ts 中设置 maxSteps
const maxSteps = discipline.max_steps ?? agent.steps
const session = await Session.create({
  ...existingFields,
  maxSteps,
})
```

### 4.4 file_scope 路径范围

#### 原理

当 `discipline.file_scope` 指定时，子代理的文件操作工具（read, edit, write, glob, grep, apply_patch, multiedit）只能访问匹配 `file_scope` glob 的路径。

#### 实现

```ts
// permission/index.ts 新增
export function evaluateWithScope(
  permission: string,
  path: string,
  ruleset: Ruleset,
  scope?: string[],
): Rule & { scopeMatch: boolean } {
  const base = evaluate(permission, path, ruleset)
  if (base.action === "deny") return { ...base, scopeMatch: false }

  const FILE_TOOLS = ["read", "edit", "write", "glob", "grep", "apply_patch", "multiedit"]

  if (scope && FILE_TOOLS.includes(permission)) {
    const normalized = path.startsWith("/") ? path : path // 保持原路径
    const matches = scope.some((s) => minimatch(normalized, s))
    if (!matches) {
      return { permission, pattern: path, action: "deny", scopeMatch: false }
    }
  }

  return { ...base, scopeMatch: true }
}
```

```ts
// Tool.Context 扩展
export type Context = {
  ...existingFields,
  fileScope?: string[]  // 当前 session 的 file_scope 约束
}

// 在 Permission.ask 中使用 evaluateWithScope
// 在 tool execute 中，对文件路径参数先做 scope 检查
```

**session 级别存储**：

```ts
// session/schema.ts Info 新增
export const Info = z.object({
  ...existingFields,
  fileScope: z.string().array().optional(),
})
```

### 4.5 工具描述按权限过滤

当前 `resolveTools()` 向所有代理展示全部工具描述。当子代理被 deny 了某些工具时，它仍然看到这些工具的描述，浪费 context window 并导致"看到但被拒绝"的挫败感。

#### 实现

```ts
// 在 prompt.ts resolveTools 中增加过滤
const tools = allTools.filter((tool) => {
  const permKey = EDIT_TOOLS.includes(tool.id) ? "edit" : tool.id
  const rule = Permission.evaluate(permKey, "*", effectivePermission)
  return rule.action !== "deny"
})

// 对 file_scope，进一步过滤：如果 file_scope 存在且工具是文件类工具，
// 仍然保留工具描述，但在描述中注明 "only within [scope patterns]"
```

### 4.6 return_format 输出纪律

| format       | prompt 指令                                        | 结果提取方式                                                      |
| ------------ | -------------------------------------------------- | ----------------------------------------------------------------- |
| `text`       | 无额外指令                                         | `result.parts.findLast(x => x.type === "text")?.text`（当前行为） |
| `structured` | "Your output must be in the following format: ..." | 同上，但主代理 prompt 中约定格式                                  |
| `raw`        | 无额外指令                                         | 返回完整的 assistant + tool trace                                 |

`return_format` 不需要复杂的代码改动——它主要是通过 prompt 指令控制子代理的行为。对于 `structured`，在 `TaskTool.execute` 的 promptParts 中追加格式指令；对于 `raw`，结果提取逻辑改为返回完整的 trace。

---

## 五、统一 API：Task Tool 参数改造

### 5.1 新参数 Schema

```ts
const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  category: z.string().describe("Optional semantic category for model routing.").optional(),
  task_id: z.string().describe("Resume a previous task by passing its task_id.").optional(),
  command: z.string().describe("The command that triggered this task").optional(),

  // ─── 新增：Discipline 参数 ───
  mode: z
    .enum(["serial", "concurrent", "background"])
    .describe(
      "Execution mode. " +
        "serial: block until result (default). " +
        "concurrent: run alongside other concurrent tasks in same turn, await all together. " +
        "background: spawn and continue immediately, retrieve result later via background_output.",
    )
    .default("serial")
    .optional(),

  delegation_depth: z
    .number()
    .int()
    .min(0)
    .max(3)
    .describe("How many more delegation layers this sub-agent may spawn. 0 = no delegation (default).")
    .default(0)
    .optional(),

  permission_override: z
    .record(z.enum(["allow", "deny"]), z.string().array())
    .describe(
      "Dynamic permission overrides. " +
        "Keys are permission names, values are action + optional pattern. " +
        "Example: { edit: ['allow'], bash: ['deny'], task: ['deny'] }. " +
        "Overrides are capped by parent permissions — sub-agent cannot gain permissions the parent lacks.",
    )
    .optional(),

  max_steps: z
    .number()
    .int()
    .min(1)
    .max(50)
    .describe("Maximum loop iterations for this sub-agent. Overrides agent's default steps.")
    .optional(),

  timeout_seconds: z
    .number()
    .int()
    .min(30)
    .max(600)
    .describe("Maximum execution time in seconds.")
    .default(300)
    .optional(),

  file_scope: z
    .string()
    .array()
    .describe("Glob patterns restricting file operations. Example: ['src/auth/**', 'test/**']")
    .optional(),

  return_format: z
    .enum(["text", "structured", "raw"])
    .describe("Output format discipline. text=default, structured=JSON/Markdown, raw=full trace.")
    .default("text")
    .optional(),
})
```

### 5.2 Task Tool execute 改造

```ts
async execute(params, ctx) {
  const discipline = {
    mode:            params.mode ?? "serial",
    delegation_depth: params.delegation_depth ?? 0,
    permission_override: params.permission_override,
    max_steps:       params.max_steps,
    timeout_seconds: params.timeout_seconds ?? 300,
    file_scope:      params.file_scope,
    return_format:   params.return_format ?? "text",
  }

  const agent = await Agent.get(params.subagent_type)

  // ─── 计算有效权限（交集逻辑）───
  const overrideRuleset = discipline.permission_override
    ? Permission.fromOverride(discipline.permission_override)
    : []
  const effectivePermission = Permission.intersection(
    ctx.agent.permission,       // 主代理权限（上限）
    agent.permission,            // 子代理配置权限
    overrideRuleset,             // 任务级覆盖
  )

  // ─── 委派深度 ───
  const depth = discipline.delegation_depth
  if (depth === 0) {
    effectivePermission.push({ permission: "task", pattern: "*", action: "deny" })
  }

  // ─── 创建子 session ───
  const session = await Session.create({
    parentID: ctx.sessionID,
    title: params.description + ` (@${agent.name} subagent)`,
    permission: effectivePermission,
    delegationDepth: depth,
    maxSteps: discipline.max_steps ?? agent.steps,
    fileScope: discipline.file_scope,
  })

  // ─── 按模式分支 ───
  if (discipline.mode === "background") {
    const taskID = await BackgroundTask.spawn({
      subtask: { ...params, discipline },
      parentSessionID: ctx.sessionID,
      parentAbort: ctx.abort,
      parentPermission: ctx.agent.permission,
      parentDelegationDepth: depth,
    })
    return {
      title: params.description,
      metadata: { sessionId: taskID, mode: "background" },
      output: `Background task started. task_id: ${taskID}\nUse background_output to retrieve results when ready.`,
    }
  }

  // serial / concurrent 模式：await 执行（concurrent 由 loop 层面并行化）
  const model = resolveModel(params, agent, ctx)
  const result = await SessionPrompt.prompt({
    sessionID: session.id,
    model,
    agent: agent.name,
    parts: resolvePromptParts(params, discipline),
    tools: computeToolOverrides(effectivePermission),
    maxSteps: session.maxSteps,
  })

  const text = extractResult(result, discipline.return_format)

  return {
    title: params.description,
    metadata: { sessionId: session.id, model },
    output: formatOutput(text, session.id, discipline.return_format),
  }
}
```

---

## 六、错误兜底方案

### 6.1 错误分类与处理矩阵

| 错误类型                     | 严重度 | 处理                                             | 结果标记                     |
| ---------------------------- | ------ | ------------------------------------------------ | ---------------------------- |
| API 临时错误 (429, 503, 529) | 中     | 自动 retry（最多 3 次） + fallback_models 降级   | `error` + `retryable: true`  |
| 模型不存在                   | 高     | 直接失败                                         | `error` + `retryable: false` |
| 权限拒绝 (DeniedError)       | 中     | 记录拒绝信息，子代理继续尝试其他工具             | `completed`（可能 partial）  |
| 权限拒绝 (RejectedError)     | 中     | 用户明确拒绝，子代理终止                         | `error` + `retryable: false` |
| 上下文溢出                   | 高     | 触发 compaction → 如果恢复则继续，否则 `partial` | `partial`                    |
| 超时                         | 中     | 保存已完成部分                                   | `timeout`                    |
| 主 session abort             | 高     | 所有后台子 session 立即 cancel                   | `cancelled`                  |
| 子代理空转/停滞              | 中     | step counter 检测 → 超过 max_steps 终止          | `partial`                    |
| 子代理产出无结果             | 低     | 返回空 text                                      | `completed`（空结果）        |

### 6.2 BackgroundResult Schema

```ts
interface BackgroundResult {
  taskID: SessionID
  status: "completed" | "error" | "partial" | "timeout" | "cancelled"
  text: string
  error?: {
    type: "api_error" | "permission" | "overflow" | "timeout" | "unknown"
    message: string
    statusCode?: number
    retryable: boolean
  }
  toolsUsed: string[]
  executionTime: number
  stepsCompleted: number
}
```

### 6.3 兜底原则

1. **永远保存结果** — 即使子代理失败，也保存 `error` 或 `partial` 详情。主代理不应面对"结果凭空消失"。
2. **永远不注入消息** — 后台结果只存 resultStore，主代理主动取回。避免时序冲突。
3. **超时后保存已完成部分** — 子代理超时但已完成了 5 步中的 3 步，保存这 3 步产出而非丢弃。
4. **error.retryable 标记** — 429/503 类错误标记为 retryable，主代理可决定是否重试。
5. **主代理必须处理所有状态** — 主代理 system prompt 包含纪律指令："background_output 返回 error/partial 时：评估 partial 是否足够 → 决定是否重试 → 或调整计划"。

---

## 七、实现分阶段计划

### Phase 1: 核心安全与并行基础（高优先级）

| 改动                        | 文件                                                     | 说明                                                           |
| --------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| **Permission.intersection** | `permission/index.ts`                                    | 交集逻辑，修复安全漏洞                                         |
| **delegation_depth**        | `task.ts`, `session/schema.ts`, `session/session.sql.ts` | 委派深度计数器                                                 |
| **Loop 并行执行**           | `session/prompt.ts`                                      | `executeSubtask()` 提取 + `Promise.all` 并行                   |
| **SubtaskPart 扩展**        | `message-v2.ts`                                          | 增加 `discipline` 字段                                         |
| **Task 参数扩展**           | `tool/task.ts`                                           | 增加 mode, delegation_depth, permission_override, max_steps 等 |

**Phase 1 完成后**：子代理权限不再有安全漏洞，同一 turn 中的多个 subtask 可以并行执行，委派深度受控。

### Phase 2: 后台执行与错误兜底（高优先级）

| 改动                         | 文件                                       | 说明                                |
| ---------------------------- | ------------------------------------------ | ----------------------------------- |
| **BackgroundTask namespace** | `session/background.ts`（新建）            | spawn/output/status                 |
| **Result Buffer Pool**       | `session/background-result.sql.ts`（新建） | 结果持久化                          |
| **background_output 工具**   | `tool/background-output.ts`（新建）        | 取回后台结果                        |
| **Concurrency 控制**         | `session/concurrency.ts`（新建）           | 并发上限 + 排队                     |
| **Loop 后台 task 分支**      | `session/prompt.ts`                        | 分离 backgroundTasks                |
| **SubtaskCompleted event**   | `session/index.ts`                         | Bus event（仅状态广播，不注入消息） |

**Phase 2 完成后**：后台执行模式可用，错误兜底完备，并发受控。

### Phase 3: 行为边界增强（中优先级）

| 改动                    | 文件                                                  | 说明                    |
| ----------------------- | ----------------------------------------------------- | ----------------------- |
| **file_scope**          | `permission/index.ts`, `tool/task.ts`, `tool/tool.ts` | 路径范围约束            |
| **max_steps loop 检查** | `session/prompt.ts`                                   | step counter + 超限终止 |
| **timeout_seconds**     | `session/background.ts`, `session/prompt.ts`          | 超时控制                |
| **return_format**       | `tool/task.ts`, prompt 指令                           | 输出格式纪律            |

### Phase 4: 优化与 UX（低优先级）

| 改动                  | 文件                             | 说明                              |
| --------------------- | -------------------------------- | --------------------------------- |
| **工具描述过滤**      | `session/prompt.ts resolveTools` | 只展示有权限的工具                |
| **UI 状态显示**       | 前端                             | 后台 task 进度（"2/3 completed"） |
| **task.txt 描述更新** | `tool/task.txt`                  | 包含 discipline 参数说明          |

---

## 八、风险分析

### 8.1 Effect fiber vs Bun worker

后台执行需选择执行机制：

| 选项                  | 优势                                                        | 劣势                                        |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| **Effect.forkScoped** | 与现有架构一致，共享 InstanceState/Bus，fiber 随 scope 清理 | 同进程，一个 fiber crash 可能影响其他       |
| **Bun Worker**        | 完全隔离，独立进程                                          | 需要进程间通信（postMessage），状态同步复杂 |

**建议**：先用 `Effect.forkScoped`。Aether 的 Effect 架构已经完善，fiber 在 InstanceState scope 下自动清理。Worker 的隔离优势在当前场景下不值得引入的通信复杂度。

### 8.2 Loop 并行的时序安全

当 `Promise.all` 并行执行多个 subtask 时，每个 subtask 都会创建 assistant message + tool part。这些写入必须是独立的（不依赖前一条消息的 ID），否则会有序号冲突。

**当前代码已满足**：每个 subtask 创建独立的 `MessageID.ascending()` 和 `PartID.ascending()`，不依赖其他 subtask 的消息。并行写入 DB 是安全的（SQLite WAL 模式 + 顺序 ID 生成）。

### 8.3 权限交集的性能

`Permission.intersection()` 需要对每条规则做 `evaluate()` 匍配，O(n\*m) 复杂度。当前规则集很小（通常 < 30 条），性能不是问题。但需要确保交集结果是**固定的规则集**（不随主代理的 approved 动态变化），否则每次权限检查都要重新计算交集。

**建议**：在 `Session.create` 时一次性计算 `effectivePermission`，存入 session.Info，后续所有权限检查直接使用。

### 8.4 主代理 LLM 的模式选择

不应让 LLM 自由选择 `mode`。LLM 会倾向于全部用 serial（更简单、更可控）。建议：

1. **task.txt 描述中明确指导**：当需要并行搜索多个方向时，使用 concurrent；当需要后台工作时，使用 background。
2. **Skill prompt 中注入模式建议**：如 research skill 的 Phase 1 使用 concurrent，Phase 2 使用 serial。
3. **系统不自动决策**：让 LLM 在 prompt 指导下做选择，而非硬编码规则。这保持了灵活性。

### 8.5 Abort 传播

主 session abort 时，必须取消所有后台子 session。当前代码（`task.ts:155-159`）已经通过 `ctx.abort.addEventListener("abort", cancel)` 实现了 abort 传播。后台模式需要类似机制：

- `BackgroundTask.spawn()` 中注册 abort listener
- abort 触发时：`SessionPrompt.cancel(session.id)` + 标记结果为 `cancelled`

---

## 九、与现有代码的兼容性

### 9.1 默认值保持向后兼容

| 参数                  | 默认值        | 行为                                 |
| --------------------- | ------------- | ------------------------------------ |
| `mode`                | `"serial"`    | 与当前行为一致                       |
| `delegation_depth`    | `0`           | 与当前行为一致（子代理默认不能委派） |
| `permission_override` | `undefined`   | 不覆盖，纯用交集逻辑                 |
| `max_steps`           | `agent.steps` | 与当前行为一致                       |
| `timeout_seconds`     | `300`         | 新增，但 300 秒足够长不影响正常任务  |
| `file_scope`          | `undefined`   | 不限制，与当前行为一致               |
| `return_format`       | `"text"`      | 与当前行为一致                       |

### 9.2 不破坏现有功能

- 所有新参数都有默认值，现有 LLM 不传这些参数时行为不变
- `Permission.intersection()` 替换 `Permission.merge()` 用于子代理场景，但 `merge()` 本身仍保留用于非子代理场景（如 user config + agent config 合并）
- `BackgroundTask` 和 `background_output` 是新增模块，不影响现有代码路径

### 9.3 SubtaskPart 扩展

`discipline` 字段是 optional。现有 SubtaskPart 不含此字段时，loop 代码使用默认 discipline（mode=serial），行为不变。

---

## 十、完整文件改动清单

| 文件                               | Phase      | 改动                                                            |
| ---------------------------------- | ---------- | --------------------------------------------------------------- |
| `permission/index.ts`              | 1          | 新增 `intersection()`, `fromOverride()`, `evaluateWithScope()`  |
| `permission/evaluate.ts`           | 1          | 无改动（intersection 在 index.ts 中调用 evaluate）              |
| `tool/task.ts`                     | 1, 3       | 参数扩展 + execute 改造（交集权限 + 模式分支 + discipline）     |
| `tool/task.txt`                    | 4          | 描述更新（增加 mode/delegation/override 说明）                  |
| `session/message-v2.ts`            | 1          | SubtaskPart 增加 `discipline` 字段                              |
| `session/schema.ts`                | 1, 3       | Info 增加 `delegationDepth`, `maxSteps`, `fileScope` 字段       |
| `session/session.sql.ts`           | 1, 3       | DB schema 增加 `delegation_depth`, `max_steps`, `file_scope` 列 |
| `session/prompt.ts`                | 1, 2, 3, 4 | loop 改造（并行执行 + 后台分支 + maxSteps 检查 + 工具过滤）     |
| `session/background.ts`            | 2          | 新建：BackgroundTask namespace（spawn/output/status）           |
| `session/background-result.sql.ts` | 2          | 新建：结果缓冲池 DB schema                                      |
| `tool/background-output.ts`        | 2          | 新建：background_output 工具                                    |
| `session/concurrency.ts`           | 2          | 新建：并发控制                                                  |
| `session/index.ts`                 | 2          | SubtaskCompleted event 定义                                     |
| `tool/registry.ts`                 | 2          | 注册 BackgroundOutputTool                                       |
| `config/config.ts`                 | 2          | 增加 concurrency 配置字段                                       |
| `tool/tool.ts`                     | 3          | Context 增加 `fileScope`                                        |
| `session/prompt.ts resolveTools`   | 4          | 工具描述按权限过滤                                              |
