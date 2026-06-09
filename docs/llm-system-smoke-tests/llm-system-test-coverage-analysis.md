# LLM 系统测试覆盖分析

## 1. 已覆盖的链路

| 调用链节点 | 覆盖情况 |
|-----------|---------|
| Config 加载 → Provider 创建 → getModel | 通过 `Instance.provide()` + `Config.get()` + `Provider.getModel()` 走通，覆盖 R-1 |
| LLM.stream() 统一入口 | 直接调用 `LLM.stream()`，覆盖 R-2/R-3 的基础形态 |
| streamText() → 流式消费 → finish-step | 消费 `fullStream`，验证 text-delta / reasoning-delta / finish-step / error 事件，覆盖 P0-A/B |
| system prompt 组装 | `p0-system` 用例验证 system 字段被发送 |
| 多轮 history 拼接 | `p0-history` 用例验证 user/assistant 文本历史拼接不报错 |
| tool-call 事件形态 | `p1-tool` 验证模型产生 tool_call 事件（仅单轮，不回灌） |
| usage 缺失显式化 | finish-step 中检查 usage，缺失标记为 missing/unsupported，覆盖 P0-D |
| 错误分类与上下文标注 | `classify()` 分 5 类，错误记录带 provider/model/case 前缀，覆盖 R-4 |

补充说明：本表描述的是 `packages/opencode/test/system/llm-p0.test.ts` 的真实 provider smoke 覆盖。它直接调用 `LLM.stream()`，不进入 `SessionPrompt` / `SessionProcessor` 的完整会话循环，因此不会在真实 endpoint 上做长上下文压测或自动压缩验证。context length 与压缩编排由 `packages/opencode/test/session/compaction-flow.test.ts` 使用本地 OpenAI-compatible fake endpoint 覆盖，避免真实长上下文成本和 flaky。

## 2. 与本地 LLM 契约测试的分工

`packages/opencode/test/session/llm.test.ts` 和本系统 smoke 的入口都包含 `LLM.stream()`，但覆盖目的不同。这个重叠是刻意保留的：`session/llm.test.ts` 用本地 fake endpoint 精确检查 opencode 会发出什么请求；`system/llm-p0.test.ts` 用真实 endpoint 检查供应商是否真的接受这组请求并返回完整流。

| 维度 | `test/session/llm.test.ts` | `test/system/llm-p0.test.ts` |
|------|----------------------------|------------------------------|
| endpoint | 本地 fake server | 真实 provider endpoint |
| 运行成本 | 无真实额度消耗，可作为常规测试 | 消耗真实额度，默认手动启用 |
| 稳定性 | 高，可确定复现 | 受网络、鉴权、限流、供应商变更影响 |
| 主要验证 | 请求 path / headers / body、ProviderTransform 输出、不同 SDK 请求形态、工具权限过滤、`hasToolCalls()` | 真实配置加载、真实鉴权、真实模型 id、真实流式返回、finish-step、usage、reasoning / tool-call 事件、失败分类 |
| 不能证明 | 真实 provider 当前是否接受请求，模型是否存在，真实流事件是否兼容 | 每个 payload 字段是否精确符合内部预期，所有 provider transform 分支是否被局部断言 |

因此，真实 LLM smoke test 的必要性在于补上本地契约测试无法覆盖的外部兼容性风险：供应商 API 形态漂移、模型下线或重命名、OpenAI-compatible 方言差异、SDK 升级后真实流事件变化、usage / reasoning / tool-call 字段与模拟不一致。维护时不应因为二者都调用 `LLM.stream()` 就合并或删除其中一个；正确边界是让本地契约测试守住请求构造，让系统 smoke 守住真实 provider 可用性。

这条边界也反向约束系统 smoke 的设计：它只做最小可用性验证和诊断记录，不承担 payload 字段级快照测试，不进入模型质量评测，也不替代 `SessionPrompt` / `SessionProcessor` 的完整会话编排测试。

## 3. Provider SDK 路径覆盖

测试 YAML 现已匹配 models.dev 真实定义，覆盖两条 SDK 路径：

