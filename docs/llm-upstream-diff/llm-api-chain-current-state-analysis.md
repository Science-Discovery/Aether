# LLM API 链路现状分析（2026-06-02）

> 本文基于 [`llm-upstream-diff-report-2026-05-04.md`](./llm-upstream-diff-report-2026-05-04.md) 与
> [`llm-upstream-diff-report-2026-06-02.md`](./llm-upstream-diff-report-2026-06-02.md) 两份上游差异报告，
> 把其中 `LLM-UP-001 ~ 035` 的差异点**按 LLM API 调用链路的环节重新归类**，
> 给出当前 Aether 在每个环节上的缺陷/bug 清单，并标注哪些可以直接从上游迁移。
>
> 文中的「现状未覆盖」最初在 HEAD `8a79a87dd` 用 grep 二次复核过（关键行号见下）。
> 2026-06-10 补充复核时，`ProviderTransform` 中部分 reasoning 修复已经落地；本次同时补充
> `packages/opencode/test/tool/fixtures/models-api.json` 相对上游模型集合滞后的测试覆盖风险。

---

## 0. 阅读前提：两条横亘整条链路的「结构性鸿沟」

在逐环节分析之前，必须先明确两点——它们决定了**每一个差异点能否逐行 cherry-pick，还是只能按行为语义重写**：

1. **架构鸿沟。** 上游已把 `session/llm.ts`、`provider/provider.ts`、`session/prompt.ts`、`compaction.ts`、`summary.ts` 全面迁到 Effect `Service`/`Layer` + `@opencode-ai/core` monorepo 拆分 + SQL/Drizzle session store，并新增 `@opencode-ai/llm` 原生运行时包。Aether 仍是 pre-Effect 的 `namespace` + 直接 bundle `@ai-sdk/*` 的形态。**绝大多数上游 patch 无法逐行套用，只能按行为语义回迁。**
2. **AI SDK 代际差。** Aether 在 AI SDK **v5** 线（`ai 5.0.124`、`@ai-sdk/google 2.x`、`vertex 3.x`、`bedrock 3.x`、`xai 2.x`、`mistral 2.x`），上游已在 **v6**。所有「bump 某 provider SDK」类提交都被这个代际差阻塞，统一归入 v6 迁移专项。

**结论：本文所有「可直接迁移」均指「行为语义可在 Aether 现有架构内复刻」，不是 git cherry-pick。**

### 0.1 测试 fixture 的模型集合滞后

`packages/opencode/test/tool/fixtures/models-api.json` 不是完全没有新模型：本地 fixture 已有 `gpt-5.2`、
`claude-opus-4-5`、`gemini-3-flash`、`deepseek-v3.2`、`qwen3` 等条目。本次已补入 direct provider
的 `deepseek-v4-flash`、`deepseek-v4-pro`、`gemini-3.1-pro-preview`、`gemini-3.1-flash-lite-preview`
样本，但它仍明显滞后于 `~/tmp/opencode` 的 fixture，至少缺少以下会触发现有硬编码分支的新模型样本：

| 缺口 | 本地 fixture | 上游 fixture | 风险 |
|------|--------------|--------------|------|
| DeepSeek v4 聚合 provider | direct `deepseek` 已命中 `deepseek-v4-flash` / `deepseek-v4-pro`；Vercel/OpenRouter 等聚合路径未补 | 已含 `deepseek-v4-flash`、`deepseek-v4-pro` 及多 provider 路径 | direct provider 已有 fixture-backed 覆盖；聚合 provider 的 slug/providerOptions 路径仍缺真实 metadata 回归样本 |
| Gemini 3.1 聚合 provider | direct `google` 已命中 `gemini-3.1-pro-preview` / `gemini-3.1-flash-lite-preview`；Vercel/OpenRouter 等聚合路径未补 | 已含 `gemini-3.1-pro-preview`、`gemini-3.1-flash-lite(-preview)`、`google/gemini-3.1-*` | direct Google thinking level / smallOptions 已有 fixture-backed 覆盖；Gateway/OpenRouter 映射仍缺真实 metadata 回归样本 |

