# 子代理并行执行与行为纪律控制 — 手动测试方案

> 本文档提供从拉起测试环境到验证每个新功能点的完整步骤指南。

---

## 前置准备

### 1. 确认 API Key 配置

你需要至少一个 LLM provider 的 API key。测试推荐使用 Anthropic（Claude Sonnet）或 OpenAI（GPT-4o），因为它们支持多 tool call 并行执行。

创建配置文件：

```bash
mkdir -p ~/.config/opencode
cat > ~/.config/opencode/config.json << 'EOF'
{
  "provider": {
    "anthropic": {
      "apiKey": "<你的 Anthropic API Key>"
    }
  },
  "model": "anthropic/claude-sonnet-4"
}
EOF
```

或者使用 OpenAI：

```bash
cat > ~/.config/opencode/config.json << 'EOF'
{
  "provider": {
    "openai": {
      "apiKey": "<你的 OpenAI API Key>"
    }
  },
  "model": "openai/gpt-4o"
}
EOF
```

也可以通过环境变量设置：

```bash
export ANTHROPIC_API_KEY="<你的 key>"
export OPENAI_API_KEY="<你的 key>"
```

### 2. 准备测试项目目录

创建一个简单的项目目录用于测试：

```bash
mkdir -p /tmp/parallel-test-project
cd /tmp/parallel-test-project
git init

# 创建一些测试文件
cat > src/auth.ts << 'EOF'
export function authenticate(username: string, password: string): boolean {
  return username === "admin" && password === "secret"
}
EOF

cat > src/utils.ts << 'EOF'
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]
}

export function calculateSum(numbers: number[]): number {
  return numbers.reduce((a, b) => a + b, 0)
}
EOF

cat > package.json << 'EOF'
{
  "name": "parallel-test-project",
  "version": "1.0.0"
}
EOF

git add . && git commit -m "initial commit"
```

### 3. 启动 TUI

```bash
cd packages/opencode
bun run dev -- /tmp/parallel-test-project
```

---

## 测试 1: 基本子代理调用（向后兼容性）

**目的**: 确认新增的 discipline 参数有默认值，不传时行为与之前一致。

**步骤**:

1. 启动 TUI
2. 输入 prompt: `"用 explore 子代理搜索 src 目录中所有 .ts 文件"`
3. 观察:
   - 子代理正常启动并返回结果
   - 结果包含 `task_id` 用于恢复
   - 权限检查正常（可能弹出 permission ask）

**预期**: 与改动前完全一致的行为。

---

## 测试 2: Permission.intersection — 子代理权限降级

**目的**: 确认子代理不能获得主代理没有的权限。

### 2a: 基本交集验证

1. 输入 prompt: `"用 general 子代理搜索代码，mode=serial, delegation_depth=0"`
2. 观察 general 子代理的权限:
   - general 默认没有 `todowrite` 和 `task` 权限 → 应被 deny
   - 如果主代理的 `bash` 是 `deny`，子代理即使配置为 `allow`，也必须被 deny

### 2b: 动态权限覆盖

1. 输入 prompt 使用 permission_override 参数:
   ```
   用 general 子代理搜索 auth 实现，
   permission_override={"edit": ["allow"], "task": ["deny"]}
   ```
2. 观察:
   - 子代理应获得 `edit: allow`（如果主代理也有 edit 权限）
   - 子代理应被 `task: deny`（无法再委派）
   - 如果主代理 `bash: deny`，即使 override 中设置 `bash: ["allow"]`，子代理的 bash 仍应为 deny

**验证方式**: 在子代理 session 中，被 deny 的工具应不出现在工具描述中（如果 Phase 4 已实现），或者调用被 deny 的工具时应返回权限拒绝错误。

---

## 测试 3: delegation_depth — 委派深度控制

### 3a: depth=0（默认，不能委派）

1. 输入 prompt: `"用 general 子代理做搜索，delegation_depth=0"`
2. 观察:
   - 子代理的 `task` 权限应为 `deny`
   - 子代理无法再调用 task 工具委派其他子代理

### 3b: depth=1（可委派一层）

1. 输入 prompt: `"用 general 子代理做深度搜索，delegation_depth=1"`
2. 观察:
   - 子代理获得 `task: allow` 权限
   - 子代理可以再委派一层（如调用 explore 子代理）
   - 子代理委派时，下一层的 delegation_depth 应为 0（自动递减）
   - 第二层子代理无法再委派

### 3c: depth=2（可委派两层）

1. 输入 prompt: `"用 general 子代理做深度搜索，delegation_depth=2"`
2. 观察:
   - 第一层子代理（general）可以委派
   - 第二层子代理（如 explore）也可以委派一次
   - 第三层子代理的 `task` 权限应为 deny

