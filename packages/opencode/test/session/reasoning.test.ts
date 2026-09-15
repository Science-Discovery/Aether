import { expect, test } from "bun:test"
import type { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { LLM } from "../../src/session/llm"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

test.each(["low", "high", "max", undefined])("sends DeepSeek V4.1 Flash effort %s", async (effort) => {
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
        enabled_providers: ["deepseek"],
        provider: {
          deepseek: {
            options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` },
            models: {
              "deepseek-flash": {
                reasoning: true,
                reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.getModel(ProviderID.make("deepseek"), ModelID.make("deepseek-flash"))
        expect(Object.keys(model.variants ?? {})).toEqual(["low", "high", "max"])

        const session = SessionID.make("session-deepseek-effort")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const stream = await LLM.stream({
          user: {
            id: MessageID.make("user-deepseek-effort"),
            sessionID: session,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: model.providerID, modelID: model.id },
            variant: effort,
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
        expect(requests[0].model).toBe("deepseek-flash")
        expect(requests[0].reasoning_effort).toBe(effort)
        expect(requests[0].reasoningEffort).toBeUndefined()
        expect(requests[0].thinking).toEqual(effort ? { type: "enabled" } : undefined)
      },
    })
  } finally {
    server.stop(true)
  }
})
