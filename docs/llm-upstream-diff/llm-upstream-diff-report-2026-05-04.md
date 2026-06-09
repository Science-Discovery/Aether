# LLM 上游差异报告 2026-05-04

> **续期更新见 [`llm-upstream-diff-report-2026-06-02.md`](./llm-upstream-diff-report-2026-06-02.md)**（上游窗口 `28112fbd1..687c66248`，新增 `LLM-UP-016 ~ 035`）。本文件作为 05-04 历史快照保留，状态变化在续期报告的「对既有项的状态更新」一节说明。

## 基线

- 当前仓库：`/home/fyl/opencode`
- 上游仓库：`/home/fyl/tmp/opencode`
- 上游分支：`dev`
- 上游时间窗口：`2026-03-26` 之后进入 `dev` 的 LLM/session/provider/config/auth/package 相关提交

当前工作区已有变更未触碰：

- `packages/opencode/src/provider/models.ts`（已迁移至 `OPENCODE_MODELS_DEV` define 注入）
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/test/session/llm.test.ts`
- `docs/llm-upstream-diff-migration-plan.md`
- `aether-site/`

## 方法

本轮按 `docs/llm-upstream-diff-migration-plan.md` 的第 1 步执行，只生成报告，不改运行时代码。

已执行的分析：

- 对比当前仓库与上游 clone 的 `packages/opencode/src/session`、`packages/opencode/src/provider`、`packages/opencode/src/config` 的 no-index diff。
- 抽读高价值文件差异：`session/llm.ts`、`session/prompt.ts`、`session/retry.ts`、`provider/provider.ts`、`provider/transform.ts`、`provider/models.ts`。
- 扫描并抽查上游 `2026-03-26` 之后相关 commit，重点看 bugfix、provider 兼容、reasoning、tool call、usage、AI SDK/provider SDK bump。
- 对照当前 Aether 的本地兼容层和测试，避免把已覆盖或本地策略误判为待回迁。
- 在当前 HEAD `b2f150759` 复核 P0/P1 项，确认多项此前标为缺失的行为已经由现有工作区改动或本地实现覆盖。

## 候选项

| 编号 | 优先级 | 上游 commit/PR | 变更主题 | 影响 provider/model | 当前 Aether 状态 | 建议动作 | 风险 | 测试要求 | 验收命令 |
|------|--------|----------------|----------|---------------------|------------------|----------|------|----------|----------|
| LLM-UP-001 | P0 | `a12333310` / `#25145` | `providerOptions` key 对 OpenAI-compatible dot provider 做 split | OpenAI-compatible custom provider，如 `wafer.ai` | 已覆盖；`ProviderTransform.providerOptions` 已对 OpenAI-compatible/openai/anthropic dot providerID 取首段 | 已验证 | 继续避免影响 xAI/Mistral/Groq 等硬编码 key | 已有 dotted providerID 断言 | `cd packages/opencode && bun test test/provider/transform.test.ts` |
| LLM-UP-002 | P0 | `348a84969` / `#22646` | Anthropic assistant content 中 `tool-call` 后接 text/reasoning 时重排，避免 `tool_use` 未立即跟 `tool_result` | Anthropic、Google Vertex Anthropic | 已覆盖；`ProviderTransform.message` 已拆分 `[tool-call, text/reasoning]`，`message-v2.ts` 已处理 pending/running tool | 已验证 | Anthropic 历史消息顺序敏感，需避免影响非 Anthropic provider | 已有 transform 与 pending/running tool 回归测试 | `cd packages/opencode && bun test test/provider/transform.test.ts test/session/message-v2.test.ts` |
| LLM-UP-003 | P0 | `733a3bd03` / `#14973` | provider 返回 `stop` 但 assistant 含 tool call 时继续工具循环 | OpenAI-compatible | 已覆盖；`LLM.stream` middleware 已将含 tool call 的 `stop/unknown` 归一为 `tool-calls` | 已验证 | 后续改 streaming middleware 时需保留该归一化 | 已有 fake endpoint 覆盖 finish=`stop` 且含 tool call 的继续执行 | `cd packages/opencode && bun test test/session/llm.test.ts` |
| LLM-UP-004 | P0 | `4ca809ef4` / `#22511` | 5xx API error 即使 `isRetryable` 未置位也应 retry | 所有 provider | 已覆盖；`SessionRetry.retryable` 已对 `statusCode >= 500` 放行，并保留 context overflow 不重试 | 已验证 | 可能增加真实 5xx 重试次数，符合上游修复语义 | 已有 retryable 5xx/4xx/context overflow 断言 | `cd packages/opencode && bun test test/session/retry.test.ts` |
| LLM-UP-005 | P0 | `29ec07700` / `#25303` | 不同模型间转换 reasoning part 时改为普通 text，修复 Bedrock reasoning 问题 | Bedrock、跨模型继续对话/切模型 | 已覆盖；`MessageV2.toModelMessages` 已在 `differentModel` 时把非空 reasoning 转 text 并丢弃空 reasoning | 已验证 | 跨模型 reasoning 转 text 只应在 `differentModel` 时生效 | 已有 different-model reasoning 转 text 断言 | `cd packages/opencode && bun test test/session/message-v2.test.ts` |
| LLM-UP-006 | P0 | `86715fecc` / `#24180`、`923af96d2` / `#24146` | DeepSeek assistant 历史始终带 reasoning，并保留空 `reasoning_content` | DeepSeek V4 thinking、OpenAI-compatible interleaved reasoning | 已覆盖；DeepSeek assistant 会补空 reasoning，并通过 interleaved 回灌为空 `reasoning_content` | 已验证 | Aether 本地 DashScope/ZAI/Kimi/GLM 逻辑必须继续保留 | 已有 DeepSeek 非空与空 reasoning_content 断言 | `cd packages/opencode && bun test test/provider/transform.test.ts` |
| LLM-UP-007 | P0 | `e7053c41f` / `#24435` | 升级 `@openrouter/ai-sdk-provider` 修复 DeepSeek reasoning，并跳过本地 interleaved 回灌 | OpenRouter DeepSeek | 已升级；随 AI SDK v6 专项升到 `@openrouter/ai-sdk-provider@2.9.0`，删除旧 `1.5.4` patch | 已迁移，待真实 smoke | 新 OpenRouter reasoning 需真实 provider 验证；旧 patch 不能直接套用到 2.x | 本地 typecheck/provider/transform/LLM/Copilot 测试已通过；仍建议 OpenRouter/DeepSeek smoke | `cd packages/opencode && bun typecheck`，再按系统 smoke 文档跑 OpenRouter/DeepSeek |
| LLM-UP-008 | P0 | `9965d385d` / `#20272`、`c5deeee8c` / `#22764`、`cb18f2ef4` / `#22957`、`a740d2c66` / `#25007` | Azure providerOptions、`store`、prompt cache、reasoning defaults 对齐 OpenAI | Azure OpenAI | 大多已覆盖；当前测试已有 Azure chat/responses reasoning scrub，当前 `providerOptions` 保留 `azure` key；但与上游“双写 openai+azure”策略不同 | 已覆盖，保留本地策略 | 上游双写可能与当前测试“azure 不 remap 到 openai”冲突 | 不回迁代码；只在后续 Azure 真实失败时重评 | `cd packages/opencode && bun test test/provider/transform.test.ts` |
| LLM-UP-009 | P0 | `280eb16e7` / `#21047`、`72c77d0e7` / `#19758` | reasoning/cache token 不重复计费，Anthropic/Bedrock AI SDK v6 usage 归一 | Anthropic、Bedrock、OpenRouter、Venice | 已重评；AI SDK 已升到 `6.0.174`，现有 `Session.getUsage` 归一逻辑通过 v6 本地测试 | 已验证 | 真实 provider usage metadata 仍建议 smoke 复核，尤其 OpenRouter/Bedrock | 保留 usage/compaction 单测；真实 provider 再跑 smoke | `cd packages/opencode && bun test test/session/compaction.test.ts test/session/compaction-flow.test.ts` |
| LLM-UP-010 | P1 | `f8738c900` / `#25434`、`23c865608` / `#20605`、`fff98636f` / `#20929` | `models.dev` 服务化、schema 拆分、删除/弱化 snapshot | models.dev 元数据加载 | **已迁移**；Aether 已将 `models-snapshot.js` 运行时 import 改为构建期 `OPENCODE_MODELS_DEV` define 注入，同时回迁了 hash 分文件、原子写入、TTL 防抖等 cache 行为 | 已完成 | 回迁涉及面小且已按迁移方案执行 | `bun typecheck` + `bun test test/provider/` | `cd packages/opencode && bun typecheck && bun test test/provider/` |
| LLM-UP-011 | P1 | `7230cd268` / `#22248` | 新增 Alibaba SDK 和 cache 支持 | Alibaba/DashScope | Aether 已有本地 DashScope/OpenAI-compatible `enable_thinking` 与国产模型参数策略 | 已覆盖，保留本地策略 | 上游改为官方 SDK 可能破坏 Aether 国内网关语义 | 用现有 alibaba-cn smoke 验证 | `cd packages/opencode && OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider alibaba-cn --input p1-reasoning --p1` |
| LLM-UP-012 | P1 | `0acac216a` / `#24734`、`610c036ef` / `#22824`、Copilot SDK diff | Copilot GPT-5 variants、低 reasoning effort、Responses API 细节 | GitHub Copilot GPT-5 | 部分已有；当前有 Copilot SDK 和测试，但上游 Copilot SDK 有细节差异 | 暂缓，单独评估 Copilot | Copilot SDK 自维护成本高，不能混在 provider 通用回迁里 | 跑 `test/provider/copilot/**`，必要时补 GPT-5 variant cases | `cd packages/opencode && bun test test/provider/copilot` |
| LLM-UP-013 | Local | diff-only | OpenAI-compatible `includeUsage`、`max_tokens` 到 `max_completion_tokens`、reasoning 回灌、LiteLLM `_noop`、SSE timeout、HTTP proxy | OpenAI-compatible、LiteLLM、国内网关 | Aether 本地能力，上游没有等价或策略不同 | 必须保留 | 回迁上游 `provider.ts`/`transform.ts` 时最容易被覆盖 | 保留现有 provider/transform/LLM smoke 测试 | `cd packages/opencode && bun test test/provider/provider.test.ts test/provider/transform.test.ts test/session/llm.test.ts` |
| LLM-UP-014 | P2 | 多个 Effect/HttpApi/config 拆分 commit，如 `3df18dcde`、`e8471256f`、`ee7339f2c`、`93940a185` | Provider/Session/Config Effect service 化、HttpApi 化、module barrel 删除 | 架构层 | 与本轮 LLM 行为修复耦合低 | 放弃本轮回迁 | 大面积覆盖会吞掉 Aether 本地改动，且测试面过大 | 不做 | 不适用 |
| LLM-UP-015 | P1 | local-only（`provider/sdk/copilot/**`，引入自 `d9f18e400`；触发面疑似随 `2046ce0d6` 工具工厂迁移变大） | Copilot V2 SDK 两处缺陷：① `chat/openai-compatible-chat-language-model.ts` 对首个 tool-call delta 缺 `id` 的解析过严，抛 `InvalidResponseDataError: Expected 'id' to be a string.`（OpenAI-compatible 协议允许后续 chunk 才补 id/name，是 SDK 实现的兼容缺陷）；② SDK 整体仍实现 `LanguageModelV2`，AI SDK v6 `streamText` 因 `specificationVersion: "v3"` 跳过 `wrapLanguageModel`，`ProviderTransform.message` 与 finish-reason 归一对 Copilot chat 路径不生效（已在 `session/llm.ts` 注释存档） | GitHub Copilot chat 路径（非 Responses） | 未覆盖；触发后会直接中断 tool 调用（如 `memory_list`） | 短期：放宽 chat 首 delta 解析——id/name 同时缺失时占位等下一帧，仅在半残（id 与 name 仅缺其一）时仍抛；长期：把 Copilot SDK 升到 `LanguageModelV3`，让 v6 中间件重新覆盖该路径 | 短期改动需保证不破坏现有 chat 单测；V3 迁移涉及面大、需独立专项 | 复现 chat 路径 tool-call streaming 即可触发；补 chat 适配器单测覆盖"首 delta 仅含 index"分支 | `cd packages/opencode && bun test test/provider/copilot` |

