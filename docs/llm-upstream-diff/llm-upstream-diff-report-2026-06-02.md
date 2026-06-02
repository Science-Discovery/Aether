# LLM 上游差异报告 2026-06-02

> 本报告是 [`llm-upstream-diff-report-2026-05-04.md`](./llm-upstream-diff-report-2026-05-04.md) 的续期更新。
> 05-04 报告作为历史快照保留，其 `LLM-UP-001 ~ LLM-UP-015` 编号在本报告中沿用，
> 状态有变化的在「对既有项的状态更新」一节说明；新发现的差异点从 `LLM-UP-016` 起编号。

## 基线

- 当前仓库：`/home/fyl/opencode`
- 当前分支：`dev`
- 当前 HEAD：`750aa9945`（上一轮报告基线为 `b2f150759`，该分支已并入 `dev`，期间新增提交以 memory/voice/electron/sandbox/mobile 等 Aether 自有功能为主，LLM 调用链未实质推进）
- 上游仓库：`/home/fyl/tmp/opencode`
- 上游分支：`dev`
- 上游 HEAD：`687c66248`（2026-06-02）
- 上一轮上游基线：`28112fbd1`（2026-05-04）
- 本轮时间窗口：`28112fbd1..687c66248`，共 1443 个提交，其中触及 `session/`、`provider/`、`config/`、`auth/`、`package.json` 的相关提交 220 个

## 方法

- 在上游 `28112fbd1..687c66248` 窗口内筛出 LLM 行为相关提交（reasoning、provider 兼容、usage、tool call、retry/transport、SDK bump、compaction、native runtime），剔除 Effect/Zod/HttpApi/flags 等纯架构重构噪音。
- 把候选提交按主题拆成 6 个簇并行核查：① reasoning/adaptive、② provider SDK bump + provider 专项 fix、③ streaming/transport/retry、④ native LLM runtime、⑤ session/compaction/usage、⑥ LiteLLM 移除 + Copilot。
- 每个差异点都对照当前 Aether 实际代码（`provider/transform.ts`、`provider/provider.ts`、`session/llm.ts`、`session/prompt.ts`、`session/message-v2.ts`、`session/index.ts`、`provider/error.ts`、`session/retry.ts`、`config/config.ts` 等）确认是否已覆盖，而非假设覆盖。
- 高优先项（`display:"summarized"`、`opus47` 检测、`sanitizeSurrogates`、tools 排序、position-based turn detection）已在当前 HEAD 用 grep 二次复核确认确实缺失。

## 关键结论（先读）

1. **架构鸿沟扩大。** 上游本窗口把 `session/llm.ts`、`provider/provider.ts`、`session/prompt.ts`、`compaction.ts`、`summary.ts` 全面迁到 Effect `Service`/`Layer` + `@opencode-ai/core` monorepo 拆分 + SQL/Drizzle session store，并新增 `@opencode-ai/llm` 原生运行时包。Aether 仍是 pre-Effect 的 `namespace` + 直接 bundle `@ai-sdk/*` 形态。**因此绝大多数上游 patch 无法逐行 cherry-pick，只能按行为语义回迁。**
2. **AI SDK 代际差。** Aether 在 AI SDK **v5** 线（`ai 5.0.124`、`@ai-sdk/google 2.x`、`google-vertex 3.x`、`bedrock 3.x`、`xai 2.x`、`mistral 2.x`），上游已在 **v6**。所有「bump 某 provider SDK」类提交都被这个代际差阻塞，归入 v6 迁移专项。
3. **有 5 个真正可立即回迁、且当前确实未覆盖的行为修复**（不依赖 Effect/v6）：`LLM-UP-018` 双重压缩、`LLM-UP-016` Opus 4.7+ `display:"summarized"`、`LLM-UP-019` 代理项 surrogate、`LLM-UP-020` tools 排序、`LLM-UP-017` 签名 reasoning 保留。建议作为第一批（与下文「优先回迁建议」第一批、「结论」一致）。
4. **有 1 个高风险「反向冲突」项：** 上游 `2f2fcc165`（删除自动 session diff）与 Aether 本地 `bafdfb6d2`（修好并保留自动 diff）意图相反，**禁止回迁**。05-04 快照未覆盖此冲突，本报告首次澄清。
5. **`LLM-UP-015`（Copilot V2 SDK）确认永远不会由上游修复** —— 上游根本没有 vendored 的 `provider/sdk/` 目录，整套 Copilot SDK 是 Aether 自有，必须自行排期。

