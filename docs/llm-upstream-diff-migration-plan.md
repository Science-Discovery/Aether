# LLM 调用链差异与回迁计划

## 背景与结论

本仓库已经通过 `docs/llm-call-chain.md` 梳理了当前 LLM 调用链，并通过 `docs/llm-system-smoke-tests/llm-system-test-requirements.md` 固定了真实 provider smoke 的需求边界。但上游 `dev` 分支仍在高速变化，尤其是 AI SDK、provider SDK、reasoning、tool call、OpenAI-compatible 方言和 `models.dev` 元数据相关代码。

后续同步不采用单纯扫描 commit，也不采用整块覆盖上游代码。推荐流程是：

1. **以方案 2 为主**：直接比较当前仓库与上游 clone 的 LLM call chain 相关代码，先回答“当前实现实际差了什么”。
2. **以方案 1 校验**：再回查 2026-03-26 之后进入上游 `dev` 的相关 commit/PR，理解 diff 的来源、意图和 bugfix 优先级。
3. 最终产出一份可执行的回迁清单，每一项都标明影响范围、是否适合移植、如何测试，而不是直接生成大面积 patch。

这样做的原因是：上游自 2026-03-26 以来在 `session`、`provider`、`config`、依赖和测试路径上有大量 Effect 化、HttpApi、文件拆分和工具系统重构。单纯按 commit 扫描会混入大量架构噪音；单纯看 diff 又容易漏掉某个小改动背后的真实 bugfix 背景。两者组合可以减少遗漏，也能避免把上游架构重构误判成必须回迁的 LLM 修复。

## 输入与范围

默认输入：

- 当前仓库：本仓库工作区
- 上游 clone：本地克隆的上游仓库工作区，下文以 `<UPSTREAM>` 指代
- 当前仓库默认分支：`dev`
- 上游分支：`dev`
- 默认时间窗口：从 `2026-03-26` 起，后续可按同步批次调整

主分析范围：

- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/provider/transform.ts`
- `packages/opencode/src/provider/models.ts`
- `packages/opencode/src/provider/schema.ts`
- `packages/opencode/src/provider/sdk/copilot/**`
- `packages/opencode/src/auth/**`
- `packages/opencode/src/config/**` 中影响 provider/model/auth 加载的部分
- `packages/opencode/test/session/llm.test.ts`
- `packages/opencode/test/provider/**`
- `packages/opencode/test/system/llm-p0.ts`
- `packages/opencode/package.json`
- `bun.lock` 或 package lock 中 AI SDK/provider SDK 相关依赖

排除或默认降级的范围：

- TUI、Desktop、Web UI、安装发布、server route 纯迁移，除非直接影响 LLM 请求、provider auth 或 session tool loop。
- Effect service 化、HttpApi 化、模块拆分和命名重构，除非其中承载了可单独提取的 LLM 行为修复。
- 上游 open PR 或 issue 里的未合并补丁，除非我们能在本仓库复现同类问题并补测试。

## 分析流程

### 1. 固定基线

先确认两个仓库的状态，避免 diff 基线漂移：

```bash
# 当前仓库
git status --short
git branch --show-current
git rev-parse --short HEAD

# 上游 clone
(cd "$UPSTREAM" && git status --short && git branch --show-current && git rev-parse --short HEAD && git remote -v)
```

如果上游 clone 不是 `dev`，先切回 `dev` 并更新。当前仓库可能处在功能分支上，分析报告必须记录当前 HEAD，不能假设本地存在 `main`。

### 2. 先做方案 2：代码 diff 主线

先看关键目录的 diff 规模，判断噪音来源：

```bash
git diff --no-index --stat -- packages/opencode/src/session "$UPSTREAM/packages/opencode/src/session"
git diff --no-index --stat -- packages/opencode/src/provider "$UPSTREAM/packages/opencode/src/provider"
git diff --no-index --stat -- packages/opencode/src/config "$UPSTREAM/packages/opencode/src/config"
```

再逐个看高价值文件的行为 diff：

```bash
diff -u packages/opencode/src/session/llm.ts "$UPSTREAM/packages/opencode/src/session/llm.ts"
diff -u packages/opencode/src/provider/provider.ts "$UPSTREAM/packages/opencode/src/provider/provider.ts"
diff -u packages/opencode/src/provider/transform.ts "$UPSTREAM/packages/opencode/src/provider/transform.ts"
diff -u packages/opencode/src/provider/models.ts "$UPSTREAM/packages/opencode/src/provider/models.ts"
```

阅读 diff 时按行为分组，不按文件机械拆分：

- SDK 实例创建：bundled provider、dynamic npm install、本地 `file://` provider、custom loader、baseURL、auth、fetch wrapper。
- 请求 options：providerOptions namespace、reasoning/thinking、temperature/topP/topK、max token、store、prompt cache、tool streaming。
- 消息转换：empty content、tool call/tool result 顺序、toolCallId 清洗、reasoning part 回灌、unsupported modality。
- 流处理：`streamText()` 参数、fullStream 消费、retry、abort、usage、finish reason、telemetry。
- 模型元数据：`models.dev` schema、custom model merge、variant、capability、limit。
- 测试变化：本地 fake endpoint 契约测试、真实 provider smoke、provider schema/loader 测试。

每个行为差异先记录成候选项，不急着决定是否移植。

### 3. 再做方案 1：commit/PR 校验

对每个候选行为差异，回查上游 2026-03-26 之后的相关 commit，确认它是不是 bugfix、依赖升级副作用、还是架构迁移的一部分。

基础 commit 扫描：

```bash
(cd "$UPSTREAM" && git log --since='2026-03-26' --date=short --pretty=format:'%h %ad %s' -- \
  packages/opencode/src/session \
  packages/opencode/src/provider \
  packages/opencode/src/config \
  packages/opencode/src/auth \
  packages/opencode/test/session \
  packages/opencode/test/provider \
  packages/opencode/test/system \
  packages/opencode/package.json \
  bun.lock)
```

高价值关键词扫描：

```bash
(cd "$UPSTREAM" && git log --since='2026-03-26' \
  --grep='fix\|bug\|reasoning\|deepseek\|azure\|bedrock\|openrouter\|tool\|provider\|llm\|ai sdk\|usage\|stream' \
  --regexp-ignore-case \
  --date=short \
  --pretty=format:'%h %ad %s' -- \
  packages/opencode/src/session \
  packages/opencode/src/provider \
  packages/opencode/src/config \
  packages/opencode/package.json \
  bun.lock)
```

对命中的 commit 用 `git show --stat` 和 `git show -- <path>` 看具体改动，并记录：

- commit hash 和 PR 编号
- 标题是否表明 bugfix 或 provider 兼容
- 是否伴随测试
- 是否依赖上游 Effect/HttpApi 架构
- 是否能手工提取行为到当前结构
- 是否与现有本地适配冲突

## 分类与优先级

候选项统一按以下优先级分类。

### P0 必须评估

这类差异可能导致真实调用失败、调用链中断或统计错误，应优先进入回迁候选：

- provider 真实 API 报错修复，例如 Azure、Bedrock、OpenRouter、xAI、Anthropic、OpenAI-compatible。
- reasoning/thinking 字段修复，例如 DeepSeek、Kimi、GLM、Mistral、Bedrock、Copilot GPT-5。
- tool call/tool result 顺序修复，例如 Anthropic `tool_use` 必须紧跟 `tool_result`、OpenAI-compatible 工具循环不继续。
- usage/token 统计修复，例如 reasoning tokens double count、Anthropic/Bedrock usage 形态变化。
- AI SDK/provider SDK bump 中明确修复真实 provider 兼容问题的变更。
- retry、abort、SSE chunk timeout、5xx retry、context overflow 等影响流完整性的修复。

### P1 建议评估

这类差异通常是能力增强或兼容改进，适合在 P0 之后评估：

- 新 provider 支持，例如新增 bundled SDK 或 custom loader。
- providerOptions namespace 或 key 映射增强。
- 新模型 reasoning variant、effort、`max`、`xhigh`、fast mode。
- 模型元数据 merge、custom provider 配置、plugin model resolution。
- 官方 provider onboarding、错误信息、可观测性改进。

### P2 暂缓

这类差异默认不进入本轮回迁，除非其中包含可单独抽取的 P0/P1 行为：

- Effect service 化、Layer 化、facade 移除。
- HttpApi route 迁移。
- 模块 barrel 删除、命名扁平化、schema 框架迁移。
- TUI/Desktop/server route 非 LLM 行为。
- 大面积工具系统重构。

### Local 必须保留

以下属于本仓库的本地兼容层，回迁上游改动时不能覆盖：

- OpenAI-compatible 的 `includeUsage` 和 `max_tokens` 到 `max_completion_tokens` 转换。
- assistant reasoning part 到 `providerOptions.openaiCompatible.reasoning_content` / `reasoning_details` 的回灌。
- DashScope/Alibaba CN reasoning 模型的 `enable_thinking`。
- ZAI/Zhipu 的 `thinking.type = "enabled"` 与 `clear_thinking: false`。
- Kimi、Qwen、Minimax、GLM 等国产模型采样参数默认值。
- 不兼容通用 reasoning variant 的模型禁用逻辑。
- LiteLLM proxy 历史 tool call 触发 `_noop` 工具。
- HTTP proxy、SSE chunk timeout、自定义 baseURL、国内网关连接语义。
- 当前真实 provider smoke 覆盖的 YAML/provider/case 约定。

## 回迁决策规则

每个候选项只允许落入一个建议动作：

| 动作 | 含义 |
|------|------|
| 移植 | 行为明确、风险低、可直接适配当前结构 |
| 手工改写 | 上游实现依赖新架构，但行为值得保留，需要用当前结构重写 |
| 已覆盖 | 当前本仓库已有等价或更适合本地 provider 的实现 |
| 暂缓 | 价值存在，但依赖太大或没有当前需求 |
| 放弃 | 与本仓库本地策略冲突，或只服务上游特定架构 |

判断顺序：

1. 先确认是否会修复当前真实 provider 或本地契约测试可覆盖的问题。
2. 再确认是否会覆盖 Local 必须保留行为。
3. 如果是 SDK bump，确认 peer dependency 和 lockfile 是否需要成组升级。
4. 如果是 provider 新增，确认本仓库是否维护该 provider，或是否只是上游生态列表扩张。
5. 如果是架构重构，只提取行为，不搬迁框架。

## 分析产物模板

每轮分析输出一份独立结果文档，建议命名为：

```text
docs/llm-upstream-diff-report-YYYY-MM-DD.md
```

结果文档至少包含以下表格：

| 字段 | 说明 |
|------|------|
| 编号 | 稳定编号，例如 `LLM-UP-001` |
| 优先级 | `P0` / `P1` / `P2` / `Local` |
| 上游 commit/PR | hash 和 PR 编号，没有则写 diff-only |
| 变更主题 | 简短描述行为 |
| 影响文件 | 关键文件，不列无关重构 |
| 影响 provider/model | 例如 Azure、Bedrock、DeepSeek、OpenAI-compatible |
| 当前本仓库状态 | 缺失、已有、部分已有、冲突 |
| 建议动作 | 移植、手工改写、已覆盖、暂缓、放弃 |
| 风险 | 兼容性、依赖、测试缺口 |
| 测试要求 | 需要新增/更新的本地测试或真实 smoke |
| 验收命令 | 具体命令 |

示例：

| 编号 | 优先级 | 上游 commit/PR | 变更主题 | 影响 provider/model | 当前本仓库状态 | 建议动作 | 测试要求 |
|------|--------|----------------|----------|---------------------|------------------|----------|----------|
| LLM-UP-001 | P0 | `a12333310` / `#25145` | providerOptions key 支持 dot split | openai-compatible/openai/anthropic | 待确认 | 手工改写 | `test/session/llm.test.ts` 增加 namespace 断言 |
| LLM-UP-002 | P0 | `29ec07700` / `#25303` | Bedrock reasoning 修复 | Bedrock | 待确认 | 移植或暂缓 | Bedrock provider 契约测试 + 真实 smoke |

## 回迁实施原则

回迁应按小批次执行，每个 PR 只处理一组强相关行为：

- 不整块覆盖 `llm.ts`、`provider.ts`、`transform.ts`。
- 不把上游 Effect service 化、HttpApi 化作为 LLM bugfix 的前置条件。
- 能用当前结构表达的 bugfix，优先手工移植。
- 涉及依赖升级时，AI SDK core、provider SDK 和 lockfile 必须作为一组评估。
- 每个行为改动必须绑定测试；没有测试入口时，先补本地契约测试或在报告中明确只能靠真实 smoke 验证。
- 回迁后需要更新本报告或对应回迁结果文档，标记该项已处理。

## 测试与验收

常规本地验收从 package 目录运行，不能从 repo root 运行：

```bash
cd packages/opencode
bun typecheck
bun test test/provider/provider.test.ts
bun test test/provider/transform.test.ts
bun test test/session/llm.test.ts
```

涉及 session loop、compaction 或工具结果回灌时，额外运行：

```bash
cd packages/opencode
bun test test/session/compaction-flow.test.ts
```

涉及真实 provider 接受度时，按系统测试文档手动运行 smoke：

```bash
cd packages/opencode
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider deepseek
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider alibaba-cn --input p1-reasoning --p1
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider minimax-cn
```

真实 smoke 不是常规 merge blocker，但如果某个回迁项声称修复真实供应商兼容问题，PR 描述必须写明是否已运行 smoke；未运行时必须说明原因。

## 交付顺序

建议分三步推进：

1. **生成差异报告**：按本文流程产出 `docs/llm-upstream-diff-report-YYYY-MM-DD.md`，只分类和排序，不改代码。
2. **回迁 P0 小批次**：优先处理真实调用失败、reasoning、tool call、usage、SDK bugfix。
3. **补齐测试护栏**：每回迁一类行为，同步补本地契约测试；真实 provider 风险用系统 smoke 验证。

只有当 P0 项清理完，才评估 P1 新 provider/新模型能力。P2 架构重构默认不做，除非后续决定跟随上游整体 LLM 架构演进。
