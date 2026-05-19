# MaaS Provider 接入实施方案

## 结论

MaaS 作为一等 provider 接入当前架构是可行的，建议采用“静态模型卡生成 models.dev 兼容 provider 元数据 + 少量 provider loader 适配”的方案。

当前 Aether/OpenCode 的 LLM provider 链路已经具备以下能力：

- provider 与模型元数据来自 `ModelsDev.get()`，本地缓存和构建快照均可承载新增 provider。
- `ModelsDev.Model` 已能表达模型 ID、展示名称、context/output limit、价格、模态、工具调用、推理、temperature、headers、options、per-model provider override。
- `Provider.fromModelsDevProvider()` 会把 models.dev 结构转换为运行时 `Provider.Info`。
- `Provider.getSDK()` 会按每个模型的 `api.npm` 和 `api.url` 实例化 Vercel AI SDK provider。
- API Key 认证、环境变量认证、`disabled_providers`、`enabled_providers`、`disabled_models`、provider 设置页和模型选择器都已经围绕 provider ID 通用化。

主要需要补齐的是：MaaS 模型卡到 `ModelsDev.Provider` 的确定性转换、OpenAI Responses/Chat 的模型级选择规则、一个 provider 下多协议模型的 loader 规则，以及 CNY 价格按固定参考汇率换算为现有 USD `cost` 语义。

## 当前项目现状

### 后端 provider 链路

核心文件：

- `packages/opencode/src/provider/models.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/provider/transform.ts`
- `packages/opencode/src/server/routes/provider.ts`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/auth/index.ts`

模型数据加载顺序：

1. `OPENCODE_MODELS_PATH` 指定的本地 JSON。
2. `~/.cache/opencode/models.json`。
3. `packages/opencode/src/provider/models-snapshot.js`。
4. 远程 `https://models.dev/api.json`。

运行时 provider 初始化由 `Provider.state()` 完成。它会把 models.dev provider、用户 config provider、环境变量、保存的 API Key、自定义 loader 和插件 auth loader 合并为最终 provider 列表。

### 前端入口

核心文件：

- `packages/app/src/hooks/use-providers.ts`
- `packages/app/src/components/settings-providers.tsx`
- `packages/app/src/components/dialog-select-provider.tsx`
- `packages/app/src/components/dialog-connect-provider.tsx`
- `packages/app/src/components/model-tooltip.tsx`
- `packages/ui/src/components/provider-icon.tsx`

设置页和连接弹窗已经支持任意 provider 的 API Key 保存。若 provider 没有专门 auth method，前端会 fallback 到 API Key 方法。MaaS 若只需要 API Key，原则上不需要新增 OAuth 流程。

`popularProviders` 目前只影响“常用 provider”展示，不影响“查看全部”中的可连接 provider。MaaS 是否加入常用列表属于产品决策。

### 模型卡现状

`docs/maas/modelcards.json` 顶层结构为：

- `models`: 44 个模型卡。
- `providers`: 当前为空数组。

其中 chat 模型 31 个，当前 `enabled = true`、`is_available = true`、`has_permission = true` 的 chat 模型 29 个。按需求首批排除 deep research 和 `deepseek-v3.2` 后，默认纳入 27 个普通 chat 模型。

## 推荐技术方案

### 1. 新增 MaaS 静态 provider 数据生成

新增一个 MaaS 模型卡转换步骤，把 `docs/maas/modelcards.json` 转成 models.dev 兼容的 provider：

```ts
{
  id: "maas",
  name: "MaaS",
  env: ["MAAS_API_KEY"],
  api: "https://maas.tatucloud.com/v1",
  npm: "@ai-sdk/openai-compatible",
  models: {
    "gpt-5.5": { ...ModelsDev.Model },
    ...
  },
}
```

建议不要手写 27 个模型元数据。模型卡字段较多，协议和价格还可能变化，手写会很快漂移。生成脚本应作为接入的一部分，输出可审查的静态 JSON/TS 产物。

可选落点：

- `packages/opencode/src/provider/maas.ts`：运行时从 `docs/maas/modelcards.json` 生成 provider 并注入 `ModelsDev.get()` 结果。
- `packages/opencode/src/provider/maas-generated.json`：由脚本生成，运行时直接合并。
- 构建时把 MaaS 合并进 `models-snapshot.js`：发布包最稳，但开发期仍建议保留本地生成产物或测试 fixture。

推荐使用生成产物而不是运行时读取 `docs/`，避免发布包缺文件或路径不一致。