当前 `test/session/llm.test.ts` 虽会读取这个 fixture，但实际只用到少数代表模型（如 `alibaba/qwen-plus`、
`openai/gpt-5.2`、`anthropic/claude-3-5-sonnet-20241022`、`google/gemini-2.5-flash`）。因此即使
fixture 里有部分新模型，也不能证明 `provider.ts` / `transform.ts` 对新模型命名的硬编码判断已经被真实
models.dev metadata 测到。本次新增 direct DeepSeek v4 / Google Gemini 3.1 的 fixture-backed transform
覆盖；provider/gateway 聚合路径仍待补齐。

---

## 1. LLM API 调用链路分环节拆解

把一次 LLM 调用从入口到落库拆成 7 个环节，并把所有差异点挂到对应环节：

```
用户请求
  │
  ▼
[环节 A] Provider / Model 解析 & SDK key 映射     provider.ts
  │   选 SDK、铸 token、选 language model 接口
  ▼
[环节 B] 请求构造 / 消息归一化 / Transform        transform.ts
  │   providerOptions、reasoning 选项、消息重排、字符清洗、tools
  ▼
[环节 C] 历史消息 → ModelMessage 转换             message-v2.ts
  │   reasoning 跨模型处理、签名 reasoning 保留、latest 推导
  ▼
[环节 D] 流式传输 / Transport                     provider.ts (wrapSSE) / llm.ts
  │   SSE 超时、header 超时、finish-reason 归一
  ▼
[环节 E] 重试 / 错误处理                           retry.ts / error.ts
  │   5xx、server_is_overloaded、可重试 SSE
  ▼
[环节 F] 会话循环 / 压缩 / Usage 计费              prompt.ts / index.ts / compaction.ts
  │   latest-turn 判定、双重压缩、分层定价、usage 归一
  ▼
[环节 G] Copilot 自维护 SDK（旁路）               provider/sdk/copilot/**
      首 delta 解析、V2/V3 specificationVersion
```

| 环节 | 涉及差异点 |
|------|-----------|
| A 解析/SDK key | LLM-UP-001、022、023、024、025、026 |
| B 请求构造/Transform | LLM-UP-002、006、008、016、019、020、029(配置)、030、031 |
| C 历史→ModelMessage | LLM-UP-005、017 |
| D 流式/传输 | LLM-UP-003、027、029、034(专项) |
| E 重试/错误 | LLM-UP-004、028 |
| F 会话/压缩/计费 | LLM-UP-009、~~018~~（误报，已撤销）、021、035(专项) |
| G Copilot SDK | LLM-UP-012、015 |
| 横切（依赖升级） | LLM-UP-007（OpenRouter SDK）、AI SDK v6 专项、LLM-UP-033 native runtime |
| 横切（测试数据/fixture） | `models-api.json` 缺 DeepSeek v4 / Gemini 3.1 等聚合 provider 新模型样本 |

---

## 2. 各环节现状：缺陷 / bug 清单

下面每个环节区分三类标记：
**🐛 Bug**（会导致请求失败 / 行为错误）、**⚠️ 缺陷**（鲁棒性/正确性不足但不一定崩）、**✅ 已覆盖**（本地已实现或本地策略优先）。

### 环节 A —— Provider / Model 解析 & SDK key 映射（`provider.ts`）

| 项 | 类型 | 现状 | 影响 |
|----|------|------|------|
| LLM-UP-001 dotted providerID 取首段 | ✅ 已覆盖 | `ProviderTransform.providerOptions` 已对 OpenAI-compatible/openai/anthropic dotted providerID 取首段 | wafer.ai 等自定义 provider |
| **LLM-UP-022 cf-ai-gateway sdkKey/variants** | ⚠️ 缺陷 | `sdkKey()` 无 `ai-gateway-provider → openaiCompatible` 映射；`variants()` 无该分支 | CF AI Gateway 用户拿到 deprecation key / 错配 reasoning 选项 |
| **LLM-UP-023 Azure Anthropic resolve** | 🐛 Bug | `provider.ts:304-306/321-323` 旧 `chat?:responses` 二选一，无 `sdk.messages` 兜底 | Azure 托管 Anthropic 模型**无法 resolve** |
| **LLM-UP-025 Vertex GoogleAuth scopes** | 🐛 Bug | `provider.ts:531-533` 旧无 scope 的 `getApplicationDefault()` 形态 | 部分 Vertex ADC token 铸造失败 / scope 不足 |
| **LLM-UP-026 Vertex 大洲级 multi-region** | ⚠️ 缺陷 | 内联 vertex loader 的 `GOOGLE_VERTEX_ENDPOINT` 无 `.rep.googleapis.com` 特例 | `location=eu/us` 用户端点不解析（触发面窄） |