| SDK 路径 | Provider | npm 包 | 触发的 ProviderTransform |
|----------|----------|--------|--------------------------|
| **OpenAI-compatible** | alibaba-cn, deepseek, moonshotai-cn, zai, xiaomi, siliconflow-cn, volcengine, qianfan | `@ai-sdk/openai-compatible` | enable_thinking (alibaba-cn), thinking.type (zai), interleaved reasoning_content, temperature/topP/topK defaults, max_completion_tokens 转换 |
| **Anthropic** | minimax-cn | `@ai-sdk/anthropic` | 空消息过滤, cache control, Anthropic variant 生成, minimax temperature/topP/topK defaults |

**minimax-cn 使用 `@ai-sdk/anthropic` 是最关键的覆盖新增**：当用户通过 models.dev 连接 minimax-cn 时，系统使用 Anthropic SDK 形态（`createAnthropic` → `sdk.languageModel()`），触发 Anthropic 特有的 ProviderTransform 适配逻辑。之前这一路径完全没有真实调用验证。

## 4. 新增测试用例覆盖

### 4.1 p1-reasoning — reasoning 输出验证

| Provider | 模型 | 触发的适配点 |
|----------|------|-------------|
| alibaba-cn | qwen3.6-plus/flash/max-preview | `enable_thinking: true` + interleaved reasoning_content |
| deepseek | deepseek-v4-flash, deepseek-v4-pro | interleaved reasoning_content |
| moonshotai-cn | kimi-k2.6 | interleaved reasoning_content |
| zai | glm-5.1 | `thinking.type = "enabled"` + `clear_thinking: false` + interleaved reasoning_content |
| xiaomi | mimo-v2.5 | interleaved reasoning_content |
| minimax-cn | MiniMax-M2.7 | Anthropic SDK reasoning 路径（是否需要 thinking config 待验证） |
| siliconflow-cn | deepseek-ai/DeepSeek-V4-Flash | `enable_thinking: true` + interleaved reasoning_content |
| volcengine | doubao-seed-2-0-lite-260215 | interleaved reasoning_content |

断言：`reasoning > 0`。如果适配参数缺失，reasoning 模型只返回文本不返回 reasoning，断言会捕获。

### 4.2 p0-history-tool — 含工具调用结果的历史回放

所有 `tool: true` 的模型都会跑此用例。history 包含 AI SDK v5 格式的 `ToolCallPart`（`input` 字段）+ `ToolResultPart`（`output` 字段）。

| 触发的适配点 | 验证方式 |
|-------------|---------|
| normalizeMessages 处理 tool-call/tool-result | 历史包含 tool 内容，normalizeMessages 需正确处理 |
| Anthropic 空消息过滤 | minimax-cn 模型触发 `model.api.npm === "@ai-sdk/anthropic"` 条件 |
| Anthropic cache control | minimax-cn 模型触发 applyCaching 中的 Anthropic 条件 |
| Anthropic toolCallId scrubbing | minimax-cn 模型的 `model.api.id.includes("minimax-m2.7")` 不含 "claude"，不触发 Claude scrubbing |
| LiteLLM `_noop` 触发条件 | p0-history-tool 不暴露当前 active tools；当本地 provider 显式设置 `litellmProxy: true` 或 provider/model id 命中 litellm 时，`hasToolCalls(messages)` 会触发 `_noop` |

### 4.3 p1-vision — 视觉输入验证

| Provider | 模型 | 触发的适配点 |
|----------|------|-------------|
| xiaomi | mimo-v2.5 | unsupportedParts 保留 ImagePart, openai-compatible image 编码 |

### 4.4 session/compaction-flow — context length 与压缩编排

`packages/opencode/test/session/compaction-flow.test.ts` 不访问真实 provider，而是启动本地 OpenAI-compatible SSE stub，经由 `SessionPrompt.prompt()` 进入完整 session loop。它补足系统 smoke 没覆盖的会话编排层：

| 覆盖点 | 验证方式 |
|--------|----------|
| usage 触发自动压缩 | fake endpoint 返回超过模型 `limit.context` 可用预算的 usage，验证创建 `compaction` part、执行 compaction agent、写入 `summary: true` assistant，并继续生成最终 assistant |
| 禁用自动压缩 | `compaction.auto = false` 时，即使 usage 超阈值也不创建 compaction part |
| 手动压缩 | `SessionCompaction.create({ auto: false })` 后只写 summary，不创建 synthetic continuation / replay turn |
| provider context overflow | fake endpoint 返回 `context_length_exceeded`，验证创建 `overflow: true` compaction task |
| overflow replay 与媒体剥离 | 压缩后重放导致 overflow 的用户 turn，并把 image file 转为 `[Attached image/png: ...]` 文本占位 |
| compaction 自身溢出防循环 | compaction 请求也 overflow 时，summary assistant 写入 `ContextOverflowError`、`finish = "error"`，且不继续创建新的 compaction task |
| 压缩后上下文裁剪 | 后续 turn 的模型输入包含 compaction summary 和新 prompt，不再包含被压缩前的旧 user prompt |
| 工具调用第二轮 loop | fake endpoint 先返回 `todowrite` tool_call，验证工具执行完成、tool result 进入第二轮 LLM 输入、最终 assistant 正常结束 |

