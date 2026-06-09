# models.dev 本地补丁层需求文档

> 日期：2026-06-06
>
> 背景：`models.dev` 中部分 provider/model metadata 可能滞后、错误，或者无法覆盖
> Aether 自维护 provider。典型例子包括：
>
> - 某些 `gpt-5.5` 模型实际应走 OpenAI Responses API，却被标为
>   `@ai-sdk/openai-compatible`，从而走 Chat Completions。
> - MaaS 这类 repo 内自维护 provider 需要作为完整 provider 注入模型注册表，而不是等待
>   `models.dev` 上游提供。

## 1. 讨论结论摘要

本地补丁层是合理且必要的，但需要区分两类能力：

- `additions`：新增完整 provider。适用于 MaaS 这类 repo 内维护的 provider，必须提供完整
  `ModelsDev.Provider` 数据，不能用 partial overlay 造半残 provider。
- `overrides`：修正已存在 provider/model 的字段。适用于 `models.dev` 已有条目但 metadata 错误的
  情况，例如把指定模型的 `model.provider.npm` 从 `@ai-sdk/openai-compatible` 修成
  `@ai-sdk/openai`。

当前 MaaS 实现已经验证了 `additions` 路径可行：

- `packages/opencode/src/provider/maas.ts` 生成完整 `ModelsDev.Provider`。
- `packages/opencode/src/provider/models-local.ts` 已把 `"tatu-maas": MaaS.provider` 维护为
  `additions`，并由 `models.ts` 调用 `apply()` 注入 `ModelsDev.get()` 返回值。
- `packages/opencode/src/provider/provider.ts` 已有 `tatu-maas` custom loader，用
  `options.maas.op` 区分 Responses、Chat、Anthropic Messages、Gemini Generate Content。
- 前端已有常用 provider、note、连接弹窗固定 endpoint 展示和图标适配。

因此，本需求不应只设计一个无约束的 `models-overrides.json`。更准确的目标是新增一个
repo 内维护、可审计、可测试的 `models.dev` 本地补丁层，明确支持完整新增 provider 和字段覆盖。

## 2. 问题

Aether 的模型路由主要依赖 `models.dev` 返回的 provider/model 元数据：

- `provider.npm` 或 `model.provider.npm` 决定使用哪个 AI SDK provider。
- `provider.api` 或 `model.provider.api` 决定 SDK base URL。
- `@ai-sdk/openai` 当前通过 `languageModel()` 创建 Responses model。
- `@ai-sdk/openai-compatible` 走 Chat Completions API。

当 `models.dev` 把 Responses-only 或 Responses-preferred 模型错误标成
`@ai-sdk/openai-compatible` 时，请求会落到 `/chat/completions`。对 `gpt-5.5` 这类模型，如果请求同时
包含 function tools 和 `reasoning_effort`，会触发类似错误：

```text
Function tools with reasoning_effort are not supported
```

直接在 transform 层删除 `reasoningEffort` 只能避免 400，但会静默丢失用户选择的思考强度，不是语义正确的修复。

另一方面，MaaS 这类 provider 并不是上游 metadata 的错误，而是 Aether 自维护的 provider 新增项。
它需要完整模型卡转换、协议选择、价格换算和 loader 适配，不能用“深合并一个不存在 provider”的方式实现。

## 3. 目标

新增或规范化一个 repo 内维护的 `models.dev` 本地补丁层，在读取 cache/build fallback/live
`models.dev` 数据后、进入 `Provider.fromModelsDevProvider()` 解析前生效。

目标行为：

- 支持新增完整 provider，用于 MaaS 等 repo 自维护 provider。
- 支持修正已存在 provider/model metadata，首期重点是 model 级 `provider.npm` / `provider.api`。
- 对已验证支持 Responses API 的模型，可将指定模型覆盖为 `@ai-sdk/openai`。
- 明确优先级：`models.dev` < repo 内 additions < repo 内 overrides < 用户 config。
- 保留用户配置优先级：用户 config 中显式设置的 model/provider 字段高于本地补丁。
- 补丁项必须可审计、可测试、易删除。
- 对未知 provider/model 的覆盖必须失败或显式告警，不能静默创建不完整数据。

## 4. 非目标