---

## 测试 4: 并行执行 — 同一 turn 多 task call

**目的**: 确认 LLM 在同一 turn 发起多个 task tool call 时，它们并发执行而非串行。

### 4a: 并行搜索

1. 输入 prompt:

   ```
   同时用3个 explore 子代理搜索：
   1. 搜索 src/auth.ts 中的认证逻辑
   2. 搜索 src/utils.ts 中的工具函数
   3. 搜索 package.json 的依赖配置

   对每个子代理使用 mode=concurrent
   ```

2. 观察:
   - LLM 应在同一 assistant turn 中发出3个 task tool call
   - AI SDK 应通过 Promise.all 并行执行这3个 tool call
   - 所有3个结果应同时返回给主代理（而非逐个等待）

**验证**: 查看日志中3个子代理 session 的创建时间是否接近（而非依次创建）。可以在 TUI 的 tool parts 中看到3个并行的 task invocation。

### 4b: 并行+串行混合

1. 输入 prompt:
   ```
   先用 explore 子代理搜索认证代码（mode=serial），
   同时用另一个 explore 子代理搜索工具函数（mode=concurrent）
   ```
2. 观察:
   - 两个 task call 应在同一 turn 中发出
   - AI SDK 并行执行

---

## 测试 5: 后台执行 — mode=background

**目的**: 确认后台子代理不阻塞主代理。

### 5a: 基本后台执行

1. 输入 prompt:
   ```
   用 explore 子代理在后台搜索所有 TypeScript 文件的类型定义，
   mode=background，
   同时你继续分析 package.json 的内容
   ```
2. 观察:
   - Task tool 应立即返回，输出包含 "Background task started" 和 task_id
   - 主代理应继续分析 package.json，不被阻塞
   - 后台子代理在独立线程中运行

### 5b: 取回后台结果

1. 继续对话，输入:
   ```
   用 background_output 工具取回刚才的后台任务结果
   ```
2. 观察:
   - background_output 工具应返回子代理的结果文本
   - 如果子代理已完成，返回完整结果
   - 如果仍在运行，应等待完成或返回运行状态

### 5c: 后台任务超时

1. 输入 prompt:
   ```
   用 explore 子代理在后台做一个非常深入的搜索，
   mode=background，
   timeout_seconds=30
   ```
2. 等待30秒后取回结果
3. 观察:
   - 如果子代理30秒内完成，正常返回结果
   - 如果超时，返回 timeout 状态和 partial 结果

---

## 测试 6: max_steps — 步数限制

**目的**: 确认子代理在达到步数上限后终止。

1. 输入 prompt:
   ```
   用 general 子代理做搜索和修改，
   max_steps=3
   ```
2. 观察:
   - 子代理最多执行3个 loop iteration
   - 达到上限后，子代理应生成总结消息并退出

---

## 测试 7: file_scope — 文件范围约束

**目的**: 确认子代理只能访问指定路径。

1. 输入 prompt:
   ```
   用 explore 子代理搜索 src 目录中的类型定义，
   file_scope=["src/**"]
   ```
2. 观察:
   - 子代理应能读取 src/auth.ts、src/utils.ts
   - 子代理应不能读取 package.json（不在 scope 中）
   - 当子代理尝试读取不在 scope 中的文件时，应被权限系统 deny

---

## 测试 8: return_format — 输出纪律

### 8a: structured 输出

1. 输入 prompt:
   ```
   用 explore 子代理搜索认证实现，
   return_format=structured，
   输出必须以 JSON 格式返回：{"file": "文件路径", "functions": ["函数列表"], "summary": "简要描述"}
   ```
2. 观察:
   - 子代理应尝试以结构化格式输出结果

### 8b: raw trace

1. 输入 prompt:
   ```
   用 explore 子代理搜索认证实现，
   return_format=raw
   ```
2. 观察:
   - 应返回完整的对话 trace（包含所有 tool call 结果）

---

## 测试 9: 状态检验 — 子代理发放与回收稳定性

### 9a: 正常流程完整验证

1. 发起一个后台任务，确认 task_id 返回
2. 等待完成后，用 background_output 取回结果
3. 再用 background_output 取回同一个 task_id，确认第二次仍返回相同结果（不丢失）

### 9b: 主 session abort 取消后台任务

1. 发起一个后台任务
2. 在子代理运行期间，取消主 session（Ctrl+C）
3. 确认:
   - 后台子 session 被 cancel
   - 取回结果时返回 cancelled 状态
   - 不出现资源泄漏