这组测试依赖模型元数据里的 `limit.context` / `limit.output`。正式运行时这些字段来自 `models.dev` 数据：优先读取 `OPENCODE_MODELS_PATH` 或 `$XDG_CACHE_HOME/aether/models.json`，没有缓存时回退到构建期注入的 `OPENCODE_MODELS_DEV`，再按需远程拉取；也可被项目配置里的 `provider.<id>.models.<model>.limit` 覆盖。

## 5. 仍存在的风险盲区

### 5.1 minimax-cn reasoning 输出 — 待验证

minimax-cn 使用 `@ai-sdk/anthropic` SDK，但 `ProviderTransform.options()` 没有 minimax-cn 相关的 `thinking` config。这意味着：
- 如果 minimax-cn Anthropic 端点**默认输出 reasoning** → `p1-reasoning` 会通过
- 如果 minimax-cn Anthropic 端点**需要显式 thinking config** → `p1-reasoning` 会失败，需要在 `ProviderTransform.options()` 中增加 minimax-cn 条件

这是一个**有意为之的探测性测试**：失败即发现需要补充适配。

### 5.2 Anthropic 官方 SDK — 未覆盖

minimax-cn 虽然使用 Anthropic SDK 形态，但不触发 `CUSTOM_LOADERS["anthropic"]`（因为 provider ID 是 "minimax-cn" 不是 "anthropic"）。Anthropic 官方 provider 的 `anthropic-beta` header 注入仍未被真实调用验证。

### 5.3 真实 provider 的第二轮工具循环 — 未覆盖

`p1-tool` 只验证真实 provider 能产生 tool_call 事件形态，不回灌结果也不测第二轮真实 LLM 调用。第二轮工具循环已由 `test/session/compaction-flow.test.ts` 通过本地 fake endpoint 覆盖 session 编排，但仍没有对真实 provider 执行“tool_call → tool_result → 第二轮真实流式回复”的 smoke。

### 5.4 applyCaching 实际效果 — 间接覆盖

minimax-cn 触发 Anthropic cache control 标记注入，但测试只验证 stream 完成，不验证 cache 标记是否被 minimax-cn 端点接受或生效。

### 5.5 真实长上下文压力 — 未覆盖

现有真实 provider 系统测试仍不做接近 `limit.context` 的长上下文请求，也不验证供应商真实 token 计数与本地 compaction 阈值完全一致。长上下文压测成本高、耗时长、容易受供应商限流和计费影响，建议继续作为单独 P2 手动测试，而不是并入 `test:system:llm:p0`。

## 6. Provider × 用例 覆盖矩阵

| Provider | 模型 | p0-basic | p0-system | p0-history | p0-history-tool | p1-tool | p1-reasoning | p1-vision |
|----------|------|----------|-----------|------------|-----------------|---------|-------------|-----------|
| alibaba-cn | qwen3.6-plus/flash/max-preview | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (enable_thinking) | skip |
| deepseek | deepseek-v4-flash/pro | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (interleaved) | skip |
| moonshotai-cn | kimi-k2.6 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (interleaved) | skip |
| zai | glm-5.1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (thinking.type) | skip |
| xiaomi | mimo-v2.5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (interleaved) | ✓ (vision) |
| minimax-cn | MiniMax-M2.7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (Anthropic SDK) | skip |
| siliconflow-cn | deepseek-ai/DeepSeek-V4-Flash | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (enable_thinking + interleaved) | skip |
| volcengine | doubao-seed-2-0-lite-260215 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (interleaved) | skip |
| volcengine | doubao-seed-2-0-mini-260215 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (reasoning) | skip |
| qianfan | deepseek-v4-flash | ✓ | ✓ | ✓ | ✓ | ✓ | skip | skip |
