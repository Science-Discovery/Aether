# App E2E Prompt Flake Analysis

日期：2026-04-13

## 背景

GitHub Actions 上的 `app e2e (linux)` 在运行 `packages/app/e2e/ci-specs-serial.txt` 中的串行用例时出现失败与波动。

相关串行用例当前包括：

- `e2e/files/file-viewer.spec.ts`
- `e2e/prompt/prompt-async.spec.ts`
- `e2e/prompt/prompt-history.spec.ts`
- `e2e/prompt/prompt.spec.ts`
- `e2e/terminal/terminal-init.spec.ts`
- `e2e/terminal/terminal-reconnect.spec.ts`

第一次失败的关键汇总为：

- `1 failed`
  - `e2e/prompt/prompt.spec.ts`
- `2 flaky`
  - `e2e/prompt/prompt-async.spec.ts`
  - `e2e/prompt/prompt-history.spec.ts`
- `7 passed`

后续 rerun 时，`prompt.spec.ts` 通过，但 `prompt-history.spec.ts` 仍然表现为 flaky。

## 先澄清一个容易误读的点

日志最后打印到：

- `[16/10] (retries) ... e2e/terminal/terminal-reconnect.spec.ts`

这不表示 `terminal-reconnect.spec.ts` 是最终失败点。

真正导致 job 失败的，必须以 Playwright 最后的 summary 为准。第一次失败时，summary 明确显示：

- 真正的 hard failure 是 `e2e/prompt/prompt.spec.ts`
- `prompt-async.spec.ts` 和 `prompt-history.spec.ts` 是 flaky
- `terminal-reconnect.spec.ts` 没有出现在 failed/flaky 列表里

因此：

- `terminal-reconnect.spec.ts` 只是最后一个被调度/打印的测试项
- 不是这次红灯的根因

## 实际现象

失败时，多个 prompt 相关用例拿到的 assistant 文本是：

```text
I'm sorry, but I cannot assist with that request.
```

而测试期望的是包含形如：

- `E2E_OK_<timestamp>`
- `E2E_ASYNC_<timestamp>`
- `E2E_HISTORY_ONE_<timestamp>`
- `E2E_HISTORY_TWO_<timestamp>`

的精确 token。

这说明失败时：

- 不是“没有收到回复”
- 而是“收到了一个不符合测试预期的真实回复/拒答”

## 根因判断

### 结论

当前 `test:e2e:local` 默认 prompt 测试路径，并没有把 LLM 固定到可控的测试 LLM 上。

因此这些 prompt 用例实际上是在拿真实 provider 的行为当作确定性断言的前提，这就是 flaky 的根源。

### 关键证据链

#### 1. `e2e-local` 只设置了模型，没有设置测试 LLM URL

文件：

- [packages/app/script/e2e-local.ts](/tmp/aether-e2e-fixes-20260413/packages/app/script/e2e-local.ts:60)

这里会设置：

- `OPENCODE_E2E_MODEL`

但没有设置：

- `OPENCODE_E2E_LLM_URL`

#### 2. provider 侧只有在 `OPENCODE_E2E_LLM_URL` 存在时才会强制改写到测试 LLM

文件：

- [packages/opencode/src/provider/provider.ts](/tmp/aether-e2e-fixes-20260413/packages/opencode/src/provider/provider.ts:157)
- [packages/opencode/src/provider/provider.ts](/tmp/aether-e2e-fixes-20260413/packages/opencode/src/provider/provider.ts:1438)

逻辑是：

- 如果 `OPENCODE_E2E_LLM_URL` 存在
  - 所有模型调用都会被重定向到 OpenAI-compatible 的测试 LLM
- 如果不存在
  - 就继续走正常 provider 路径

#### 3. 出问题的三个 prompt 用例走的是默认路径，不是隔离 backend

文件：

- [packages/app/e2e/fixtures.ts](/tmp/aether-e2e-fixes-20260413/packages/app/e2e/fixtures.ts:285)
- [packages/app/e2e/fixtures.ts](/tmp/aether-e2e-fixes-20260413/packages/app/e2e/fixtures.ts:288)

这里的默认：

- `sdk`
- `gotoSession()`

连的是 `e2e-local` 启动的默认后端。

而只有 `project` / `backend` fixture 才会启动 `TestLLMServer` 并注入 `llmUrl`：

- [packages/app/e2e/fixtures.ts](/tmp/aether-e2e-fixes-20260413/packages/app/e2e/fixtures.ts:193)

