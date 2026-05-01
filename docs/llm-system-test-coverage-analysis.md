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

## 2. Provider SDK 路径覆盖

测试 YAML 现已匹配 models.dev 真实定义，覆盖两条 SDK 路径：

| SDK 路径 | Provider | npm 包 | 触发的 ProviderTransform |
|----------|----------|--------|--------------------------|
| **OpenAI-compatible** | alibaba-cn, deepseek, moonshotai-cn, zai, xiaomi, siliconflow-cn, volcengine, qianfan | `@ai-sdk/openai-compatible` | enable_thinking (alibaba-cn), thinking.type (zai), interleaved reasoning_content, temperature/topP/topK defaults, max_completion_tokens 转换 |
| **Anthropic** | minimax-cn | `@ai-sdk/anthropic` | 空消息过滤, cache control, Anthropic variant 生成, minimax temperature/topP/topK defaults |

**minimax-cn 使用 `@ai-sdk/anthropic` 是最关键的覆盖新增**：当用户通过 models.dev 连接 minimax-cn 时，系统使用 Anthropic SDK 形态（`createAnthropic` → `sdk.languageModel()`），触发 Anthropic 特有的 ProviderTransform 适配逻辑。之前这一路径完全没有真实调用验证。

## 3. 新增测试用例覆盖

### 3.1 p1-reasoning — reasoning 输出验证

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

### 3.2 p0-history-tool — 含工具调用结果的历史回放

所有 `tool: true` 的模型都会跑此用例。history 包含 AI SDK v5 格式的 `ToolCallPart`（`input` 字段）+ `ToolResultPart`（`output` 字段）。

| 触发的适配点 | 验证方式 |
|-------------|---------|
| normalizeMessages 处理 tool-call/tool-result | 历史包含 tool 内容，normalizeMessages 需正确处理 |
| Anthropic 空消息过滤 | minimax-cn 模型触发 `model.api.npm === "@ai-sdk/anthropic"` 条件 |
| Anthropic cache control | minimax-cn 模型触发 applyCaching 中的 Anthropic 条件 |
| Anthropic toolCallId scrubbing | minimax-cn 模型的 `model.api.id.includes("minimax-m2.7")` 不含 "claude"，不触发 Claude scrubbing |
| LiteLLM `_noop` 触发条件 | p0-history-tool 不暴露当前 active tools；当本地 provider 显式设置 `litellmProxy: true` 或 provider/model id 命中 litellm 时，`hasToolCalls(messages)` 会触发 `_noop` |

### 3.3 p1-vision — 视觉输入验证

| Provider | 模型 | 触发的适配点 |
|----------|------|-------------|
| xiaomi | mimo-v2.5 | unsupportedParts 保留 ImagePart, openai-compatible image 编码 |

## 4. 仍存在的风险盲区

### 4.1 minimax-cn reasoning 输出 — 待验证

minimax-cn 使用 `@ai-sdk/anthropic` SDK，但 `ProviderTransform.options()` 没有 minimax-cn 相关的 `thinking` config。这意味着：
- 如果 minimax-cn Anthropic 端点**默认输出 reasoning** → `p1-reasoning` 会通过
- 如果 minimax-cn Anthropic 端点**需要显式 thinking config** → `p1-reasoning` 会失败，需要在 `ProviderTransform.options()` 中增加 minimax-cn 条件

这是一个**有意为之的探测性测试**：失败即发现需要补充适配。

### 4.2 Anthropic 官方 SDK — 未覆盖

minimax-cn 虽然使用 Anthropic SDK 形态，但不触发 `CUSTOM_LOADERS["anthropic"]`（因为 provider ID 是 "minimax-cn" 不是 "anthropic"）。Anthropic 官方 provider 的 `anthropic-beta` header 注入仍未被真实调用验证。

### 4.3 SessionProcessor 工具调用循环 — 未覆盖

p1-tool 只验证 tool_call 事件形态，不回灌结果也不测第二轮 LLM 循环。

### 4.4 applyCaching 实际效果 — 间接覆盖

minimax-cn 触发 Anthropic cache control 标记注入，但测试只验证 stream 完成，不验证 cache 标记是否被 minimax-cn 端点接受或生效。

## 5. Provider × 用例 覆盖矩阵

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