## 优先回迁建议

当前 HEAD 复核后，第一批 P0 行为已经由现有工作区实现或本地实现覆盖：

1. `LLM-UP-001` 到 `LLM-UP-006`：标记为已覆盖并已用本地测试验证。
2. `LLM-UP-007`：已随 AI SDK v6 专项升级迁移，仍建议真实 OpenRouter/DeepSeek smoke。
3. `LLM-UP-008`：维持已覆盖并保留本地 Azure 策略。
4. `LLM-UP-009`：已随 AI SDK v6 专项重评，usage/compaction 本地测试通过。
5. `LLM-UP-010` 到 `LLM-UP-012`：P1 保持专项评估或本地策略优先，不做本轮代码回迁。

`LLM-UP-007` 不建议进入第一批，因为它牵涉 `@openrouter/ai-sdk-provider`、AI SDK peer dependency、`bun.lock` 和现有 patch。应作为依赖升级专项处理。

## 验收建议

第一批 P0 复核后从 package 目录运行：

```bash
cd /home/fyl/opencode/packages/opencode
bun typecheck
bun test test/provider/transform.test.ts
bun test test/session/message-v2.test.ts
bun test test/session/retry.test.ts
bun test test/session/llm.test.ts
```

若声称修复真实 provider：

```bash
cd /home/fyl/opencode/packages/opencode
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider deepseek
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider alibaba-cn --input p1-reasoning --p1
OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider minimax-cn
```

## 结论

当前仓库与上游 `dev` 的 LLM call chain 差异主要由上游 Effect/HttpApi 架构迁移、AI SDK v6/provider SDK 升级和少量真实 provider bugfix 混合造成。本轮不应整块覆盖上游文件。