#### 4. 三条失败/波动用例都在要求 assistant 精确回显 token

文件：

- [packages/app/e2e/prompt/prompt.spec.ts](/tmp/aether-e2e-fixes-20260413/packages/app/e2e/prompt/prompt.spec.ts:5)
- [packages/app/e2e/prompt/prompt-async.spec.ts](/tmp/aether-e2e-fixes-20260413/packages/app/e2e/prompt/prompt-async.spec.ts:10)
- [packages/app/e2e/prompt/prompt-history.spec.ts](/tmp/aether-e2e-fixes-20260413/packages/app/e2e/prompt/prompt-history.spec.ts:82)

这些用例都依赖类似：

```text
Reply with exactly: E2E_...
```

然后断言 assistant 文本包含这个 token。

当回复来源是外部真实 provider 时，这种断言天然不稳定。

## 为什么第一次失败与第二次 rerun 的表现不同

### 第一次 run

- `prompt.spec.ts` 三次都失败
- `prompt-async.spec.ts` / `prompt-history.spec.ts` 经过重试后有通过，所以被标 flaky

### 第二次 rerun

- `prompt.spec.ts` 通过
- `prompt-history.spec.ts` 仍然 flaky

这恰恰说明：

- 问题不是稳定可复现的本地逻辑 bug
- 而是外部回复来源存在非确定性

换句话说：

- 同一份代码
- 同一条 prompt
- 不同 run 拿到不同结果

更像“真实 provider 波动”而不是“app 逻辑固定缺陷”。

## 为什么不能简单认为“只修 `prompt.spec.ts` 就够了”

虽然第一次红灯的直接失败点是 `prompt.spec.ts`，但底层问题不是它单独一条。

因为：

- `prompt.spec.ts`
- `prompt-async.spec.ts`
- `prompt-history.spec.ts`

三者都共享同一类假设：

- 真实 assistant 会稳定、精确地按要求返回 token

所以：

- `prompt.spec.ts` 这次是最终 hard fail
- 另外两条只是“运气更好”，所以表现成 flaky

如果只给 `prompt.spec.ts` 打补丁，而不处理三者共享的根因，那么：

- 当前红灯可能消失
- 但另外两条仍然会继续波动

## 为什么“直接把这三条 spec 切去 mock backend”也不是立刻可提交的方案

本次分析过程中，已经在 worktree 中做过实验性验证：

- 尝试将三条 prompt spec 改为走隔离 backend + `TestLLMServer`
- 目的：验证“去掉真实 provider 后是否稳定”

实验结果：

- 的确不再出现原先那种真实 provider 拒答问题
- 但会撞上另一层 harness 假设：
  - `waitSessionSaved(...)`
  - `promptSend(...)`
  - `project.prompt()` / `project.shell()` 的发送/保存时序

也就是说：

- 方向判断是对的
- 但“只改三条 spec”会引入新的测试时序问题
- 这不是一个足够稳妥的最终修复方式

实验性改动最终已全部回退，当前 worktree 没有遗留代码变更。

## 到底应该怎么修

### 核心原则

把两件本来混在一起的事情拆开：

1. merge-blocking 的 app e2e
   - 主要测“我们自己的 app 行为是否正确”
2. 真实 provider 连通性
   - 主要测“外部服务今天是否可用”

这两类测试不应该共用同一个通过标准。

## 推荐方案

### 方案目标

保留这三条 spec 的测试意图不变：

- `prompt.spec.ts`
  - 仍然测普通 prompt 发送与回复链路
- `prompt-async.spec.ts`
  - 仍然测同步 `/message` 失败后，异步路径是否能完成回复
- `prompt-history.spec.ts`
  - 仍然测 prompt history / shell history 机制

改变的是“assistant 回复来源”，不是改变测试主题。

### 推荐落地方式

#### 1. 给默认 e2e harness 增加“可选测试 LLM”能力

修改目标：

- [packages/app/script/e2e-local.ts](/tmp/aether-e2e-fixes-20260413/packages/app/script/e2e-local.ts)

做法：

- 新增一个开关，例如：
  - `OPENCODE_E2E_USE_TEST_LLM=1`
- 当开关开启时：
  - 启动 `TestLLMServer`
  - 把它的 URL 注入默认 server env，例如：
    - `OPENCODE_E2E_LLM_URL=<test llm url>`

这样：

- 默认的 `sdk + gotoSession()` 路径也能连到 mock LLM
- 不必强行把那三条 spec 改写为 `project` fixture 风格

