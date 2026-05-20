# MaaS Provider 接入需求文档

## 背景

Aether/OpenCode 当前通过内置 provider 列表、用户配置、自定义 provider、API Key 认证和模型元数据共同决定可用模型。用户可以在设置界面连接 provider，在模型选择器中选择模型，并在会话、知识库、语音等功能中使用已连接 provider。

现在希望将 MaaS（`maas.tatucloud.com`）作为一等 provider 接入，体验上类似 OpenRouter：用户只需要配置 MaaS API Key，即可在 Aether 中看到 MaaS 提供的模型列表，并直接选择 MaaS 模型进行对话。

MaaS 模型信息来源为：

`docs/maas/modelcards.json`

该文件来自：

`https://maas.tatucloud.com/api/platform/modelcards?view=management`

文件内记录了模型的上下文长度、能力、价格、协议类型、支持操作、后端部署信息等信息。

## 已确认口径

1. OpenAI 协议模型优先使用 `OPENAI_RESPONSES`；模型不支持 Responses 时，再使用 `OPENAI_CHAT_COMPLETIONS`。
2. 发送给 MaaS 网关的模型名总是模型卡的 `model_name`，不使用 `sent_model_name`。
3. 同一个 `model_name` 下的多个 backend model 表示 MaaS 网关可在多个 deployer 之间做负载均衡；不同 deployer 的价格、能力和协议可能存在细微差异。
4. 首批不做 deep research 模型，即使该模型在模型卡中被标记为 `CHAT`。
5. 首批仍聚焦普通 chat 模型，embedding、reranker、image、video、batch 和工具型计费能力放到后续扩展。

## 目标

1. 将 MaaS 添加为内置 provider，而不是要求用户手动创建自定义 provider。
2. 用户配置 MaaS API Key 后，可以在 provider 设置、模型列表、模型选择器等现有入口中看到 MaaS。
3. 首批优先支持 MaaS 的 chat 模型。
4. MaaS 模型应尽量携带准确的名称、模型 ID、上下文长度、输入输出价格、缓存价格、视觉/工具调用/推理等能力信息。
5. 同一 MaaS provider 下的不同模型可以根据模型卡声明使用不同协议类型，包括 OpenAI、Anthropic、Gemini。
6. 不改变现有用户自定义 provider 的使用方式，也不影响已有 provider 的认证、展示和默认模型选择逻辑。

## 非目标

1. 本需求不要求首批支持 embedding、reranker、image、video 模型。
2. 本需求不定义具体代码实现方式、文件组织、脚本结构或生成器实现。
3. 本需求不要求实现 MaaS 平台侧的模型动态拉取或实时同步。
4. 本需求不要求支持 MaaS 的 batch、deep research、web search、code interpreter 等高级计费工具。
5. 本需求不要求改造 Aether 的通用 provider 架构。

## Provider 信息

新增 provider 的建议用户可见信息：

| 字段 | 要求 |
| --- | --- |
| Provider ID | `maas` |
| Provider 名称 | `MaaS` |
| 认证方式 | API Key |
| 环境变量 | `MAAS_API_KEY` |
| OpenAI Chat/Responses Base URL | `https://maas.tatucloud.com/v1` |
| Anthropic Base URL | `https://maas.tatucloud.com/v1` |
| Gemini Base URL | `https://maas.tatucloud.com/v1beta` |

用户应可以通过现有 provider 连接流程保存 MaaS API Key。连接后，MaaS 应被视为 connected provider，并出现在可用 provider 与模型选择入口中。

## 首批模型范围

首批范围为 `docs/maas/modelcards.json` 中 `model_type = "CHAT"` 的模型。

当前模型卡统计：

| 类型 | 数量 |
| --- | ---: |
| CHAT | 31 |
| EMBEDDING | 3 |
| IMAGE | 2 |
| RERANKER | 3 |
| VIDEO | 5 |

首批 chat 模型中，`enabled = true`、`is_available = true` 且 `has_permission = true` 的模型应默认纳入可选列表。当前满足该条件的 chat 模型为 29 个。

首批明确不纳入 deep research 模型和 `deepseek-v3.2`，因此实际默认纳入 27 个普通 chat 模型。

当前不应默认纳入的 chat 模型：

| 模型 | 原因 |
| --- | --- |
| `batch-test-model` | `enabled = false`，且看起来是测试模型 |
| `qwen3-max` | `enabled = false` |
| `deepseek-v3.2` | 当前 MaaS 调用返回 service not available，首批暂不纳入 |
| `deep-research-pro-preview-12-2025` | deep research 模型，不属于首批普通 chat 范围 |

如后续 MaaS 模型卡状态发生变化，应以模型卡状态为准。

## Chat 模型清单

首批默认纳入以下模型：