- 不把所有 `gpt-5.5` 模型全局强制改成 Responses。
- 不为未知 provider 猜测 `/responses` 支持情况。
- 不在 Chat Completions 路径静默删除 `reasoningEffort`。
- 不替代上游 `models.dev` 修复；metadata override 只是临时补丁层。
- 不把 MaaS 的动态模型拉取纳入首期；MaaS 仍使用 repo 内生成产物。
- 不改变现有公开 API schema；若后续改变 schema，需按仓库要求重生成 JS SDK。

## 5. 建议文件结构

推荐把新增 provider 和字段覆盖分开维护。

```text
packages/opencode/src/provider/models-local.ts
```

示例结构：

```ts
import type { ModelsDev } from "./models"
import { MaaS } from "./maas"

export const additions = {
  "tatu-maas": MaaS.provider,
} satisfies Record<string, ModelsDev.Provider>

export const overrides = {
  opencode: {
    models: {
      "gpt-5.5": {
        provider: {
          npm: "@ai-sdk/openai",
          api: "https://opencode.ai/zen/v1",
        },
        meta: {
          reason: "models.dev marks this Responses-capable model as openai-compatible",
          verified_at: "2026-06-06",
        },
      },
    },
  },
} satisfies ModelsOverrideMap
```

如果更偏好 JSON，也应拆成两个文件：

```text
packages/opencode/src/provider/models-additions.ts
packages/opencode/src/provider/models-overrides.json
```

说明：

- `additions` 必须是完整 `ModelsDev.Provider`，可直接进入 `Provider.fromModelsDevProvider()`。
- `overrides` 只能覆盖已存在 provider/model 的字段。
- `api` 填 base URL，例如 `https://example.com/v1`。
- 不应填 `https://example.com/v1/responses`，因为 `@ai-sdk/openai` 会自行拼接 Responses 路径。
- 对 `aihubmix` 等自有 SDK provider，只有在确认 endpoint/SDK 支持 Responses 后才可覆盖。
- 审计字段不应进入运行时 `ModelsDev.Provider`，应用覆盖时需要剥离。

## 6. 合并规则

在 `ModelsDev.get()` 内或其调用后的 database 构造前应用本地补丁。推荐放在 `ModelsDev.get()` 内，
让 CLI、server route 和 provider state 看到一致数据。

推荐语义：

1. 读取 `models.dev` 数据，来源可能是 cache、snapshot 或 live fetch。
2. 合并 repo 内完整 provider additions。
3. 校验并应用 repo 内 metadata overrides。
4. 注入 `tatu-maas` 等本地 provider。
5. 返回合并后的 models 数据给 `Provider.fromModelsDevProvider()`。
6. 用户 config 仍由现有 `provider.ts` 配置合并逻辑处理，并保持最高优先级。

优先级从低到高：

```text
models.dev snapshot/live/cache
  < repo 内 provider additions
  < repo 内 metadata overrides
  < 用户 config provider/model 配置
```

约束：

- `additions[providerID].id` 必须等于 `providerID`。
- `additions` 不能覆盖 `models.dev` 已存在 provider，除非显式允许并有测试。
- `overrides` 的 provider 必须已存在于 `models.dev + additions`。
- `overrides` 的 model 必须已存在于目标 provider。
- 首期 overlay 深合并范围限制为 provider/model metadata，不支持删除字段。
- 对不认识的 override 元字段，如 `meta`，应用前应剥离或单独解析。

## 7. MaaS 作为新增 provider 的结论

MaaS 可以并且应该作为本地新增 provider 进入补丁层，但它属于 `additions`，不是普通
`overrides`。

当前实现与需求的对应关系：

- `maas-generated.ts` 是模型卡生成产物。
- `maas.ts` 把模型卡转换成完整 `ModelsDev.Provider`。
- 当前 provider ID 是 `tatu-maas`，文档中的早期目标 ID 是 `maas`。若要改名为 `maas`，需要考虑
  用户配置、认证记录、`disabled_providers`、`disabled_models`、会话 providerID 和前端特殊判断的迁移或兼容。
- 当前测试期望默认模型数为 29，而早期 MaaS 文档写过 27。应以当前模型卡筛选规则和测试为准，或重新核对模型卡后统一文档与测试。

MaaS 的实现原则：

