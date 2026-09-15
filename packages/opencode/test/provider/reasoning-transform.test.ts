import { describe, expect, test } from "bun:test"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProviderTransform } from "../../src/provider/transform"

function model(npm: string, provider = "custom", id = "future-model"): Provider.Model {
  return {
    id: ModelID.make(id),
    providerID: ProviderID.make(provider),
    api: { id, npm, url: "https://api.example.com" },
    name: id,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 100_000, output: 10_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-09-01",
  }
}

describe("catalogue reasoning adapters", () => {
  test.each([
    ["@ai-sdk/openai-compatible", { reasoningEffort: "high" }],
    ["@openrouter/ai-sdk-provider", { reasoning: { effort: "high" } }],
    ["@ai-sdk/google", { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } }],
    ["@ai-sdk/amazon-bedrock", { reasoningConfig: { type: "enabled", maxReasoningEffort: "high" } }],
    ["@ai-sdk/openai", { reasoningEffort: "high", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }],
  ] as const)("maps catalogue effort for %s", (npm, expected) => {
    expect(ProviderTransform.reasoning(model(npm), [{ type: "effort", values: ["high"] }])).toEqual({ high: expected })
  })

  test("enables DeepSeek thinking without recognizing a model name", () => {
    expect(
      ProviderTransform.reasoning(model("@ai-sdk/openai-compatible", "deepseek"), [
        { type: "toggle" },
        { type: "effort", values: ["low", "max"] },
      ]),
    ).toEqual({
      low: { thinking: { type: "enabled" }, reasoningEffort: "low" },
      max: { thinking: { type: "enabled" }, reasoningEffort: "max" },
    })
  })

  test("normalizes null effort to the disabled DeepSeek variant", () => {
    expect(
      ProviderTransform.reasoning(model("@ai-sdk/openai-compatible", "deepseek"), [
        { type: "effort", values: [null, "high"] },
      ])?.none,
    ).toEqual({ thinking: { type: "disabled" } })
  })

  test("distinguishes missing metadata, explicit empty controls and unsupported SDKs", () => {
    expect(ProviderTransform.reasoning(model("@ai-sdk/openai"), undefined)).toBeUndefined()
    expect(ProviderTransform.reasoning(model("@ai-sdk/openai"), [])).toEqual({})
    expect(ProviderTransform.reasoning(model("@ai-sdk/openai"), [{ type: "effort", values: [] }])).toEqual({})
    expect(
      ProviderTransform.reasoning(model("@ai-sdk/mistral"), [{ type: "effort", values: ["high"] }]),
    ).toBeUndefined()
  })

  test.each([
    ["@ai-sdk/anthropic", "xhigh"],
    ["@ai-sdk/amazon-bedrock", "xhigh"],
    ["@ai-sdk/google", "max"],
    ["@ai-sdk/groq", "max"],
    ["@ai-sdk/xai", "medium"],
  ] as const)("omits values rejected by the installed %s SDK", (npm, value) => {
    expect(ProviderTransform.reasoning(model(npm), [{ type: "effort", values: [value] }])).toEqual({})
    expect(
      Object.keys(ProviderTransform.reasoning(model(npm), [{ type: "effort", values: [value, "high"] }])!),
    ).toEqual(["high"])
  })

  test("retains Opus 4.5 thinking while using catalogue effort names", () => {
    const result = ProviderTransform.reasoning(model("@ai-sdk/anthropic", "anthropic", "claude-opus-4-5"), [
      { type: "effort", values: ["low", "medium", "high"] },
      { type: "budget_tokens", min: 1024 },
    ])
    expect(Object.keys(result!)).toEqual(["low", "medium", "high"])
    expect(result?.low).toEqual({ thinking: { type: "enabled", budgetTokens: 4999 }, effort: "low" })
  })

  test("allows medium for the official xAI Responses route", () => {
    expect(ProviderTransform.reasoning(model("@ai-sdk/xai", "xai"), [{ type: "effort", values: ["medium"] }])).toEqual({
      medium: { reasoningEffort: "medium" },
    })
  })

  test("retains adaptive thinking settings", () => {
    expect(
      ProviderTransform.reasoning(model("@ai-sdk/anthropic", "anthropic", "claude-opus-4-6"), [
        { type: "effort", values: ["low", "high"] },
      ])?.low,
    ).toEqual({ thinking: { type: "adaptive" }, effort: "low" })
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/gateway"])(
    "applies catalogue budget bounds alongside effort through %s",
    (npm) => {
      const result = ProviderTransform.reasoning(model(npm, "custom", "anthropic/claude-opus-4-5"), [
        { type: "effort", values: ["low"] },
        { type: "budget_tokens", min: 1024, max: 4096 },
      ])
      expect(result?.low).toEqual(
        npm === "@ai-sdk/amazon-bedrock"
          ? { reasoningConfig: { type: "enabled", budgetTokens: 4096, maxReasoningEffort: "low" } }
          : { thinking: { type: "enabled", budgetTokens: 4096 }, effort: "low" },
      )
    },
  )

  test("retains Bedrock Anthropic thinking with catalogue effort", () => {
    expect(
      ProviderTransform.reasoning(model("@ai-sdk/amazon-bedrock", "amazon-bedrock", "anthropic.claude-opus-4-5"), [
        { type: "effort", values: ["low"] },
      ])?.low,
    ).toEqual({ reasoningConfig: { type: "enabled", budgetTokens: 9999, maxReasoningEffort: "low" } })
  })

  test("retains DashScope GLM disable switches and clears its default budget", () => {
    expect(
      ProviderTransform.reasoning(model("@ai-sdk/openai-compatible", "alibaba-cn", "glm-5.2"), [
        { type: "effort", values: ["none", "high"] },
      ]),
    ).toEqual({
      none: {
        enable_thinking: false,
        thinking_budget: undefined,
        reasoningEffort: undefined,
        reasoning_effort: undefined,
      },
      high: { enable_thinking: true, reasoningEffort: "high" },
    })
  })

  test("respects catalogue budget bounds and output limits", () => {
    expect(
      ProviderTransform.reasoning(model("@ai-sdk/anthropic"), [{ type: "budget_tokens", min: 6000, max: 8000 }]),
    ).toEqual({
      high: { thinking: { type: "enabled", budgetTokens: 6000 } },
      max: { thinking: { type: "enabled", budgetTokens: 8000 } },
    })
    expect(
      ProviderTransform.reasoning(model("@ai-sdk/anthropic"), [{ type: "budget_tokens", max: 20000 }])?.max,
    ).toEqual({
      thinking: { type: "enabled", budgetTokens: 9999 },
    })
    expect(ProviderTransform.reasoning(model("@ai-sdk/anthropic"), [{ type: "budget_tokens", min: 10000 }])).toEqual({})
  })

  test("combines Cohere toggle and budget controls", () => {
    expect(
      ProviderTransform.reasoning(model("@ai-sdk/cohere"), [{ type: "toggle" }, { type: "budget_tokens", max: 4096 }]),
    ).toEqual({
      none: { thinking: { type: "disabled" } },
      high: { thinking: { type: "enabled", tokenBudget: 2048 } },
      max: { thinking: { type: "enabled", tokenBudget: 4096 } },
    })
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/gateway"])(
    "does not generate budgets below the Anthropic minimum through %s",
    (npm) => {
      expect(
        ProviderTransform.reasoning(model(npm, "custom", "anthropic/claude-future"), [
          { type: "budget_tokens", max: 512 },
        ]),
      ).toEqual({})
    },
  )

  test("falls back when the SDK cannot transmit a token budget", () => {
    expect(ProviderTransform.reasoning(model("@ai-sdk/openai"), [{ type: "budget_tokens", max: 4096 }])).toBeUndefined()
    expect(
      ProviderTransform.reasoning(model("@ai-sdk/amazon-bedrock"), [{ type: "budget_tokens", max: 4096 }]),
    ).toBeUndefined()
  })
})