### 环节 B —— 请求构造 / 消息归一化 / Transform（`transform.ts`）

| 项 | 类型 | 现状（复核行号） | 影响 |
|----|------|------|------|
| LLM-UP-002 Anthropic tool-call 后 text/reasoning 重排 | ✅ 已覆盖 | `ProviderTransform.message` 已拆分 `[tool-call, text/reasoning]` | Anthropic / Vertex Anthropic |
| LLM-UP-006 DeepSeek 空 reasoning 保留 | ✅ 已覆盖 | DeepSeek assistant 补空 reasoning + 回灌空 `reasoning_content` | DeepSeek / 国产 interleaved |
| LLM-UP-008 Azure providerOptions/store/cache | ✅ 保留本地策略 | 当前 `providerOptions` 保留 `azure` key，不双写 openai | Azure（与上游双写策略不同，刻意保留） |
| LLM-UP-016 Opus 4.7+ `display:"summarized"` + 泛化检测 | ✅ 已覆盖（需真实 smoke） | 当前 `opus47()` 已支持 `opus-4.7`、`opus-4-7`、`claude-4.7-opus`、Vertex `@` 后缀；Anthropic/Gateway/Bedrock/SAP adaptive 分支已写 `display:"summarized"` | 仍建议对 Opus 4.7+ 真实 provider smoke，确认 API 返回非空 thinking summary |
| **LLM-UP-019 sanitizeSurrogates** | ⚠️ 缺陷 | `transform.ts` 无 surrogate 清洗（已复核 0 命中） | 落单 UTF-16 代理项导致部分 provider 400 |
| **LLM-UP-020 tools 按名排序** | ⚠️ 缺陷 | `llm.ts:330` `activeTools: Object.keys(tools)` 未排序（已复核） | tools 顺序抖动 → prompt cache miss |
| **LLM-UP-024 Azure gpt-5.5 走 completions** | 🐛 Bug | `options()`（`transform.ts:890-915`）有 gpt-5 块但无 gpt-5.5/azure 短路 | Azure gpt-5.5 拿到 `reasoning_effort` → **400** |
| **LLM-UP-030 deep-research 限定 effort** | ⚠️ 缺陷 | `transform.ts` 无 `deep-research` 字样 | OpenAI `*-deep-research` 给全 effort 菜单 → 不支持档 400（仅当上架该模型） |
| **LLM-UP-031 直连 GPT-5 加密 reasoning include** | ⚠️ 缺陷 | `transform.ts:891-895` 直连 GPT-5 路径只设 effort/summary，无 `include:["reasoning.encrypted_content"]` | `store:false` 无状态多轮 reasoning 丢加密状态 |

### 环节 C —— 历史消息 → ModelMessage 转换（`message-v2.ts`）

| 项 | 类型 | 现状（复核行号） | 影响 |
|----|------|------|------|
| LLM-UP-005 跨模型 reasoning 转 text | ✅ 已覆盖 | `toModelMessages` 在 `differentModel` 时把非空 reasoning 转 text、丢空 reasoning | Bedrock / 切模型续聊 |
| LLM-UP-017 签名 reasoning 保留 | ✅ 已覆盖 | `normalizeMessages` 已保留带 `anthropic/bedrock.signature` 或 `.redactedData` 的空 reasoning；`message-v2.ts` 已对带签名 reasoning 的空 text 写 `" "` | 仍需保留回归测试，避免后续清理空内容时破坏签名位置 |

### 环节 D —— 流式传输 / Transport（`provider.ts` wrapSSE / `llm.ts`）