### 2. 模型筛选规则

默认纳入模型需同时满足：

- `model_type === "CHAT"`。
- `enabled === true`。
- `is_available === true`。
- `has_permission === true`。
- 不属于 deep research。首批可用 `model_name` 或 supported operation 识别：
  - `model_name` 包含 `deep-research` 时排除。
  - 只有 `GEMINI_DEEP_RESEARCH_INTERACTIONS` 且没有普通 chat/generate content operation 时排除。

当前应排除：

- `batch-test-model`
- `qwen3-max`
- `deepseek-v3.2`
- `deep-research-pro-preview-12-2025`

后续模型卡状态变化时，以模型卡状态重新生成。

### 3. 协议选择规则

MaaS 的特殊点是同一个 provider 下模型可能走 OpenAI、Anthropic 或 Gemini 协议。当前运行时模型结构支持模型级 `provider.npm/api` override，因此不需要改造通用 provider 架构。

建议按模型选择一个默认协议配置：

1. 如果存在 OpenAI 协议且支持 `OPENAI_RESPONSES`，选择 OpenAI Responses。
2. 否则如果存在 OpenAI 协议且支持 `OPENAI_CHAT_COMPLETIONS`，选择 OpenAI Chat Completions。
3. 否则如果存在 Anthropic 协议且支持 `ANTHROPIC_MESSAGES`，选择 Anthropic Messages。
4. 否则如果存在 Gemini 协议且支持 `GEMINI_STREAM_GENERATE_CONTENT` 或 `GEMINI_GENERATE_CONTENT`，选择 Gemini。
5. 其他 operation 首批不纳入普通 chat。

当前 `deepseek-v4-pro` 例外：只选择不包含 `OPENAI_RESPONSES` 的 OpenAI Chat Completions 配置，避免走 MaaS Responses 路由。

映射到 SDK：

| MaaS 协议 | SDK npm | Base URL | 模型获取 |
| --- | --- | --- | --- |
| OpenAI Responses | `@ai-sdk/openai` 或 MaaS 自定义 loader | `https://maas.tatucloud.com/v1` | `sdk.responses(model_name)` |
| OpenAI Chat Completions | `@ai-sdk/openai-compatible` | `https://maas.tatucloud.com/v1` | `sdk.languageModel(model_name)` |
| Anthropic Messages | `@ai-sdk/anthropic` | `https://maas.tatucloud.com/v1` | `sdk.languageModel(model_name)` |
| Gemini Generate Content | `@ai-sdk/google` | `https://maas.tatucloud.com/v1beta` | `sdk.languageModel(model_name)` |

由于 provider ID 统一为 `maas`，不能只依赖已有 `openai` custom loader。建议在 `Provider.CUSTOM_LOADERS` 中为 `maas` 增加小型 loader：

- `autoload: false`，避免无 API Key 时自动连接。
- 对 OpenAI Responses 模型，按模型 options 或 headers 中的标记调用 `sdk.responses(modelID)`。
- 对 OpenAI Chat、Anthropic、Gemini 模型，按模型 `api.npm` 走默认 `languageModel` 即可。

如果 `@ai-sdk/openai` 的 `baseURL` 能稳定指向 MaaS `/v1` 并使用 Responses API，OpenAI Responses 模型可直接使用 `@ai-sdk/openai`。如果存在兼容性差异，则需要新增 MaaS 专用 loader 或复用/抽取现有 OpenAI Responses wrapper。

### 4. 模型 ID 与请求模型名

运行时模型应使用：

- `model.id = model_name`
- `model.api.id = model_name`
- `model.name = model_name`

不使用 `sent_model_name`。这样模型选择、会话持久化、发送请求三处都保持 MaaS 对外模型名一致。

### 5. 元数据映射规则

建议转换规则：

| 运行时字段 | MaaS 来源 | 规则 |
| --- | --- | --- |
| `id` | `model_name` | 原样使用 |
| `name` | `model_name` | 原样使用 |
| `family` | `provider` 或 `model_name` | 使用 MaaS `provider`，必要时归一化为厂商名 |
| `release_date` | 无 | 可填空字符串或模型卡快照日期 |
| `limit.context` | `context_length` | 优先模型级，必要时取 backend 最大/最小并记录策略 |
| `limit.output` | 当前无；未来可能新增 `output_limit` 或类似字段 | 当前使用保守默认值 32,000；未来模型卡提供明确上限后优先使用模型卡字段 |
| `attachment` | capabilities | 包含 `IS_VISION` 时 true |
| `modalities.input` | capabilities | 默认 `["text"]`；视觉模型加 `image` |
| `modalities.output` | 首批范围 | `["text"]` |
| `tool_call` | capabilities | 任一选中协议配置包含 `FUNCTION_CALL` 时 true |
| `reasoning` | model_name/capabilities | 名称或能力明确表明 reasoning 时 true，否则 false |
| `temperature` | chat 模型 | 默认 true；对明确不支持采样参数的模型可 false |
| `options` | 生成规则 | 标记 MaaS 协议、operation、是否 responses |