---

## 新增候选项

| 编号 | 优先级 | 上游 commit/PR | 变更主题 | 影响 provider/model | 当前 Aether 状态 | 建议动作 | 风险 | 验收命令 |
|------|--------|----------------|----------|---------------------|------------------|----------|------|----------|
| LLM-UP-016 | P0 | `05e3c4ece`/`#29769`、`b956e9a06`/`#29911`、`3070b0f4a`/`#30027`、`f4f508e65`/`#29991` | Opus 4.7+ adaptive reasoning：① `anthropicOpus47OrLater` 泛化「≥4.7/未来 major」检测，覆盖 Vertex `@` 后缀与 SAP 反序 `claude-4.7-opus`/`4.6-opus`；② 在 anthropic / vertex-anthropic / bedrock / gateway / sap-ai-core 全部 adaptive 分支强制 `display:"summarized"` | Anthropic Opus 4.7+（直连 / Bedrock / Vertex / CF Gateway / SAP AI Core） | **未覆盖**。`transform.ts:414` 仅字面匹配 `opus-4-7`/`opus-4.7`；`display:"summarized"` 全文件 0 命中（已复核）。后果：Opus 4.7+ API 默认 `omitted`，Aether 将收到**空 thinking 块**；SAP/Vertex 命名变体甚至不被识别为 adaptive | 回迁（机械）：移植 `anthropicOpus47OrLater` 正则 + 给四个 adaptive 分支加 `display:"summarized"`。四个分支 Aether 都已存在 | 中：用户可见的 reasoning 摘要丢失 + 漏检 adaptive | `cd packages/opencode && bun test test/provider/transform.test.ts` |
| LLM-UP-017 | P1 | `233fc5b91`/`#21370`、`4e14f7951`/`#26276`（reasoning 半） | 含签名 reasoning 时保留 assistant 内容：① `normalizeMessages` 保留带 `anthropic/bedrock.signature` 或 `.redactedData` 的空 reasoning 块；② `toModelMessages` 对带签名 reasoning 的 assistant，空 text 替换为 `" "`，避免 SDK 过滤掉分隔符导致签名位移 | Anthropic / Bedrock adaptive thinking 多轮 | **未覆盖**。`transform.ts:108-111` 仍是旧 `part.text !== ""` 直接丢弃空 reasoning；`message-v2.ts:703-709` 无 `hasSignedReasoning` 逻辑 | 回迁（小、自洽）：两段一起改 | 中：丢弃签名 reasoning 会触发 Anthropic/Bedrock 签名位置 400 | `cd packages/opencode && bun test test/provider/transform.test.ts test/session/message-v2.test.ts` |
| LLM-UP-018 | P0 | `94564f358`/`#27545` | 防 filterCompacted 重排导致的双重自动压缩：新增 `MessageV2.latest(msgs)` 按 **max MessageID** 而非数组位置推导 latest user/assistant/finished/tasks | 所有会自动压缩的 session | **未覆盖（真实潜在 bug）**。`filterCompacted`（`message-v2.ts:899-915`）做了 `reverse()` + 提前 `break`，数组非时序；而 `prompt.ts:311` 仍用 `for (let i = msgs.length-1; ...)` 位置扫描（已复核）。压缩后会把溢出尾部的旧 assistant 误判为最新轮 → 重复压缩 | 回迁行为：在 Aether 的 plain-async 循环里按 max-id 推导 latest，并补回归测试（溢出尾部 + 压缩） | 中：触及核心循环 turn 判定 | `cd packages/opencode && bun test test/session/llm.test.ts test/session/compaction.test.ts` |
| LLM-UP-019 | P1 | `6409aceb1`/`#25934` | `sanitizeSurrogates`：把落单 UTF-16 代理项替换为 `�`，在 `normalizeMessages` 对 system/user/assistant text+reasoning 与 tool-result 输出统一清洗 | 所有 provider | **未覆盖**。`transform.ts` 无 `sanitizeSurrogates`/surrogate 正则（已复核） | 回迁（机械）：把 helper 拼进 Aether `normalizeMessages` | 低：纯清洗，只改本就非法的字符串 | `cd packages/opencode && bun test test/provider/transform.test.ts` |
| LLM-UP-020 | P1 | `83bb21648`/`#26370` | tools 始终按名排序：`Object.entries(tools).toSorted(...)` 后用于 `tools`/`activeTools`/`experimental_repairToolCall` 查找/预批准 | 所有 provider（对 prompt cache 敏感） | **未覆盖**。`llm.ts:330` `activeTools: Object.keys(tools)` 未排序；repair 查找也未排序（已复核） | 回迁（小、低风险）：排序一次后复用 | 低：首次部署可能一次性 cache miss，之后更稳定 | `cd packages/opencode && bun test test/session/llm.test.ts` |
| LLM-UP-021 | P1 | `c2b1ebd9d`/`#27184` | 分层定价：把二元 `experimentalOver200K` 泛化为 `cost.tiers[]`（按 context token size 选最高匹配档），`getUsage` 选档逻辑 + `models.ts`/`provider.ts` schema | 所有发布 tiered pricing 的模型 | **未覆盖**。`index.ts:1883-1886` 仍只有二元 `experimentalOver200K`；schema 无 `tiers`/`ProviderCostTier` | 回迁行为：给 Zod cost schema 加 `tiers` + `getUsage` 选档；**务必保留** Aether 的 OpenRouter/Anthropic cache-token 调整（`index.ts:1850-1857`）与自有 `total` 计算 | 中：仅成本准确性，无 abort 风险；与 cache 调整交互需测试 | `cd packages/opencode && bun test test/session/compaction.test.ts` |
| LLM-UP-022 | P1 | `ca77b8f8e`/`#25573`（含 `#24432`） | cf-ai-gateway：① `sdkKey()` 加 `ai-gateway-provider → "openaiCompatible"`；② `variants()` 加 `ai-gateway-provider` 分支（openai 上游走 `openaiReasoningEfforts`，其余走 `WIDELY_SUPPORTED_EFFORTS`） | Cloudflare AI Gateway（`ai-gateway-provider`，已是 Aether 依赖 `2.3.1`） | **未覆盖**。Aether `sdkKey()` 无 `ai-gateway-provider` case；`variants()` 无该分支。属 `LLM-UP-001` 同族但**不同点**（001 是 dotted providerID 取首段；本项是 npm→key 映射 + variants） | 回迁（加性、架构无关）：补 `sdkKey` case + `variants` 分支，复用 Aether 现有 efforts 常量 | 低：不回迁则 CF gateway 用户拿到 deprecation key 或错配 reasoning 选项 | `cd packages/opencode && bun test test/provider/transform.test.ts` |
| LLM-UP-023 | P1 | `c1f607d20`/`#25721` | `selectAzureLanguageModel`：fallback 链 `chat→responses→messages→chat→languageModel`，新增 `messages` 分支让 Anthropic SDK（暴露 `.messages`）在 Azure 下能 resolve | Azure（尤其 Azure 托管 Anthropic） | **未覆盖**。`provider.ts:304-306`、`321-323` 仍是旧 `useLanguageModel→useCompletionUrls?chat:responses`，无 `sdk.messages` 兜底 | 回迁（机械，1:1 映射到两处 azure loader） | 中：Azure+Anthropic 无法 resolve model | `cd packages/opencode && bun test test/provider/provider.test.ts` |
| LLM-UP-024 | P1 | `967557979`/`#26222` | Azure gpt-5.5 走 completions API：`options()` 早返回——`npm==="@ai-sdk/azure" && id.includes("gpt-5.5")` 时只设 `reasoningSummary:"auto"`，避免 `reasoning_effort` 400 | Azure gpt-5.5 | **未覆盖**。`options()`（`transform.ts:890-915`）有 gpt-5 块但无 gpt-5.5 / azure 短路；gpt-5.5 on Azure 会落入通用分支拿 `reasoningEffort` 而 400 | 回迁（小、自洽）：加 azure+gpt-5.5 早返回 | 中：Azure gpt-5.5 请求失败；修复本身低风险 | `cd packages/opencode && bun test test/provider/transform.test.ts` |
| LLM-UP-025 | P1 | `797c689ec`/`#15110` | Vertex AI 给 `GoogleAuth` 传 OAuth scopes：`new GoogleAuth({scopes:["…/cloud-platform"]})` + `getClient()` + `client.getAccessToken()` 取代旧 `getApplicationDefault()`/`credential.getAccessToken()` | Google Vertex（custom fetch token 铸造） | **未覆盖**。`provider.ts:531-533` 仍是旧无 scope 形态 | 回迁（小、架构无关，`provider.ts` 半 1:1） | 中：部分 Vertex 配置 ADC token 铸造失败/scope 不足；修复低风险 | `cd packages/opencode && bun test test/provider/provider.test.ts` |
| LLM-UP-026 | P2 | `7a9724496`/`#28347` | Vertex 大洲级 multi-region：`location` ∈ {`eu`,`us`} 且有 project 且无 baseURL 时注入 `https://aiplatform.{loc}.rep.googleapis.com/...`（默认 `{region}-aiplatform.googleapis.com` 对大洲多区不解析） | Google Vertex（Anthropic 模型） | **未覆盖**。Aether 内联 vertex loader 的 `GOOGLE_VERTEX_ENDPOINT` 无 `.rep.googleapis.com` 特例 | 回迁（适配内联 loader）：加 `eu`/`us` 分支 | 中：仅影响 `location=eu/us` 用户，触发面窄 | `cd packages/opencode && bun test test/provider/provider.test.ts` |
| LLM-UP-027 | P1 | `c7e1fc5e4`/`#29837`（+ `14e0b9b17` 共享半） | 可重试的 SSE 卡死：`wrapSSE` chunk-timeout 抛 `ProviderError.ResponseStreamError` 并在 `message-v2.ts` 映射为可重试 `APIError` | 任何用 SSE + `chunkTimeout` 的 provider（实践中 OpenAI 默认路径） | **未覆盖**。Aether `wrapSSE`（`provider.ts:76`）仍抛裸 `new Error("SSE read timed out")`，无 `ResponseStreamError` 类、无重试映射；卡死 SSE 不可靠重试 | 回迁（适配 Aether 命令式 retry 循环，非上游 Effect policy）。**与 `LLM-UP-013` 的 SSE-timeout 本地层互补、非冲突**——本地负责触发超时，上游让结果可重试 | 低：自洽，唯一行为变化是卡死流改为重试 | `cd packages/opencode && bun test test/session/llm.test.ts test/provider/provider.test.ts` |
| LLM-UP-028 | P2 | `25ecf0af6`/`#25888` | 重试 `server_is_overloaded` 错误（上游在 `parseStreamError` 让其 fall through 到 `server_error`→可重试） | 流错误体含 `code:"server_is_overloaded"` 的 provider（zen / opencode gateway） | **未覆盖**。Aether `error.ts:116` 的 `parseStreamError` 是改写版、无 `server_error` 分支；`retry.ts` 的字符串启发式也不匹配字面 `server_is_overloaded`（匹配的是 `Overloaded`/`exhausted`/`unavailable`/`rate_limit`/`too_many_requests`） | 回迁（Aether 专属位置）：在 `retry.ts` `retryable()` 加 `server_is_overloaded`/`server_error` 识别 | 低 | `cd packages/opencode && bun test test/session/retry.test.ts` |
| LLM-UP-029 | P2 | `f965db9e1`/`#29484` | 新增 `headerTimeout` provider 配置（独立于 `timeout`/`chunkTimeout`）：响应头超时则用 `HeaderTimeoutError` abort，OpenAI 默认 10s，映射为可重试 | 全 provider 可选，OpenAI 默认开 | **未覆盖**。`config.ts:1094` 仅 `timeout`+`chunkTimeout`，无 `headerTimeout`/`timeoutController`/`HeaderTimeoutError` | 回迁选项到 Aether 的 **Zod** schema（非 Effect Schema）+ timeoutController + 映射重试。**建议 OpenAI 10s 默认设为关闭或可调**，避免国内慢网关/代理（LLM-UP-013）误 abort | 中：默认 10s 在代理后可能误 abort | `cd packages/opencode && bun test test/config` |
| LLM-UP-030 | P2 | `319498e2f`/`#26273` | OpenAI deep-research 限定 effort 为 `["medium"]` | OpenAI `*-deep-research` | **未覆盖**。`transform.ts` 无 `deep-research` 字样；会给全 effort 菜单 → 不支持档 400 | 回迁（一行级）：在 openai/openrouter 内联块加 `deep-research → medium` 守卫 | 低（仅当暴露 deep-research 模型） | `cd packages/opencode && bun test test/provider/transform.test.ts` |
| LLM-UP-031 | P1 | `eb84f461b`/`#29000`（opencode 半） | `options()` 给 `@ai-sdk/openai` GPT-5 也加 `include:["reasoning.encrypted_content"]`（原先只在 `providerID.startsWith("opencode")` 分支有），修 `store:false` 无状态多轮 reasoning | OpenAI GPT-5（`@ai-sdk/openai` 直连） | **未覆盖（opencode 半）**。`transform.ts:891-895` 直连 GPT-5 路径只设 effort/summary，无 `include`。`packages/llm` 原生半不适用（Aether 无该包） | 回迁 `options()` 一行；跳过 `packages/llm`/`native-runtime` 部分 | 低-中：直连 GPT-5 无状态 reasoning 续传可能丢加密状态 | `cd packages/opencode && bun test test/provider/transform.test.ts` |
| LLM-UP-032 | P3 | `d34a0194e`/`#27394` | NVIDIA endpoints 加 `X-BILLING-INVOKE-ORIGIN: OpenCode` header | NVIDIA | **未覆盖**。Aether 无 NVIDIA plugin handler，仅 provider 列表项 | 若 Aether 支持 NVIDIA 则回迁（小）；否则暂缓 | 低：仅 billing 归因，不影响请求 | 不适用 |
| LLM-UP-033 | P2（专项/暂缓） | `dbe36851b`/`#27114`、`6618e2bce`/`#28271`、`8a321c453`、`61390dbb4`/`#28678`、`facd20739`/`#28571`、`41f6daf96`/`#28523`、`fb9d69ef6`/`#28560`、`a9c115c22` | **native LLM runtime 栈**：新增 `@opencode-ai/llm` 包绕过 AI SDK，直连 provider 协议（openai-responses/anthropic-messages/...），由 `OPENCODE_EXPERIMENTAL_NATIVE_LLM` 开关，**默认关闭**，仅 OpenAI/Anthropic/opencode API-key 模型走原生，其余回落 AI SDK | OpenAI / Anthropic API-key / OpenAI OAuth | **未覆盖且不可移植**。依赖 Effect `Service`/`Layer` 的 `llm.ts`/`provider.ts` + `@opencode-ai/core` 拆分 + 40+ 文件新包，Aether 全无。`61390dbb4`（native 续传 metadata）已评估**不值得单独 cherry-pick**——其 bug 只存在于 native 协议实现，Aether 的 AI SDK 路径不会触发 | 整体暂缓，作为大型架构迁移专项；**不 cherry-pick 任何子项**。`a9c115c22` 纯 cosmetic、不适用 | 迁移高 / 暂缓低（上游默认关，无功能损失） | 不适用 |
| LLM-UP-034 | P2（专项/暂缓） | `62da1e768`/`#29477`、`14e0b9b17`/`#29673`（WS 半） | OpenAI responses-over-WebSocket 传输：新 `plugin/openai/{ws,ws-pool}.ts`、`OPENCODE_EXPERIMENTAL_WEBSOCKETS` flag、按 channel 分级 rollout | OpenAI / Codex responses API | **未覆盖**。Aether 是扁平 `plugin/codex.ts`，无 ws 传输 / runtime flag / ws-pool | 暂缓（新实验特性，非修复）。需引 `ws` 依赖 + 重构 plugin 目录 + 与本地 proxy 层交互 | 工作量高 / 行为风险中 | 不适用 |
| LLM-UP-035 | P3（feature/暂缓） | `36d40fee4`/`#26644`、`3dc2c1d81`/`#27094` | session 级累计 usage totals（cost + tokens 持久化到 session 行）；usage delta 更新不 bump `time_updated` | TUI/SDK usage 展示 | **不适用为 port**。依赖上游 SQL/Drizzle session store + migration；Aether 无对应存储（`Session` 在 `index.ts`，projector 非 SQL） | 当作可选产品功能；若需要则基于 Aether 存储原生实现，不 port migration | 不适用（非 bugfix） | 不适用 |

