# LLM Upstream Registry

本文件保存 LLM upstream 差异项的稳定登记信息。当前状态以 [status.md](./status.md) 为准；不要在本文件维护活状态。

## Items

| ID | Priority | Upstream | Subject | Impact | Local note |
|----|----------|----------|---------|--------|------------|
| `LLM-UP-001` | P0 | `a12333310` / `#25145` | providerOptions key 对 OpenAI-compatible dot provider 做 split | OpenAI-compatible custom provider | 避免影响 xAI/Mistral/Groq 等硬编码 key |
| `LLM-UP-002` | P0 | `348a84969` / `#22646` | Anthropic assistant `tool-call` 后接 text/reasoning 时重排 | Anthropic、Vertex Anthropic | Anthropic 历史消息顺序敏感 |
| `LLM-UP-003` | P0 | `733a3bd03` / `#14973` | provider 返回 `stop` 但 assistant 含 tool call 时继续工具循环 | OpenAI-compatible | 保留 finish reason 归一逻辑 |
| `LLM-UP-004` | P0 | `4ca809ef4` / `#22511` | 5xx API error 即使 `isRetryable` 未置位也 retry | all providers | context overflow 仍不可重试 |
| `LLM-UP-005` | P0 | `29ec07700` / `#25303` | different-model reasoning 转普通 text | Bedrock、跨模型续聊 | 只在 `differentModel` 时生效 |
| `LLM-UP-006` | P0 | `86715fecc` / `#24180`、`923af96d2` / `#24146` | DeepSeek assistant 历史始终带 reasoning | DeepSeek、OpenAI-compatible interleaved reasoning | 必须保留国产 provider 参数策略 |
| `LLM-UP-007` | P0 | `e7053c41f` / `#24435` | OpenRouter provider SDK 升级修复 DeepSeek reasoning | OpenRouter DeepSeek | 需真实 provider smoke 复核 |
| `LLM-UP-008` | P0 | 多个 Azure PR，含 `#26222` | Azure providerOptions、store、prompt cache、reasoning defaults | Azure OpenAI | Aether 保留 `azure` namespace 策略 |
| `LLM-UP-009` | P0 | `280eb16e7` / `#21047`、`72c77d0e7` / `#19758` | reasoning/cache token 不重复计费，AI SDK v6 usage 归一 | Anthropic、Bedrock、OpenRouter、Venice | 真实 provider usage metadata 仍建议 smoke |
| `LLM-UP-010` | P1 | models.dev 相关 PR，含 `#27347` | `models.dev` 服务化、schema 拆分、移入 core | model metadata | 架构迁移噪音大，不整块回迁 |
| `LLM-UP-011` | P1 | `7230cd268` / `#22248` | Alibaba SDK 和 cache 支持 | Alibaba/DashScope | Aether 已有本地 DashScope/OpenAI-compatible thinking 策略 |
| `LLM-UP-012` | P1 | Copilot 相关 PR，含 `#25821` | Copilot GPT-5 variants 与 core/v2 provider 迁移 | GitHub Copilot | Copilot SDK 自维护成本高，独立专项 |
| `LLM-UP-013` | Local | diff-only | OpenAI-compatible、本地网关、proxy、SSE timeout 等本地兼容层 | OpenAI-compatible、LiteLLM、国内网关 | 回迁时必须保留 |
| `LLM-UP-014` | P2 | 多个架构迁移 commit | Provider/Session/Config Effect service 化、HttpApi 化 | architecture | 不作为 LLM bugfix 前置条件 |
| `LLM-UP-015` | P1/P2 | local-only + upstream `#25821` | Copilot V2 SDK chat delta 与 v6 middleware 失效 | GitHub Copilot chat | 短期修 delta，长期评估 V3/core |
| `LLM-UP-016` | P0 | `25ecf0af6` / `#25888` | `server_is_overloaded` stream error 按 server error retry | OpenAI-compatible、OpenAI、代理网关 | 影响流式错误重试 |
| `LLM-UP-017` | P0 | `ca77b8f8e` / `#25573` | Cloudflare AI Gateway `ai-gateway-provider` providerOptions 走 `openaiCompatible` | Cloudflare AI Gateway | 本地已有 Cloudflare loader |
| `LLM-UP-018` | P0 | `e76cf967e` / `#27254` | 中断时 finalize 空 assistant | Session prompt/cancel/tool loop | 当前结构不迁移上游 Effect harness |
| `LLM-UP-019` | P0 | `233fc5b91` / `#21370`、`4e14f7951` / `#26276` | Anthropic/Bedrock signed reasoning replay | Anthropic、Bedrock Claude、Vertex Anthropic | 空 separator 与 signed/redacted reasoning 位置敏感 |
| `LLM-UP-020` | P1 | `c36ab3f93` / `#26279` | Gemini thinking controls variant 细分 | Google Gemini、Vertex Gemini | 独立 provider transform 批次 |
| `LLM-UP-021` | P0/P1 | `967557979` / `#26222` | Azure `gpt-5.5` completions 不发送 `reasoningEffort` | Azure OpenAI | 不改变 `azure` namespace 策略 |
| `LLM-UP-022` | P1 | open PR `#26892` | strip non-latest assistant reasoning blocks to fix compaction | Compaction、reasoning replay | open PR 未稳定 |
| `LLM-UP-023` | P1/P2 | `36d40fee4` / `#26644` | session usage totals 落库与投影累计 | Session usage/statistics | 涉及 schema/migration/projector |
| `LLM-UP-024` | P1 | `ca28dd02e` / `#27145` | compaction summarization 后恢复 tail turns | Session compaction | 单独 compaction 语义批次 |
| `LLM-UP-025` | P1/P2 | `20cec9155` / `#27372`、`9818c9e8` / `#27405` | provider model suggestions 与 small model fallback | Provider lookup / small model | provider UX 专项 |
| `LLM-UP-026` | P0/P1 | `6409aceb1` / `#25934` | 清洗孤立 UTF-16 surrogate | all providers | 不改 image 等非文本内容 |
| `LLM-UP-027` | P0/P1 | `c1f607d20` / `#25721` | Azure SDK model selector fallback | Azure OpenAI、Azure Anthropic/兼容 SDK | 只改 SDK method selection |

## Local Compatibility Layer

这些能力不是上游等价行为，回迁时必须保护：

- OpenAI-compatible `includeUsage`。
- `max_tokens` 到 `max_completion_tokens` 转换。
- assistant reasoning part 到 `providerOptions.openaiCompatible.reasoning_content` / `reasoning_details` 的回灌。
- DashScope/Alibaba CN `enable_thinking`。
- ZAI/Zhipu `thinking.type = "enabled"` 与 `clear_thinking: false`。
- Kimi、Qwen、Minimax、GLM 等国内 provider 参数默认值。
- LiteLLM proxy 历史 tool call 触发 `_noop` 工具。
- HTTP proxy、SSE chunk timeout、自定义 baseURL、国内网关连接语义。

