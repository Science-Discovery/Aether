# LLM Upstream Session Brief

Last updated: 2026-05-14

- Current source of truth: [status.md](./status.md)
- Detailed registry: [registry.md](./registry.md)
- Process rules: [playbook.md](./playbook.md)
- Historical audit: [archive/2026-05-04-report.md](./archive/2026-05-04-report.md)

## Current Snapshot

本仓库已完成当前已知 P0/P0-P1 LLM API 调用链回迁：

- `LLM-UP-016` stream error retry：`server_error` / `server_is_overloaded` 会进入 retry 路径。
- `LLM-UP-017` Cloudflare AI Gateway：`ai-gateway-provider` providerOptions 进入 `openaiCompatible`。
- `LLM-UP-018` cancel/finalize：prompt cancel 后不会留下未完成 assistant poison message。
- `LLM-UP-019` signed reasoning replay：Anthropic/Bedrock signed/redacted reasoning 形态已覆盖。
- `LLM-UP-021` Azure `gpt-5.5` completions：不发送 `reasoningEffort`。
- `LLM-UP-026` surrogate sanitization：模型可见文本会清洗孤立 UTF-16 surrogate。
- `LLM-UP-027` Azure model selector：`responses` 缺失时 fallback 到 `messages` / `chat` / `languageModel`。

不要重复实现这些项；如需确认行为，优先读对应测试和 [status.md](./status.md)。

## Active Queue

| ID | Priority | Target | Next action | Tests |
|----|----------|--------|-------------|-------|
| `LLM-UP-020` | P1 | Gemini thinking controls | 独立 provider variant 批次处理 | `test/provider/transform.test.ts` + real smoke |
| `LLM-UP-024` | P1 | compaction tail restore | 放入 compaction 专项 | `test/session/compaction.test.ts`、`test/session/compaction-flow.test.ts` |
| `TOOL-ORDER` | P1 | tool ordering stability | 对齐上游工具顺序语义 | session/tool tests |
| `SUBTASK-CANCEL` | P1 | child session cancel | 对齐子任务取消行为 | session/subtask tests |
| `LLM-UP-015` | P1/P2 | Copilot V2 SDK | 独立 Copilot 专项，不混入 LLM P0 | `test/provider/copilot` |

## Do Not Disturb

- 不整块搬上游 `llm.ts`、`provider.ts`、`transform.ts`。
- 不破坏 Aether 本地兼容层：OpenAI-compatible reasoning 回灌、国内 provider 参数、HTTP proxy、SSE timeout、LiteLLM `_noop`。
- Azure providerOptions 继续保留 `azure` namespace，不 remap 到 `openai`。
- `models.dev` 服务化、Effect/HttpApi 架构迁移、Copilot core/v2 迁移都要单独专项。
- 真实 provider smoke 不是本地验收 blocker，但 PR 描述必须写明是否执行。

## Verification

Run from `packages/opencode`:

```bash
bun typecheck
bun test test/provider/provider.test.ts test/provider/transform.test.ts test/provider/cf-ai-gateway-e2e.test.ts test/session/message-v2.test.ts test/session/retry.test.ts test/session/llm.test.ts test/session/prompt.test.ts
```

真实 provider 风险点建议额外 smoke：

- Azure `gpt-5.5` completions/chat。
- Cloudflare AI Gateway。
- Anthropic/Bedrock signed reasoning replay。
- OpenAI stream overload retry。