- 使用完整 provider addition，而不是 partial override。
- provider 级默认 `npm` 可为 `@ai-sdk/openai-compatible`，但每个模型可通过 `model.provider.npm/api`
  选择 OpenAI Responses、OpenAI Chat、Anthropic 或 Gemini。
- OpenAI Responses 模型应使用 `@ai-sdk/openai` 和 base URL `https://maas.tatucloud.com/v1`。
- Gemini 模型必须使用 `https://maas.tatucloud.com/v1beta`，不能只依赖 provider 级 base URL。
- `options.maas.op` 可作为 loader 选择依据。
- Responses 兼容性仍需真实 MaaS key smoke test 验证。

## 8. 验收用例

至少增加或保留以下测试。

Metadata overrides：

- 给定 fixture 中 `opencode/gpt-5.5` 或等价模型错误标为 `@ai-sdk/openai-compatible`，应用 override 后变为
  `@ai-sdk/openai`。
- override 只影响指定 provider/model，不影响同 provider 下其他模型。
- `provider.api` 覆盖为 base URL，最终 resolver 仍选择 Responses provider。
- override 指向不存在 provider 时失败或告警，不创建新 provider。
- override 指向不存在 model 时失败或告警，不创建半残 model。
- 用户 config 显式指定同一个 model 的 `provider.npm` 时，不被 override 覆盖。

Provider additions：

- `tatu-maas` provider 存在，名称、env、模型数量符合当前生成产物。
- `MAAS_API_KEY` 环境变量能让 `Provider.connected()` 包含 `tatu-maas`。
- 保存 API Key 后 `Provider.connected()` 包含 `tatu-maas`。
- MaaS OpenAI Responses 模型使用 `@ai-sdk/openai`，`options.maas.op` 为 `responses`。
- MaaS OpenAI Chat 模型使用 `@ai-sdk/openai-compatible`，`options.maas.op` 为 `chat`。
- MaaS Anthropic 模型使用 `@ai-sdk/anthropic`。
- MaaS Gemini 模型使用 `@ai-sdk/google` 和 `/v1beta` base URL。
- `disabled_providers` 和 `disabled_models` 对新增 provider 仍按现有规则生效。

建议测试入口：

```bash
cd /home/fyl/opencode/packages/opencode
bun test test/provider/provider.test.ts
bun test test/provider/transform.test.ts
bun typecheck
```

若声称修复真实 provider，请补 gated smoke：

```bash
cd /home/fyl/opencode/packages/opencode
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider tatu-maas
```

## 9. 风险

- 错误把只支持 Chat Completions 的模型覆盖成 `@ai-sdk/openai`，会导致请求打到不存在的
  `/responses` endpoint。
- provider 可能同时暴露多个模型，其中只有部分模型支持 Responses，因此覆盖必须优先使用 model 级。
- 上游 `models.dev` 修复后，本地 override 可能变成冗余，需要定期清理。
- 无约束 deep merge 可能创建半残 provider/model，必须通过 schema 和存在性校验避免。
- 用户 config 优先级容易被误解。只有用户显式配置的字段才能覆盖本地补丁，测试应覆盖具体 model 字段。
- MaaS 的 CNY 到 USD 固定汇率只适合费用估算，不代表精确账单。
- MaaS 多 backend 能力和价格可能不完全一致，展示 metadata 与单次实际路由存在边缘差异。
- MaaS provider ID 若从 `tatu-maas` 改成 `maas`，需要兼容已有配置和历史会话。

## 10. 后续清理

建议补一个检查脚本，比较 live `models.dev` 和本地 metadata overrides：

- 如果上游字段已与本地 override 一致，提示删除该 override。
- 如果上游字段与本地 override 冲突，提示人工复核。
- 如果 override 指向的 provider/model 已不存在，提示删除或更新。

MaaS 这类 additions 的清理逻辑不同：

- 如果未来 `models.dev` 上游正式提供同等 MaaS provider，需要决定继续使用本地 provider、迁移到上游 provider，
  或保留本地 provider ID 作为兼容别名。
- 生成脚本应输出模型数量、协议分布、排除列表和价格字段摘要，便于 review。

该检查脚本不是首期必须项，但当 overrides 条目增多或 MaaS 模型卡频繁更新后应补上。
