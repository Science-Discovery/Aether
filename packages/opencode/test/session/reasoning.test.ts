import { expect, test } from "bun:test"
import type { ModelsDev } from "../../src/provider/models"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"
import { reply, stream } from "../lib/llm"

const cases: {
  provider: string
  npm: string
  id: string
  controls: NonNullable<ModelsDev.Model["reasoning_options"]>
  options: Record<string, unknown>
  variant?: string
  variants?: string[]
  source?: string
  expected: Record<string, unknown>
}[] = [
  ...["none", "low", "high", "max", undefined].map((variant) => ({
    provider: "deepseek",
    npm: "@ai-sdk/openai-compatible",
    id: "deepseek-flash",
    controls: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }] satisfies NonNullable<
      ModelsDev.Model["reasoning_options"]
    >,
    options: variant === "none" ? { reasoningEffort: "high" } : {},
    variant,
    variants: ["none", "low", "high", "max"],
    source: "model",
    expected: {
      model: "deepseek-flash",
      reasoning_effort: variant === "none" ? undefined : variant,
      reasoningEffort: undefined,
      thinking: variant ? { type: variant === "none" ? "disabled" : "enabled" } : undefined,
    },
  })),
  {
    provider: "moonshotai",
    npm: "@ai-sdk/openai-compatible",
    id: "kimi-k3",
    controls: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
    options: { thinking: { type: "disabled" } },
    variant: "high",
    expected: { thinking: { type: "enabled" }, reasoning_effort: "high" },
  },
  {
    provider: "alibaba",
    npm: "@ai-sdk/openai-compatible",
    id: "qwen3.8-max",
    controls: [{ type: "toggle" }, { type: "effort", values: ["xhigh"] }],
    options: { enable_thinking: false },
    variant: "xhigh",
    expected: { enable_thinking: true, reasoning_effort: "xhigh" },
  },
  {
    provider: "openrouter",
    npm: "@openrouter/ai-sdk-provider",
    id: "qwen/qwen3.8-27b",
    controls: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "xhigh"] }],
    options: { reasoning: { enabled: false } },
    variant: "low",
    expected: { reasoning: { enabled: true, effort: "low" } },
  },
  {
    provider: "openrouter",
    npm: "@openrouter/ai-sdk-provider",
    id: "qwen/qwen3.7-flash",
    controls: [{ type: "toggle" }, { type: "budget_tokens", max: 4096 }],
    options: { reasoning: { enabled: false } },
    variant: "high",
    expected: { reasoning: { enabled: true, max_tokens: 2048 } },
  },
  {
    provider: "openrouter",
    npm: "@openrouter/ai-sdk-provider",
    id: "future-model",
    controls: [{ type: "toggle" }, { type: "effort", values: ["none", "low"] }],
    options: { reasoning: { enabled: true, effort: "high", max_tokens: 2048 } },
    variant: "none",
    expected: { reasoning: { enabled: false } },
  },
]

test.each(cases.flatMap((item) => (item.source ? [item] : ["model", "agent"].map((source) => ({ ...item, source })))))(
  "applies $provider $id $variant over $source thinking defaults",
  async (item) => {
    const requests: Record<string, unknown>[] = []
    const server = await serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
        requests.push(await req.json())
        return reply("chat")
      },
    })
    try {
      await using tmp = await tmpdir({
        config: {
          enabled_providers: [item.provider],
          provider: {
            [item.provider]: {
              npm: item.npm,
              options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` },
              models: {
                [item.id]: {
                  name: item.id,
                  reasoning: true,
                  tool_call: true,
                  limit: { context: 100_000, output: 10_000 },
                  options: item.source === "model" ? item.options : {},
                  reasoning_options: item.controls,
                },
              },
            },
          },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const model = await Provider.getModel(ProviderID.make(item.provider), ModelID.make(item.id))
          if (item.variants) expect(Object.keys(model.variants ?? {})).toEqual(item.variants)
          expect(await stream(model, item.variant, item.source === "agent" ? item.options : {})).toBe("Hello")
          expect(requests).toHaveLength(1)
          Object.entries(item.expected).forEach(([key, value]) => expect(requests[0][key]).toEqual(value))
        },
      })
    } finally {
      server.stop(true)
    }
  },
)