| 项 | 类型 | 现状 | 影响 |
|----|------|------|------|
| LLM-UP-003 finish=stop 含 tool call 归一为 tool-calls | ✅ 已覆盖 | `LLM.stream` middleware 已归一 | OpenAI-compatible |
| **LLM-UP-027 可重试的 SSE 卡死** | ⚠️ 缺陷 | `wrapSSE`（`provider.ts:76`）仍抛裸 `new Error("SSE read timed out")`，无 `ResponseStreamError`、无重试映射 | 卡死 SSE 不可靠重试（与本地 SSE-timeout 层互补） |
| LLM-UP-029 headerTimeout（也属配置环节 F/B） | ⚠️ 缺陷（默认建议关） | `config.ts:1094` 仅 `timeout`+`chunkTimeout`，无 `headerTimeout` | 响应头超时无独立 abort（默认 10s 在国内代理后可能误 abort，建议默认关） |
| LLM-UP-034 OpenAI responses-over-WS | 专项暂缓 | 扁平 `plugin/codex.ts`，无 ws 传输 | 新实验特性，非修复 |

### 环节 E —— 重试 / 错误处理（`retry.ts` / `error.ts`）

| 项 | 类型 | 现状 | 影响 |
|----|------|------|------|
| LLM-UP-004 5xx retry | ✅ 已覆盖（措辞需收紧） | 可重试性走 `parseAPICallError`→`isRetryable`/`isOpenAiErrorRetryable`；**无字面 `statusCode>=500` 判断**（05-04 原文过度具体） | 所有 provider |
| **LLM-UP-028 重试 `server_is_overloaded`** | ⚠️ 缺陷 | `error.ts:116` `parseStreamError` 无 `server_error` 分支；`retry.ts` 字符串启发式不匹配字面 `server_is_overloaded` | zen / opencode gateway 该错误不重试 |

### 环节 F —— 会话循环 / 压缩 / Usage 计费（`prompt.ts` / `index.ts` / `compaction.ts`）

| 项 | 类型 | 现状（复核行号） | 影响 |
|----|------|------|------|
| LLM-UP-009 usage 不重复计费 | ✅ 已覆盖 | AI SDK v6 已升 `6.0.174`，`Session.getUsage` 归一逻辑通过本地测试 | Anthropic/Bedrock/OpenRouter（真实 smoke 仍建议） |
| ~~LLM-UP-018 双重自动压缩~~ | ✅ 不适用（误报，已实测） | 上游 bug 依赖 `tail_start_id` 的 replay-tail 重排产生非时序数组；**Aether 无 `tail_start_id`**（全仓 0 命中），`filterCompacted`（`message-v2.ts:899-915`）遇压缩边界直接 `break`，把溢出 tail **整段排除**。实测 `m1<m2<m3<m4` 场景结果为 `[m2,m3,m4]`（溢出 m1 不在数组），位置扫描正确落在 summary（`summary===true`），守卫 `prompt.ts:565` 不触发二次压缩 | 无 —— 原报告把上游 reorder 前提误套到 Aether |
| **LLM-UP-021 分层定价 tiers[]** | ⚠️ 缺陷 | `index.ts:1883-1886` 仍二元 `experimentalOver200K`（已复核），schema 无 `tiers` | tiered pricing 模型成本不准（无 abort 风险） |
| LLM-UP-035 session 级 usage totals | 不适用 port | 依赖上游 SQL/Drizzle store + migration，Aether 无 | 产品功能，按本地存储原生实现 |

### 环节 G —— Copilot 自维护 SDK（`provider/sdk/copilot/**`，旁路 AI SDK 中间件）

| 项 | 类型 | 现状 | 影响 |
|----|------|------|------|
| **LLM-UP-015 ① 首 delta 解析过严** | 🐛 Bug（永久 Aether-only） | `chat/openai-compatible-chat-language-model.ts:519-532` 对首个 tool-call delta 缺 `id` 严格抛 `InvalidResponseDataError` | Copilot chat 路径 tool 调用（如 `memory_list`）**中断** |
| **LLM-UP-015 ② V2 SDK 中间件失效** | 🐛 Bug（永久 Aether-only） | SDK 仍 `specificationVersion="v2"`，v6 `streamText` 跳过 `wrapLanguageModel`，`ProviderTransform.message`/finish-reason 归一对 Copilot chat 不生效 | Copilot chat 路径绕过所有 transform 修复 |
| LLM-UP-012 Copilot GPT-5 variants / AIU 计费 | 部分/暂缓 | 有 Copilot SDK 和测试，上游细节有差异 | 单独排期 |

