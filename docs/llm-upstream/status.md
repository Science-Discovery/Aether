# LLM Upstream Status

Last updated: 2026-05-15

本文件是 LLM upstream 回迁当前状态的唯一事实源。历史报告中的旧状态只代表当时判断，不代表当前状态。

## Current Queue

| ID | Priority | Status | Area | Current truth | Next action | Verification |
|----|----------|--------|------|---------------|-------------|--------------|
| `LLM-UP-001` | P0 | done | providerOptions | dotted OpenAI-compatible providerID namespace 已覆盖 | 不重复处理 | `bun test test/provider/transform.test.ts` |
| `LLM-UP-002` | P0 | done | Anthropic tool order | assistant `tool-call` 后接 text/reasoning 的顺序修复已覆盖 | 保留现有 transform 测试 | `bun test test/provider/transform.test.ts test/session/message-v2.test.ts` |
| `LLM-UP-003` | P0 | done | tool loop | provider 返回 `stop` 但含 tool call 时会继续工具循环 | 保留 middleware 归一逻辑 | `bun test test/session/llm.test.ts` |
| `LLM-UP-004` | P0 | done | retry | 5xx APIError 可重试，context overflow 不重试 | 不重复处理 | `bun test test/session/retry.test.ts` |
| `LLM-UP-005` | P0 | done | Bedrock reasoning | different-model reasoning 转 text 已覆盖 | 不重复处理 | `bun test test/session/message-v2.test.ts` |
| `LLM-UP-006` | P0 | done | DeepSeek reasoning | DeepSeek 空/非空 reasoning_content 回灌已覆盖 | 不重复处理 | `bun test test/provider/transform.test.ts` |
| `LLM-UP-007` | P0 | done | OpenRouter | 已随 AI SDK v6/provider SDK 升级迁移，本地测试通过 | 建议真实 OpenRouter/DeepSeek smoke | `bun typecheck` + provider smoke |
| `LLM-UP-008` | P0 | done | Azure | Azure providerOptions 本地策略保留；`gpt-5.5` completions 见 `LLM-UP-021` | 不整块回迁上游 Azure 双写策略 | `bun test test/provider/transform.test.ts` |
| `LLM-UP-009` | P0 | done | usage | AI SDK v6 usage 归一已重评，本地测试通过 | 建议 OpenRouter/Bedrock smoke | `bun test test/session/compaction.test.ts test/session/compaction-flow.test.ts` |
| `LLM-UP-010` | P1 | deferred | models.dev | 上游已进一步 core 包化，当前 Aether 保留 snapshot | 只抽取具体模型能力字段，不做架构迁移 | 不适用 |
| `LLM-UP-011` | P1 | done | Alibaba/DashScope | Aether 本地 DashScope/OpenAI-compatible thinking 策略已覆盖 | 用 alibaba-cn smoke 复核 | `OPENCODE_SYSTEM_TEST=1 bun run test:system:llm:p0 -- --provider alibaba-cn --input p1-reasoning --p1` |
| `LLM-UP-012` | P1 | deferred | Copilot variants | 上游 Copilot core/v2 与本地结构差异大 | 独立 Copilot 专项 | `bun test test/provider/copilot` |
| `LLM-UP-013` | Local | watch | local compatibility | Aether 本地兼容层必须保留 | 回迁 provider/session 代码时先检查 | `bun test test/provider/provider.test.ts test/provider/transform.test.ts test/session/llm.test.ts` |
| `LLM-UP-014` | P2 | deferred | architecture | Effect/HttpApi/模块拆分不进入 LLM 行为回迁 | 不做 | 不适用 |
| `LLM-UP-015` | P1/P2 | open | Copilot V2 SDK | chat 首个 tool-call delta 缺 `id` 仍是独立风险 | 短期放宽 chat delta 解析，长期评估 V3/core | `bun test test/provider/copilot` |
| `LLM-UP-016` | P0 | done | stream retry | `server_error` / `server_is_overloaded` 已转 retryable APIError | 不重复处理 | `bun test test/session/message-v2.test.ts test/session/retry.test.ts` |
| `LLM-UP-017` | P0 | done | Cloudflare AI Gateway | `ai-gateway-provider` 已映射到 `openaiCompatible` | 建议真实 Cloudflare smoke | `bun test test/provider/transform.test.ts test/provider/cf-ai-gateway-e2e.test.ts` |
| `LLM-UP-018` | P0 | done | cancel/finalize | prompt cancel mid-stream 会写 `MessageAbortedError` 与 `time.completed` | 不迁移上游 Effect harness | `bun test test/session/prompt.test.ts` |
| `LLM-UP-019` | P0 | done | signed reasoning | Anthropic separator 与 Anthropic/Bedrock 空 signed/redacted reasoning 已覆盖 | 建议真实 Anthropic/Bedrock smoke | `bun test test/session/message-v2.test.ts test/provider/transform.test.ts` |
| `LLM-UP-020` | P1 | open | Gemini thinking | 基础 `thinkingConfig` 已有，Gemini 2.5/3 variant 不完整 | 独立 provider transform/Gemini 批次 | `bun test test/provider/transform.test.ts` |
| `LLM-UP-021` | P0/P1 | done | Azure gpt-5.5 | Azure completions 不发送 `reasoningEffort`，保留 `azure` namespace | 建议真实 Azure smoke | `bun test test/provider/transform.test.ts` |
| `LLM-UP-022` | P1 | watch | compaction reasoning | 上游 open PR 风险信号，未稳定 | 等上游合并后再抽行为 | 不适用 |
| `LLM-UP-023` | P1/P2 | deferred | usage totals | schema/projector 影响大，不属于当前 LLM P0 | usage UI/统计专项再评估 | 不适用 |
| `LLM-UP-024` | P1 | open | compaction tail | 重要但属于 compaction 语义批次 | 单独评估 tail restore | `bun test test/session/compaction.test.ts test/session/compaction-flow.test.ts` |
| `LLM-UP-025` | P1/P2 | deferred | provider UX | provider model suggestions / fallback 韧性不是调用链 P0 | provider UX 专项处理 | `bun test test/provider/provider.test.ts` |
| `LLM-UP-026` | P0/P1 | done | text sanitization | 模型可见文本孤立 surrogate 已清洗 | 不重复处理 | `bun test test/provider/transform.test.ts` |
| `LLM-UP-027` | P0/P1 | done | Azure selector | Azure model selector 已 fallback 到 `messages` / `chat` / `languageModel` | 不重复处理 | `bun test test/provider/provider.test.ts` |
| `LLM-UP-028` | P0 | done | Anthropic 4.7 thinking | Claude Opus 4.7 variants 已改为 `thinking.type="adaptive"` + effort，避免发送旧 `enabled` budget | 建议真实 Anthropic smoke | `bun test test/provider/transform.test.ts` |
| `TOOL-ORDER` | P1 | open | tool stability | 上游 tools 排序稳定性候选未回迁 | 与 tool/subtask 专项一起处理 | session/tool tests |
| `SUBTASK-CANCEL` | P1 | open | subtask cancel | subtask child session cancel 候选未回迁 | 与 tool/subtask 专项一起处理 | session/subtask tests |

## Current Verification

Run from `packages/opencode`:

```bash
bun typecheck
bun test test/provider/provider.test.ts test/provider/transform.test.ts test/provider/cf-ai-gateway-e2e.test.ts test/session/message-v2.test.ts test/session/retry.test.ts test/session/llm.test.ts test/session/prompt.test.ts
```