#### 2. 不要一开始就全局打开

这是风险控制的关键。

更稳妥的方式是：

- 先让这个能力是可选的
- 只在单独的 CI step 里启用
- 只用于那三条 prompt 相关 serial specs

而不是：

- 一上来就让所有 `test:e2e:local` 都改走 mock LLM

#### 3. 保留一条真实 provider 的 non-blocking smoke

真实 provider 依然值得测，但不应该拿来阻断 merge。

建议单独保留一个 smoke job：

- 接真实 provider
- 只断言：
  - 能收到 assistant 回复
  - 没有认证/5xx 错误
  - session 没卡死
- 不断言：
  - 必须精确输出 `E2E_OK_xxx`
  - 必须一字不差复读 token

## 风险评估

这是本次讨论中最需要严谨对待的部分。

### 如果粗暴“全局把默认 e2e 后端切到 mock LLM”

风险偏高。

原因是当前 e2e 中存在两类用例：

#### A. 只测 UI / 本地行为的测试

这类风险较低，通常不会太依赖真实 assistant 内容。

例如：

- `file-viewer`
- `prompt-mention`
- `models-visibility`
- `settings-models`
- `status-popover`
- 一些 `noReply: true` 的 seed message 场景

#### B. 借助 agent/LLM 产生系统状态的测试

这类风险较高。

典型包括：

- [packages/app/e2e/session/session-child-navigation.spec.ts](/tmp/aether-e2e-fixes-20260413/packages/app/e2e/session/session-child-navigation.spec.ts)
- [packages/app/e2e/session/session-composer-dock.spec.ts](/tmp/aether-e2e-fixes-20260413/packages/app/e2e/session/session-composer-dock.spec.ts)
- [packages/app/e2e/actions.ts](/tmp/aether-e2e-fixes-20260413/packages/app/e2e/actions.ts:744)
  中的：
  - `seedSessionQuestion`
  - `seedSessionPermission`
  - `seedSessionTask`
  - `seedSessionTodos`

这些 helper 本质上依赖：

- 给模型一个严格 prompt
- 让模型触发特定 tool call
- 以此制造问题卡片、权限卡片、任务卡片、todo 状态等

如果默认 LLM 被替换成一个只会返回普通文本的 mock：

- 这些测试会直接失效
- 或产生新的虚假失败

### 因此更安全的结论是

不建议一步到位全局切换。

建议采用保守方案：

- 先给默认 harness 增加 mock LLM 开关
- 只在指定 prompt spec 的 CI step 中启用
- 其它 e2e 暂时保持原语义

这样风险可控得多。

## 最终结论

### 已确认的事实

1. 第一次 Linux e2e 红灯的真正 hard fail 是 `e2e/prompt/prompt.spec.ts`
2. `terminal-reconnect.spec.ts` 不是根因
3. `prompt-async.spec.ts` 与 `prompt-history.spec.ts` 的 flaky，与 `prompt.spec.ts` 共享同一类根因
4. 根因是默认 prompt e2e 路径没有固定到测试 LLM，而是在依赖真实 provider 的非确定性行为

### 已排除的误判

- 不是 Vite 的 JSX warning 导致失败
- 不是 `terminal-reconnect.spec.ts` 导致失败
- 不能简单归因于“Linux 专属 bug”

### 当前最推荐的方案

1. 保留三条 prompt spec 的测试意图不变
2. 在 `packages/app/script/e2e-local.ts` 中增加“可选测试 LLM”能力
3. 先只让那三条 prompt spec 或一个单独 CI step 启用它
4. 真实 provider 单独保留 non-blocking smoke，只测“能回复”，不测“必须复读 token”

### 当前不建议的方案

- 直接把全量 `test:e2e:local` 默认后端无条件切成 mock LLM
- 只在三条 prompt spec 内部强行改成 `project`/isolated backend，而不处理 harness 自身时序假设

## 后续实施建议

如果后续继续处理，建议按以下顺序推进：

1. 在 `e2e-local.ts` 中实现 mock LLM 开关
2. 新增一个只跑三条 prompt spec 的 CI step，并开启该开关
3. 验证这三条在 Linux CI 上是否稳定
4. 单独新增/保留真实 provider smoke，设置为 non-blocking
5. 再评估是否有必要扩大 mock LLM 覆盖范围

## 备注

本次讨论中产生过实验性代码修改，但已全部回退。

截至本文写入时：

- 当前 worktree 无残留代码变更
- 文档仅作为后续处理依据与决策记录