### 暂缓 / 跳过（不单列编号）

- **AI SDK v5→v6 迁移专项（阻塞一批 bump）**：`d16bfe850`（bedrock 4.x）、`61e7cdfbf`（google/vertex thought signatures）、`a5ba1d075`（venice，Aether 无此依赖）、`28dbd4ab4` + `87e9e700c`（google tool-id 回归 **pin 约束**：未来 v6 迁移须落在 `@ai-sdk/google ≤3.0.73` / `vertex ≤4.0.128`）、`e00a62e46` + `6c24062d2`（gitlab，Aether 用不同 packaging）、`4487fbf52`（xAI PDF，且 Aether `message-v2` 无 per-npm 附件 gate）。这些都因 v5/v6 代际差无法单独 bump。
- **`576480b5d`（mistral medium 3.5 variants）**：Aether `variants()` 的 `@ai-sdk/mistral` 直接 `return {}`，无 `MISTRAL_REASONING_IDS` 可扩展，上游改动对 Aether 是 no-op。keep-local。
- **`1cf8123bc`（GPT-5 reasoning variant helpers）、`c36ab3f93`（Gemini thinking controls helpers）、`e0396b809`（Opus 4.5 `{effort}` 分支）**：Aether 用内联 `iife` 策略，已覆盖常见档位；仅当 Aether 实际上架对应子模型（gpt-5-chat / codex-v3 / versioned-pro / gemini-3 flash-image|pro-image / Opus 4.5 新 effort API）时**选择性**回迁对应小分支，否则 keep-local。
- **`4e14f7951`（Bedrock 附件 per-mime 拆分半）**：Bedrock 图片可入 tool result、PDF 不可；仅当 Aether 服务 Bedrock 多模态 tool result 时回迁。
- **`799996db7`（TUI provider-specific retry 对话框）**：依赖上游 Effect `Retryable.action` 机制 + Go-upsell UX，Aether `retryable()` 返回纯字符串，结构不兼容。**跳过**。
- **`ca28dd02e`/`2d0d3d596`/`811954880`（compaction tail 保留）**：Aether 从未采用 `tail_start_id`，是「summarize + 可选 replay」模型，**不适用**。其中 `2d0d3d596` 的「summary 消息只贡献 text」一行守卫可作为廉价保险，价值低。
- **`748fcb7eb`（孤儿中断 tool 排除）、`e76cf967e`（finalize 中断 assistant）、`75d141b57`（取消子任务 session）**：上游 Effect 循环 / Effect interrupt 专属；Aether 的 plain-async 循环 + `SessionRecovery.repairSession` + `SessionPrompt.cancel` 已覆盖或使其失效。**仅需抽查**：`repairSession` 在 abort 后是否总会盖上 `time.completed` + aborted error；父 abort 是否传播到子 task session。