能力聚合以“选中默认协议配置集合”为范围。如果同一模型存在 OpenAI Responses，则默认协议集合只取支持 `OPENAI_RESPONSES` 的配置；否则按 OpenAI Chat、Anthropic Messages、Gemini Generate Content 的顺序选择。选中集合内的 backend 能力取并集，让 MaaS 网关可路由能力尽量完整体现。价格使用选中集合内基础档最大值。

### 6. 价格映射规则

MaaS 价格在：

`backend_model_list[].protocol_configs[].pricing.tiered_pricing[]`

首批建议：

- 选择与默认协议一致的 enabled protocol config；如果存在 OpenAI Responses，则选择支持 `OPENAI_RESPONSES` 的配置集合。
- 使用 `threshold === 0` 的基础档作为 `cost.input` 与 `cost.output`。
- `cached_input_fee` 映射为 `cost.cache_read`。
- OpenAI pricing 的 `cache_creation_fee` 或 `explicit_cached_input_fee` 映射为 `cost.cache_write`，优先使用 `cache_creation_fee`。
- Anthropic pricing 的 `cache_creation_fees.ttl_5m` 映射为 `cost.cache_write`，`cached_input_fee` 映射为 `cost.cache_read`。
- 如同一模型同一默认协议集合存在多个 backend，首批取基础价格的最大值作为展示价格，避免低估成本；也可以在文档中明确“按 MaaS 网关实际 backend 计费，展示为保守价”。
- 分段价格若存在 `threshold > 0`，可在现有 `context_over_200k` 字段能表达时映射一个高上下文档；不能完整表达多段价格时，至少保留基础档并在方案/后续项中记录限制。

模型卡价格配置中存在 `currency` 字段，当前可见值包含 CNY 和 USD。现有 `cost` 字段及下游费用 UI 按 USD 解释，因此首批规则为：

- USD 价格原样写入 `cost`。
- CNY 价格通过固定参考汇率 `USD/CNY = 7` 换算为 USD 后写入 `cost`。
- 首批不在运行时请求外部汇率服务，避免 provider 初始化被第三方网络请求阻塞。
- 不扩展 API schema，也不让 UI 感知混合币种。

### 7. Provider 连接体验

MaaS provider 元数据需包含：

- `id: "maas"`
- `name: "MaaS"`
- `env: ["MAAS_API_KEY"]`

保存 API Key 后，现有 `Auth.set("maas", { type: "api", key })` 会让 MaaS 出现在 connected provider 中。环境变量 `MAAS_API_KEY` 也会在 `Provider.state()` 中自动连接。

前端建议改动：

- 可选：把 `maas` 加入 `popularProviders`。
- 可选：增加 MaaS note 文案。
- 可选：增加 MaaS provider icon；若不加，当前会 fallback 到 `synthetic`。

这些不影响核心功能验收，但影响“一等 provider”的观感。

### 8. SDK 与生成链路

如果新增或修改 HTTP API schema，需要执行：

`./packages/sdk/js/script/build.ts`

本方案优先不修改 API schema，因此理论上不需要重生成 JS SDK。若后续为 currency 或连接信息扩展 schema，则必须重生成 SDK。

## 实施步骤

1. 设计并固化 MaaS 转换规则
   - 明确默认协议选择。
   - 明确多 backend 能力取并集、价格取最大值的聚合策略。
   - 明确当前 output limit 默认值和未来模型卡字段优先级。
   - 明确 CNY 按固定参考汇率换算为 USD 的策略。

2. 增加 MaaS provider 数据生成
   - 从 `docs/maas/modelcards.json` 读取模型卡。
   - 过滤首批普通 chat 模型。
   - 输出 models.dev 兼容 provider 数据。
   - 增加生成结果校验：模型数量、排除列表、必填字段、非零价格。