| 模型 | 厂商 | 协议 | Context |
| --- | --- | --- | ---: |
| `qwen3.5-122b-a10b` | ALIBABA | OPENAI | 256000 |
| `qwen3.5-27b` | ALIBABA | OPENAI | 256000 |
| `qwen3.5-35b-a3b` | ALIBABA | OPENAI | 256000 |
| `qwen3.5-397b-a17b` | ALIBABA | OPENAI | 256000 |
| `qwen3.5-flash` | ALIBABA | OPENAI | 1000000 |
| `qwen3.6-plus` | ALIBABA | OPENAI | 1055000 |
| `claude-haiku-4-5` | ANTHROPIC | ANTHROPIC | 200000 |
| `claude-opus-4-6` | ANTHROPIC | ANTHROPIC | 1000000 |
| `claude-opus-4-7` | ANTHROPIC | ANTHROPIC | 1000000 |
| `claude-sonnet-4-6` | ANTHROPIC | ANTHROPIC | 1000000 |
| `deepseek-v4-pro` | DEEPSEEK | ANTHROPIC / OPENAI | 1000000 |
| `gemini-3.1-flash-lite-preview` | GOOGLE | GEMINI | 1048576 |
| `gemini-3.1-pro-preview` | GOOGLE | GEMINI | 1048576 |
| `kimi-k2.5` | KIMI | OPENAI | 224000 |
| `kimi-k2.6` | KIMI | ANTHROPIC / OPENAI | 224000 |
| `minimax-m2.5` | MINIMAX | OPENAI | 204800 |
| `minimax-m2.7` | MINIMAX | OPENAI | 204800 |
| `gpt-5.4` | OPENAI | OPENAI | 1050000 |
| `gpt-5.4-mini` | OPENAI | OPENAI | 400000 |
| `gpt-5.4-nano` | OPENAI | OPENAI | 400000 |
| `gpt-5.4-pro` | OPENAI | OPENAI | 1050000 |
| `gpt-5.5` | OPENAI | OPENAI | 1050000 |
| `mimo-v2.5-pro` | XIAOMI | ANTHROPIC / OPENAI | 1000000 |
| `glm-5` | ZAI | OPENAI | 200000 |
| `mimo-v2.5` | XIAOMI | ANTHROPIC / OPENAI | 1000000 |
| `glm-5.1` | ZAI | ANTHROPIC / OPENAI | 202000 |
| `mimo-v2-flash` | XIAOMI | ANTHROPIC / OPENAI | 256000 |

## 协议与操作要求

MaaS chat 模型卡中出现的协议类型：

| 协议 | 出现次数 |
| --- | ---: |
| OPENAI | 24 |
| ANTHROPIC | 10 |
| GEMINI | 3 |

MaaS chat 模型卡中出现的操作类型：

| 操作 | 出现次数 |
| --- | ---: |
| `OPENAI_CHAT_COMPLETIONS` | 24 |
| `OPENAI_COMPLETIONS` | 24 |
| `OPENAI_RESPONSES` | 15 |
| `OPENAI_BATCH` | 7 |
| `ANTHROPIC_MESSAGES` | 10 |
| `GEMINI_GENERATE_CONTENT` | 2 |
| `GEMINI_STREAM_GENERATE_CONTENT` | 2 |
| `GEMINI_DEEP_RESEARCH_INTERACTIONS` | 1 |

首批对话能力要求：

1. OpenAI 协议模型应优先使用 `OPENAI_RESPONSES`；不支持 `OPENAI_RESPONSES` 时，再使用 `OPENAI_CHAT_COMPLETIONS`。
2. 没有声明 `OPENAI_RESPONSES` 的模型不应被错误标记为支持 Responses。
3. Anthropic 协议模型应支持 messages 对话。
4. Gemini 协议模型应支持 generate content / stream generate content 对话。
5. 同时提供多个协议的模型，应有明确的默认协议选择规则；同一模型存在 OpenAI 协议时，优先按 OpenAI 协议的 `RESPONSES` → `CHAT_COMPLETIONS` 顺序选择。
6. Batch、deep research interaction 等非普通 chat 操作不属于首批验收范围，但其存在不应导致模型无法用于普通对话。

当前 `deepseek-v4-pro` 例外，应使用不包含 `OPENAI_RESPONSES` 的 OpenAI Chat Completions 配置。

## 模型元数据要求

每个纳入 MaaS 的 chat 模型至少应具备以下元数据：

| 元数据 | 来源与要求 |
| --- | --- |
| 模型 ID | 使用 MaaS 对外展示的 `model_name` |
| 请求模型名 | 发送给 MaaS 网关的模型名总是 `model_name`，不使用 `sent_model_name` |
| 展示名称 | 使用 `model_name` |
| 厂商/系列 | 可从 `provider`、`model_name` 或模型卡描述中归类 |
| Context limit | 使用模型卡 `context_length` |
| Output limit | 若模型卡未提供独立输出上限，应有保守默认值，避免展示为无意义的 0 |
| 输入模态 | 默认 text；包含 `IS_VISION` 时应标记支持 image input |
| 输出模态 | 首批默认为 text |
| Tool call | 包含 `FUNCTION_CALL` 时标记支持工具调用 |
| Reasoning | 模型名称或能力字段表明推理模型时标记；无法判断时不应强行标记 |
| Temperature | 对支持常规采样参数的 chat 模型可标记为支持；不确定时保持保守 |
| Pricing | 使用协议配置中的 tiered pricing，至少映射 input/output/cache read/cache write |
| Currency | 使用模型卡 `currency` 字段；CNY 价格在进入现有 USD `cost` 字段前按固定参考汇率 `USD/CNY = 7` 换算 |

