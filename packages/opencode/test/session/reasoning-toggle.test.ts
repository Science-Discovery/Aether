import { expect, test } from "bun:test"
import type { Agent } from "../../src/agent/agent"
import type { ModelsDev } from "../../src/provider/models"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { LLM } from "../../src/session/llm"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

const cases: {
  provider: string
  npm: string
  id: string
  controls: NonNullable<ModelsDev.Model["reasoning_options"]>
  options: Record<string, unknown>
  variant: string
  expected: Record<string, unknown>
}[] = [
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

test.each(cases.flatMap((item) => ["model", "agent"].map((source) => ({ ...item, source }))))(
  "applies $provider $id $variant over $source thinking defaults",
  async (item) => {
    const requests: Record<string, unknown>[] = []
    const server = await serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
        requests.push(await req.json())
        return new Response(
          [
            `data: ${JSON.stringify({ id: "chat-1", choices: [{ delta: { role: "assistant", content: "Hello" } }] })}`,
            `data: ${JSON.stringify({ id: "chat-1", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
            "data: [DONE]",
            "",
            "",
          ].join("\n\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        )
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
          const session = SessionID.make("session-reasoning-toggle")
          const agent = {
            name: "test",
            mode: "primary",
            options: item.source === "agent" ? item.options : {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          const stream = await LLM.stream({
            user: {
              id: MessageID.make("user-reasoning-toggle"),
              sessionID: session,
              role: "user",
              time: { created: Date.now() },
              agent: agent.name,
              model: { providerID: model.providerID, modelID: model.id },
              variant: item.variant,
            },
            sessionID: session,
            model,
            agent,
            system: [],
            abort: new AbortController().signal,
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          })
          expect(await stream.text).toBe("Hello")
          expect(requests).toHaveLength(1)
          Object.entries(item.expected).forEach(([key, value]) => expect(requests[0][key]).toEqual(value))
        },
      })
    } finally {
      server.stop(true)
    }
  },
)