3. 接入 provider 数据加载
   - 将 MaaS provider 合并进 `ModelsDev.get()` 返回值或构建快照。
   - 确保 `Provider.fromModelsDevProvider()` 可正确转换所有 MaaS 模型。
   - 确保 `MAAS_API_KEY` 和保存的 API Key 都能连接 MaaS。

4. 增加 MaaS loader 适配
   - 支持 OpenAI Responses 优先。
   - 支持 OpenAI Chat Completions fallback。
   - 支持 Anthropic Messages。
   - 支持 Gemini Generate Content。
   - 保证发送模型名始终为 `model_name`。

5. 完善前端展示
   - 在 provider 列表和连接弹窗中展示 MaaS。
   - 决定是否加入常用 provider。
   - 决定是否添加图标和 note 文案。
   - 确认模型 tooltip 能展示 context、视觉、工具调用等能力。

6. 增加测试与验收脚本
   - 转换规则单测。
   - provider list/connected 测试。
   - 模型过滤测试。
   - 协议选择测试。
   - 可选真实 MaaS API smoke test。

## 测试计划

后端测试建议在 `packages/opencode` 目录执行，不能从 repo root 运行。

建议覆盖：

- `maas` provider 存在，名称为 `MaaS`，env 包含 `MAAS_API_KEY`。
- 默认纳入模型数量为 27。
- `batch-test-model`、`qwen3-max`、`deepseek-v3.2`、`deep-research-pro-preview-12-2025` 不在默认模型列表。
- 至少抽查 5 个模型 context 与模型卡一致。
- 至少抽查 5 个模型 input/output/cache 价格与基础档一致；CNY 模型按固定参考汇率 `USD/CNY = 7` 换算后校验。
- OpenAI Responses 模型生成的运行时模型会走 responses。
- 无 Responses 的 OpenAI 模型走 chat completions。
- Anthropic 模型使用 `@ai-sdk/anthropic`。
- Gemini 模型使用 `@ai-sdk/google` 和 `/v1beta` base URL。
- `MAAS_API_KEY` 环境变量能让 `Provider.connected()` 包含 `maas`。
- 保存 API Key 后 `Provider.connected()` 包含 `maas`。
- `disabled_providers: ["maas"]` 后 provider 不可用。
- `disabled_models` 支持 `maas/model` 和裸 model ID。

真实 API smoke test 可作为手动或 gated 测试：

- OpenAI 协议模型普通文本对话。
- Anthropic 协议模型普通文本对话。
- Gemini 协议模型普通文本对话。
- 视觉模型在附件路径中不被 `unsupportedParts()` 降级为错误文本。
- 工具调用模型能进入现有 tool call 流程。

## 风险与建议

1. CNY 汇率换算风险最高。现有 `cost` 没有 currency 字段，首批把 CNY 按固定参考汇率 `USD/CNY = 7` 换算为 USD 后写入 `cost`；该值只适合费用估算，后续若要更准确可在生成脚本或独立刷新流程中更新汇率。

2. 多 backend 价格/能力不完全一致。首批按默认协议集合取能力并集、价格取基础档最大值；这更符合 MaaS 网关可路由能力，但仍可能出现某次实际 backend 不支持某项能力的边缘情况。

3. OpenAI Responses 兼容性需要实测。`@ai-sdk/openai` 是否可直接用 MaaS `/v1` 跑 Responses，要用真实 MaaS key 验证；如果不兼容，应走 MaaS 专用 Responses wrapper。

4. Gemini base URL 是 `/v1beta`，与 OpenAI/Anthropic 的 `/v1` 不同。必须使用模型级 `api.url`，不能只设置 provider 级 `api`。

5. 图标不是技术阻塞。首批可先加入常用 provider，并使用现有占位符图标；后续替换为正式 `maas.svg`。

6. 自动刷新模型卡不属于首批。生成脚本和校验必须足够清晰，让后续手动更新模型卡时能稳定复现。

## 建议验收顺序

1. 静态检查：生成 MaaS provider 后，模型数量、排除列表、协议分布和价格字段符合预期。
2. 本地 provider list：未配置 key 时 MaaS 出现在 all provider；配置 key 后出现在 connected provider。
3. 前端设置：MaaS 可连接、断开、禁用。
4. 模型选择器：MaaS connected 后出现 27 个默认普通 chat 模型。
5. 请求链路：OpenAI、Anthropic、Gemini 各跑通一个文本对话。
6. 回归检查：OpenAI、Anthropic、Google、OpenRouter 等既有 provider 的连接与对话不受影响。