## 价格要求

MaaS 模型卡中的价格位于 `backend_model_list[].protocol_configs[].pricing`。同一个 `model_name` 可能包含多个 backend model，表示 MaaS 网关可在多个 deployer 之间做负载均衡；不同 deployer 的价格、能力和协议可能存在细微差异。

首批需要满足：

1. 展示和统计中的 input/output 单价不应为空或全部为 0，除非模型卡确实如此。
2. 有缓存价格时，应保留 cache read/cache write 信息。
3. 有分段价格时，应至少保留基础价格；若产品现有费用模型支持长上下文分段价格，应表达对应阈值。
4. 不需要首批支持 `tool_call_pricing` 的独立计费。
5. 不需要首批支持教育折扣、有效折扣、用户 RPM 或模型总 RPM。
6. 模型卡 `currency = "USD"` 的价格原样进入现有 `cost` 字段；`currency = "CNY"` 的价格按固定参考汇率 `USD/CNY = 7` 换算为 USD 后进入 `cost` 字段。
7. 同一 `model_name` 存在多个 backend model 时，默认协议选择优先级为 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages、Gemini Generate Content；选中协议集合内能力取并集，基础价格取最大值。

## 用户体验要求

### Provider 设置

1. MaaS 应出现在 provider 列表中。
2. 用户可以为 MaaS 输入并保存 API Key。
3. API Key 保存后，MaaS 应显示为已连接。
4. 已连接的 MaaS 可以被禁用、重新启用或移除认证信息。

### 模型选择

1. 连接 MaaS 后，用户可以在模型选择器中看到 MaaS provider。
2. MaaS 下应列出首批 chat 模型。
3. 模型名称、上下文长度、工具调用、视觉输入等能力展示应与现有模型卡 UI 语义一致。
4. 被禁用或不可用的 MaaS 模型不应默认出现在可选列表中。
5. 当配置了 `disabled_providers`、`enabled_providers` 或 `disabled_models` 时，MaaS 应遵循现有过滤规则。

### 对话

1. 用户选择 MaaS chat 模型后，可以正常发送文本消息并收到流式回复。
2. 支持视觉输入的 MaaS 模型可以在现有附件能力允许的路径中接收图片输入。
3. 支持工具调用的 MaaS 模型可以参与现有工具调用流程。
4. 请求失败时，错误信息应能指向 MaaS provider 与具体模型，便于用户排查 API Key、余额、权限或模型不可用问题。

## 验收标准

1. Provider 列表中存在 MaaS，Provider ID 为 `maas`，名称为 `MaaS`。
2. 用户使用 `MAAS_API_KEY` 或设置界面保存 API Key 后，MaaS 被识别为 connected provider。
3. MaaS connected 后，模型选择器中至少出现 27 个默认可用普通 chat 模型。
4. `batch-test-model`、`qwen3-max`、`deepseek-v3.2` 与 `deep-research-pro-preview-12-2025` 当前不默认出现。
5. OpenAI 协议模型、Anthropic 协议模型、Gemini 协议模型各至少有一个模型可以完成一次普通文本对话。
6. 支持 `IS_VISION` 的模型在元数据中体现图片输入能力。
7. 支持 `FUNCTION_CALL` 的模型在元数据中体现工具调用能力。
8. 至少抽查 5 个模型，其 context limit 与 `docs/maas/modelcards.json` 一致。
9. 至少抽查 5 个模型，其 input/output/cache 单价与模型卡基础价格一致；CNY 模型按固定参考汇率换算后校验。
10. 禁用 MaaS provider 后，MaaS 不再出现在可选 connected provider 中。
11. 禁用单个 MaaS 模型后，该模型在模型选择器中不可选。
12. 不影响 OpenAI、Anthropic、Google、OpenRouter 等已有 provider 的连接与对话。

## 风险与待确认

1. CNY 价格按固定参考汇率 `USD/CNY = 7` 换算为 USD；该值只适合费用估算，后续若要更准确可在生成脚本或独立刷新流程中更新汇率。
2. 同一 `model_name` 下多个 backend model 用于 MaaS 网关负载均衡；首批能力按选中默认协议集合取并集、价格取最大值，仍需关注实际 backend 路由与展示能力不完全一致的边缘情况。
3. 模型卡目前没有明确 output limit；首批使用保守默认值，未来模型卡新增 output limit 参数后应优先使用模型卡字段。
4. MaaS 进入常用 provider；正式品牌图标后续提供，首批可以使用占位符图标。

## 后续扩展

1. 支持 MaaS embedding 模型，用于知识库/RAG。
2. 支持 MaaS reranker 模型。
3. 支持 MaaS image/video 模型。
4. 支持 MaaS batch 操作。
5. 支持 MaaS web search、code interpreter 等工具型计费项展示。
6. 支持从 MaaS 平台自动刷新模型卡，降低手动维护成本。