### ⚠️ 反向冲突（禁止回迁）

- **`2f2fcc165`/`#30127`（删除自动 full session diff）与 Aether `bafdfb6d2` 意图相反。** 上游让 `Session.diff` 返回 `[]`、`summarize` 不算 diff、改读 `message.info.summary?.diffs`、删 `Storage` 依赖；而 Aether `bafdfb6d2` 是**修好并保留**自动 diff（顺序无关指纹去重、`setSummary`/`Storage.write`/`Bus.publish` 一起 gate、`invalidate` 同步、`Session.Event.Deleted` 订阅）。Aether `summary.ts:92-191` 仍读写 `["session_diff", ...]` 并算 `Snapshot.diffFull`。**盲目回迁会删掉 `bafdfb6d2` 修好的机制、重新引入闪烁/陈旧并打断 review 面板。**
  - **05-04 快照（91 行历史版）未记录此项**：`bafdfb6d2` 与 `2f2fcc165` 仅在 `providerExecuted` 半不重叠；**`session.diff` 半是重叠且冲突的**，由本报告首次澄清。

---

## 对既有项（LLM-UP-001 ~ 015）的状态更新

- **LLM-UP-001（OpenAI-compatible dot provider key split）**：新增 `LLM-UP-022`（cf-ai-gateway `sdkKey`/variants）是同族延伸，**不重复**——001 是 dotted providerID 取首段，022 是 `ai-gateway-provider` 这个 npm → `openaiCompatible` key 映射 + variants 分支。
- **LLM-UP-004（5xx retry）**：措辞需收紧。`error.ts` 中**没有字面 `statusCode >= 500` 判断**；可重试性走 `parseAPICallError`→`isRetryable`/`isOpenAiErrorRetryable`（后者只额外加 404 + `e.isRetryable`）。语义大体成立但原文「已对 statusCode >= 500 放行」过度具体。另：`server_is_overloaded`（见 `LLM-UP-028`）当前**不会**被 Aether 逻辑捕获。
- **LLM-UP-012（Copilot GPT-5 variants）**：新增可选子项 `ae92f3158`（Copilot token-based billing，`copilot_usage.total_nano_aiu`）。纯 usage/metadata、不动 SDK、不影响 tool-call 解析。**未覆盖**且依赖上游 `session/llm/ai-sdk.ts` 架构，不可直接 port；如需 AIU 计费可见性，按概念在 Aether 自有 adapter 重实现，否则暂缓。
- **LLM-UP-013（Aether 本地兼容层）**：
  - `reasoningSummary` npm-guard **已与上游收敛**——上游 `7f7eb2e7f` 删掉 guard，Aether `transform.ts:891-894` 本就无 guard（无条件注入），两边一致。
  - LiteLLM `_noop` dummy tool 是**刻意 keep-local**：上游 `7f7eb2e7f` 以「LiteLLM ≥ v1.85.0-rc.2 已服务端修复」为前提删除了 LiteLLM 侧 `_noop`，但 Aether 面向常为旧 LiteLLM 或非 LiteLLM 的国内 OpenAI-compatible 网关，**必须保留**。注意 Aether `llm.ts:253-266` 的 `_noop` 是 **LiteLLM-only**，而当前上游保留的是 **Copilot-only**——两者恰好互为反向。若 Copilot chat 路径压缩时也撞「history 有 tool call 时必须带 tools」校验，可针对性给 Aether 条件补 `|| providerID.includes("github-copilot")`（与 LiteLLM 决策独立）。
  - 上游 `c7e1fc5e4`（SSE 可重试，见 `LLM-UP-027`）建立在 Aether 本地 SSE-timeout 层**之上**，互补非冲突；`headerTimeout`（`LLM-UP-029`）是相邻但不同的超时，需单独标记。