> **关键定性（06-02 报告确认）：** 上游 `28112fbd1..687c66248` 内**根本没有 `provider/sdk/` 目录**，整套 Copilot SDK 是 Aether vendored，上游用 stock `@ai-sdk/github-copilot`。**LLM-UP-015 永远不会由上游修复，必须 Aether 自行排期。**

### 环节 H —— 测试 fixture / 新模型回归覆盖（`models-api.json`）

| 项 | 类型 | 现状 | 影响 |
|----|------|------|------|
| DeepSeek v4 聚合 provider 缺口 | ⚠️ 缺陷 | direct `deepseek` 已补 `deepseek-v4-flash` / `deepseek-v4-pro`；上游 fixture 还包含这些模型的多种聚合 provider 变体 | DeepSeek v4 direct provider reasoning/interleaved 已有 fixture-backed 覆盖；聚合 provider slug/providerOptions 路径仍缺真实 metadata 回归样本 |
| Gemini 3.1 聚合 provider 缺口 | ⚠️ 缺陷 | direct `google` 已补 `gemini-3.1-pro-preview` / `gemini-3.1-flash-lite-preview`；上游 fixture 还包含 OpenRouter、Vercel 等路径 | `gemini-3.1` thinking level、Google direct smallOptions 已有 fixture-backed 覆盖；Gateway/OpenRouter 映射仍缺真实 metadata 样本 |
| fixture 使用面仍偏窄 | ⚠️ 缺陷 | `transform.test.ts` 已读取新增 direct DeepSeek v4 / Gemini 3.1 样本；`session/llm.test.ts` 仍集中在 `qwen-plus`、`gpt-5.2`、`claude-3-5-sonnet`、`gemini-2.5-flash` | `provider.ts` 中按模型名硬编码的 `gpt-5.*`、Copilot Responses/Chat 分流，以及聚合 provider 映射仍无法靠 fixture 全面回归 |

---

## 3. 可直接从上游迁移的修改（汇总）

「可直接迁移」= 行为修复、不依赖 Effect/v6、当前确实未覆盖、改动局限在 Aether 现有文件内。

### 第一批 —— 剩余行为修复，机械或小而自洽（优先）

> 注：原列入第一批的 **LLM-UP-016/017 已在当前代码覆盖**，`LLM-UP-018` 经实测确认为误报。
> 剩余第一批重点是字符清洗和 tools 排序；同时补 fixture 新模型样本，避免新模型命名继续绕过测试。
> 本次已先补 direct DeepSeek v4 / Google Gemini 3.1 样本，聚合 provider 路径仍需后续补齐。

| 项 | 环节 | 类型 | 动作 | 风险 | 验收 |
|----|------|------|------|------|------|
| **LLM-UP-019** sanitizeSurrogates | B | ⚠️ | helper 拼进 `normalizeMessages`，清洗 system/user/assistant text+reasoning 与 tool-result | 低（只改非法字符串） | `bun test test/provider/transform.test.ts` |
| **LLM-UP-020** tools 排序 | B | ⚠️ cache | `Object.entries(tools).toSorted()` 一次后复用于 `activeTools`/repair 查找 | 低（首次一次性 cache miss） | `bun test test/session/llm.test.ts` |
| **fixture 新模型样本** | H | ⚠️ coverage | 已补 direct DeepSeek v4 与 Google Gemini 3.1 代表模型；后续从上游 fixture 补 Vercel/OpenRouter 等聚合 provider 代表模型 | 低 | `bun test test/provider/transform.test.ts test/session/llm.test.ts` |

### 第二批 —— provider 专项小修，架构无关