### 9c: 多后台任务并发

1. 同时发起3个后台任务（不同 prompt）
2. 等待全部完成
3. 逐一用 background_output 取回结果，确认每个 task_id 对应正确结果

---

## 测试 10: 非交互模式验证

如果不想用 TUI，可以用非交互 `run` 命令测试：

```bash
# 基本子代理调用
bun run dev -- run "用 explore 子代理搜索 src 目录中的所有 ts 文件"

# 并行调用（LLM 可能自然发出多个 task call）
bun run dev -- run "同时搜索3个方向：认证逻辑、工具函数、依赖配置"

# 后台执行
bun run dev -- run "用 explore 子代理在后台搜索类型定义，mode=background，你继续分析项目结构"
```

---

## 单元测试补充

### Permission.intersection 测试

在 `test/permission/` 目录下新增测试：

```ts
import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"

describe("Permission.intersection", () => {
  test("parent deny overrides child allow", () => {
    const parent = [{ permission: "bash", pattern: "*", action: "deny" }]
    const child = [{ permission: "bash", pattern: "*", action: "allow" }]
    const result = Permission.intersection(parent, child)
    expect(result.find((r) => r.permission === "bash")?.action).toBe("deny")
  })

  test("child can be stricter than parent", () => {
    const parent = [{ permission: "edit", pattern: "*", action: "allow" }]
    const child = [{ permission: "edit", pattern: "*", action: "deny" }]
    const result = Permission.intersection(parent, child)
    expect(result.find((r) => r.permission === "edit")?.action).toBe("deny")
  })

  test("parent allow + child allow = allow", () => {
    const parent = [{ permission: "read", pattern: "*", action: "allow" }]
    const child = [{ permission: "read", pattern: "*", action: "allow" }]
    const result = Permission.intersection(parent, child)
    expect(result.find((r) => r.permission === "read")?.action).toBe("allow")
  })

  test("override is merged with child and capped by parent", () => {
    const parent = [{ permission: "bash", pattern: "*", action: "deny" }]
    const child = [{ permission: "task", pattern: "*", action: "deny" }]
    const override = [{ permission: "bash", pattern: "*", action: "allow" }]
    const result = Permission.intersection(parent, child, override)
    expect(result.find((r) => r.permission === "bash")?.action).toBe("deny")
    expect(result.find((r) => r.permission === "task")?.action).toBe("deny")
  })
})
```

### Discipline.fromOverride 测试

```ts
import { describe, expect, test } from "bun:test"
import { fromOverride } from "../../src/session/discipline"

describe("Discipline.fromOverride", () => {
  test("single action creates wildcard pattern", () => {
    const result = fromOverride({ edit: ["allow"], bash: ["deny"] })
    expect(result).toEqual([
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ])
  })

  test("action with path patterns creates scoped rules", () => {
    const result = fromOverride({ edit: ["allow", "src/**"] })
    expect(result).toContainEqual({ permission: "edit", pattern: "src/**", action: "allow" })
  })
})
```

---

## 测试执行顺序建议

| 序号 | 测试                   | 优先级 | 说明                   |
| ---- | ---------------------- | ------ | ---------------------- |
| 1    | 测试 1 (向后兼容)      | 最高   | 确保改动不破坏现有功能 |
| 2    | 测试 2a (权限交集)     | 最高   | 安全核心功能           |
| 3    | 测试 3a (depth=0)      | 高     | 委派控制基础           |
| 4    | 测试 4a (并行搜索)     | 高     | 并行执行核心能力       |
| 5    | 测试 5a+5b (后台执行)  | 高     | 后台模式核心流程       |
| 6    | 测试 9a (状态检验)     | 高     | 稳定性验证             |
| 7    | 测试 2b (动态覆盖)     | 中     | 需要手动构造 override  |
| 8    | 测试 3b+3c (多层委派)  | 中     | 需要子代理实际委派     |
| 9    | 测试 6 (max_steps)     | 中     | 需要观察步数计数       |
| 10   | 测试 7 (file_scope)    | 中     | 需要尝试越界访问       |
| 11   | 测试 8 (return_format) | 低     | 输出格式约束           |
| 12   | 测试 5c (超时)         | 低     | 需要等待30秒           |
| 13   | 测试 9b (abort取消)    | 低     | 需要手动中断           |
| 14   | 单元测试               | 高     | 随时可执行             |

---

## 运行单元测试

```bash
cd packages/opencode

# 运行所有测试
bun test

# 只运行权限相关测试
bun test test/permission/

# 只运行 task tool 测试
bun test test/tool/task.test.ts
```