- **LLM-UP-015（Copilot V2 SDK 两缺陷）**：**确认永久 Aether-only**。上游 `28112fbd1..687c66248` 内 `provider/sdk/copilot/**` 无任何提交，且**上游根本没有 `provider/sdk/` 目录**——整套 Copilot SDK 是 Aether vendored，上游用 stock `@ai-sdk/github-copilot`。故首 delta `id` 严格抛错与 V2→V3 中间件失效永不会由上游修复。当前现状未变：`chat/openai-compatible-chat-language-model.ts:519-532` 仍严格抛 `InvalidResponseDataError`，`:54` 与 `responses/openai-responses-language-model.ts:132` 仍 `specificationVersion="v2"`。`memory_list` 等 chat 路径 tool 调用仍会 abort。**需 Aether 自行排期**：短期放宽首 delta 解析（id+name 同缺时占位等下帧），长期把 SDK 升到 `LanguageModelV3` 让 v6 中间件复生效。

---

## 优先回迁建议

**第一批（行为修复，不依赖 Effect/v6，当前确实未覆盖，已 grep 复核）：**

1. `LLM-UP-018` 双重自动压缩（P0，核心循环潜在 bug）
2. `LLM-UP-016` Opus 4.7+ `display:"summarized"` + 泛化检测（P0，用户可见 reasoning 丢失）
3. `LLM-UP-019` surrogate 清洗（P1，机械）
4. `LLM-UP-020` tools 排序（P1，机械，利于 cache）
5. `LLM-UP-017` 签名 reasoning 保留（P1，与 016 同属 Anthropic adaptive 可靠性）