| 项 | 环节 | 类型 | 动作 | 验收 |
|----|------|------|------|------|
| **LLM-UP-022** cf-ai-gateway key/variants | A | ⚠️ | 补 `sdkKey` case + `variants` 分支，复用现有 efforts 常量 | `bun test test/provider/transform.test.ts` |
| **LLM-UP-023** Azure Anthropic resolve | A | 🐛 | 两处 azure loader 加 `messages` 兜底（`chat→responses→messages→chat→languageModel`） | `bun test test/provider/provider.test.ts` |
| **LLM-UP-024** Azure gpt-5.5 completions | B | 🐛 | `options()` 加 `npm==="@ai-sdk/azure" && id.includes("gpt-5.5")` 早返回（只设 `reasoningSummary:"auto"`） | `bun test test/provider/transform.test.ts` |
| **LLM-UP-025** Vertex GoogleAuth scopes | A | 🐛 | `new GoogleAuth({scopes:[".../cloud-platform"]})` + `getClient()` + `getAccessToken()` | `bun test test/provider/provider.test.ts` |
| **LLM-UP-027** 可重试 SSE 卡死 | D | ⚠️ | 适配 Aether 命令式 retry 循环：`wrapSSE` 抛 `ResponseStreamError` + 映射可重试 | `bun test test/session/llm.test.ts test/provider/provider.test.ts` |
| **LLM-UP-031** 直连 GPT-5 加密 include | B | ⚠️ | `options()` 一行：直连 GPT-5 也加 `include:["reasoning.encrypted_content"]`（跳过 `packages/llm` 部分） | `bun test test/provider/transform.test.ts` |
| **LLM-UP-021** 分层定价 | F | ⚠️ | Zod cost schema 加 `tiers` + `getUsage` 选档；**务必保留** Aether 的 cache-token 调整与自有 `total` 计算 | `bun test test/session/compaction.test.ts` |

### 第三批 —— 小 / 触发面窄

| 项 | 环节 | 说明 |
|----|------|------|
| LLM-UP-026 | A | Vertex `eu`/`us` 大洲端点分支 |
| LLM-UP-028 | E | `retry.ts` 识别 `server_is_overloaded`/`server_error` |
| LLM-UP-029 | D/B | `headerTimeout` 配置（**建议 OpenAI 10s 默认设关或可调**，避免国内慢网关误 abort） |
| LLM-UP-030 | B | openai/openrouter 内联块 `deep-research → medium` 守卫 |
| LLM-UP-032 | A | NVIDIA `X-BILLING-INVOKE-ORIGIN` header（仅当支持 NVIDIA） |

---

## 4. 不迁移 / 禁止迁移 / keep-local

### ⚠️ 反向冲突（禁止回迁）

- **`2f2fcc165`/`#30127`（上游删除自动 full session diff）与 Aether `bafdfb6d2`（修好并保留自动 diff）意图相反。** 上游让 `Session.diff` 返回 `[]`、改读 `message.info.summary?.diffs`、删 `Storage` 依赖；Aether 是顺序无关指纹去重 + `setSummary`/`Storage.write`/`Bus.publish` 一起 gate。**盲目回迁会删掉 `bafdfb6d2` 修好的机制、重新引入闪烁/陈旧并打断 review 面板。`summary.ts:92-191` 仍依赖 `["session_diff", ...]`。**

### 专项 / 暂缓（大型架构迁移，非单点修复）

- **LLM-UP-033 native LLM runtime**（`@opencode-ai/llm`，40+ 文件新包，默认关）：不可移植，**不 cherry-pick 任何子项**。其中 `61390dbb4`（native 续传 metadata）的 bug 只存在于 native 协议实现，Aether AI SDK 路径不会触发。
- **LLM-UP-034 OpenAI responses-over-WebSocket**：新实验特性，需引 `ws` 依赖 + 重构 plugin 目录。
- **LLM-UP-035 session 级 usage totals**：依赖 SQL/Drizzle store + migration。
- **AI SDK v5→v6 迁移专项**：阻塞一批 provider SDK bump（bedrock 4.x、google/vertex thought signatures、xAI PDF 等）。注意 google tool-id 回归的 **pin 约束**——未来 v6 迁移须落在 `@ai-sdk/google ≤3.0.73` / `vertex ≤4.0.128`。
- **LLM-UP-007 OpenRouter SDK**：已随 AI SDK v6 专项升到 `@openrouter/ai-sdk-provider@2.9.0`，仍建议真实 OpenRouter/DeepSeek smoke。

### keep-local（本地策略优先，上游对应改动对 Aether 是 no-op 或有害）