**第二批（provider 专项小修，架构无关）：**

6. `LLM-UP-022` cf-ai-gateway key/variants（P1）
7. `LLM-UP-023` Azure Anthropic resolve（P1）
8. `LLM-UP-024` Azure gpt-5.5 completions（P1）
9. `LLM-UP-025` Vertex GoogleAuth scopes（P1）
10. `LLM-UP-027` 可重试 SSE 卡死（P1）
11. `LLM-UP-031` 直连 GPT-5 加密 reasoning include（P1）
12. `LLM-UP-021` 分层定价（P1/P2，成本准确性）

**第三批（小/触发面窄）：** `LLM-UP-026`、`LLM-UP-028`、`LLM-UP-029`（默认关）、`LLM-UP-030`、`LLM-UP-032`。

**专项 / 暂缓：** `LLM-UP-033`（native runtime）、`LLM-UP-034`（OpenAI WS）、`LLM-UP-035`（usage totals）、AI SDK v6 迁移、Copilot SDK（`LLM-UP-012`/`LLM-UP-015`）。

**禁止回迁：** `2f2fcc165`（与 `bafdfb6d2` 反向冲突）。

## 验收建议

第一批落地后从 package 目录运行：

```bash
cd /home/fyl/opencode/packages/opencode
bun typecheck
bun test test/provider/transform.test.ts
bun test test/session/message-v2.test.ts
bun test test/session/llm.test.ts
bun test test/session/retry.test.ts
bun test test/session/compaction.test.ts
```

声称修复真实 provider 时：

```bash
cd /home/fyl/opencode/packages/opencode
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider deepseek
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider alibaba-cn --input p1-reasoning --p1
# Opus 4.7+ adaptive（LLM-UP-016）、Azure Anthropic（LLM-UP-023）等需真实 provider 单独 smoke
```

## 结论

本轮窗口（`28112fbd1..687c66248`，220 个相关提交）上游主线是 Effect/`@opencode-ai/core`/SQL store/native-runtime/AI SDK v6 的架构迁移，**绝大多数无法逐行回迁**。但从中剥离出 **16 个值得跟进的行为差异点（`LLM-UP-016 ~ 031`）**，其中 5 个是当前确实未覆盖、架构无关、可立即作为第一批回迁的行为修复（`016/017/018/019/020`）。

同时确认了一处必须守住的反向冲突（`2f2fcc165` vs `bafdfb6d2`），并把 `LLM-UP-015`（Copilot SDK）定性为永久 Aether-only 自维护项。native runtime、OpenAI WS、usage totals、AI SDK v6 与 Copilot SDK 升级仍各自开专项评估。