- **LLM-UP-013 本地兼容层必须保留**：OpenAI-compatible `includeUsage`、`max_tokens→max_completion_tokens`、reasoning 回灌、**LiteLLM `_noop` dummy tool**（Aether 面向旧 LiteLLM / 国内 OpenAI-compatible 网关，上游以「LiteLLM 已服务端修复」为前提删除，Aether 不能跟）、SSE timeout、HTTP proxy。
- **LLM-UP-008 Azure** 保留本地「不 remap 到 openai」策略。
- **LLM-UP-010/011** models.dev 服务化、Alibaba 官方 SDK：保留本地 snapshot 与国产网关 `enable_thinking` 语义。
- mistral medium 3.5 / GPT-5 variant helpers / Gemini thinking helpers / Opus 4.5 effort：Aether 用内联 `iife`，仅当实际上架对应子模型时**选择性**回迁。

### LLM-UP-015 Copilot SDK —— 永久 Aether-only

上游无 vendored SDK，永不会修。需 Aether 自行排期：
- **短期**：放宽 chat 首 delta 解析——id 与 name 同时缺失时占位等下一帧，仅半残（仅缺其一）时仍抛。
- **长期**：把 Copilot SDK 升到 `LanguageModelV3`，让 AI SDK v6 中间件对 Copilot chat 路径复生效。

---

## 5. 一页速查：bug 优先级矩阵

| 严重度 | 项 | 一句话 |
|--------|----|--------|
| 🔴 会崩/请求失败 | LLM-UP-023 | Azure Anthropic 无法 resolve |
| 🔴 | LLM-UP-024 | Azure gpt-5.5 → 400 |
| 🔴 | LLM-UP-025 | Vertex ADC token 铸造失败 |
| ✅ 已覆盖但需防回归 | LLM-UP-017 | 签名 reasoning 保留已落地，需保留测试 |
| 🔴 | LLM-UP-015① | Copilot chat tool 调用中断（自维护） |
| ✅ 已覆盖但需真实 smoke | LLM-UP-016 | Opus 4.7+ adaptive 配置已落地，需真实 provider 验证 |
| ~~🟠 核心循环~~ | ~~LLM-UP-018~~ | ~~双重自动压缩~~ —— 经实测撤销，Aether 无此 bug |
| 🟡 鲁棒性/正确性 | LLM-UP-019/020/021/022/026/027/028/029/030/031 + fixture 缺口 | 字符清洗 / cache / 定价 / gateway / SSE 重试 / 超时 / 新模型覆盖 等 |

---

## 6. 落地建议

1. **先做剩余第一批**：`LLM-UP-019/020` 加上 fixture 新模型样本。direct DeepSeek v4 / Google Gemini 3.1 已补，后续继续补聚合 provider 路径；`LLM-UP-016/017` 当前已覆盖，但应保留/补强真实模型命名回归；`LLM-UP-018` 经实测为误报，已撤销。
2. **第二批 provider 专项**（022~025/027/031/021）：按 provider 真实使用面排序——若 Aether 实际服务 Azure / Vertex，则 023/024/025 应提到第一梯队。
3. **第三批默认低优**；LLM-UP-029 `headerTimeout` 落地时**默认关闭或调大**，防国内代理误 abort。
4. **更新 fixture 时不要整文件盲拷贝**：优先用脚本/结构化 JSON 合并上游新增 provider/model 条目，至少覆盖 `deepseek-v4-flash`、`deepseek-v4-pro`、`gemini-3.1-pro-preview`、`gemini-3.1-flash-lite(-preview)`，并补断言说明这些样本触发了哪些 hardcoded 分支。
5. **守住反向冲突** `2f2fcc165`，回迁任何 session diff 相关代码前先核对 `bafdfb6d2`。
6. **Copilot SDK（015）与 AI SDK v6 迁移**各开独立专项，不混入上面三批。

### 统一验收

```bash
cd /home/fyl/opencode/packages/opencode
bun typecheck
bun test test/provider/transform.test.ts
bun test test/provider/provider.test.ts
bun test test/session/message-v2.test.ts
bun test test/session/llm.test.ts
bun test test/session/retry.test.ts
bun test test/session/compaction.test.ts
```

声称修复真实 provider 时（Opus 4.7+ adaptive / Azure Anthropic / Vertex 等需真实 smoke）：

```bash
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider deepseek
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider alibaba-cn --input p1-reasoning --p1
```
