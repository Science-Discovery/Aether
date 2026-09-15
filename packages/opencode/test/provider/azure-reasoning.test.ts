import { expect, test } from "bun:test"
import type { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { LLM } from "../../src/session/llm"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

test.each([
  { provider: "azure", source: "auth", route: undefined, override: undefined, chat: false },
  { provider: "azure", source: "auth", route: true, override: undefined, chat: true },
  { provider: "azure", source: "auth", route: true, override: false, chat: false },
  { provider: "azure", source: "auth", route: false, override: true, chat: true },
  { provider: "azure-cognitive-services", source: "auth", route: undefined, override: undefined, chat: false },
  { provider: "azure-cognitive-services", source: "auth", route: true, override: undefined, chat: true },
  { provider: "azure", source: "config", route: undefined, override: undefined, chat: true },
  { provider: "azure-cognitive-services", source: "config", route: false, override: false, chat: true },
  { provider: "azure-custom", source: "config", route: undefined, override: undefined, chat: true },
  { provider: "azure-custom", source: "config", route: false, override: false, chat: true },
  { provider: "openai", source: "auth", route: undefined, override: undefined, chat: false },
])("$provider ($source key): provider route=$route, model override=$override", async (input) => {
  const auth = await Auth.get(input.provider)
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const server = await serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (!path.endsWith("/responses") && !path.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 })
      requests.push({ path, body: await req.json() })
      const chunks = path.endsWith("/responses")
        ? [
            {
              type: "response.created",
              response: { id: "resp-1", created_at: 1, model: "gpt-6-astra", service_tier: null },
            },
            { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "item-1" } },
            { type: "response.output_text.delta", item_id: "item-1", delta: "Hello", logprobs: null },
            { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "item-1" } },
            {
              type: "response.completed",
              response: {
                incomplete_details: null,
                usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null },
                service_tier: null,
              },
            },
          ].map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}`)
        : [
            `data: ${JSON.stringify({ id: "chat-1", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}`,
            `data: ${JSON.stringify({ id: "chat-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
            "data: [DONE]",
          ]
      return new Response(chunks.join("\n\n") + "\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })

  try {
    if (input.source === "auth") await Auth.set(input.provider, { type: "api", key: "test-key" })
    if (input.source === "config") await Auth.remove(input.provider)
    await using tmp = await tmpdir({
      config: {
        enabled_providers: [input.provider],
        provider: {
          [input.provider]: {
            npm: "@ai-sdk/azure",
            env: [],
            options: {
              apiKey: "test-key",
              baseURL: server.url.origin,
              ...(input.route === undefined ? {} : { useCompletionUrls: input.route }),
            },
            models: {
              configured: {
                id: "gpt-6-astra",
                reasoning: true,
                reasoning_options: [{ type: "effort", values: ["high", "max"] }],
                limit: { context: 128000, output: 8192 },
                options: input.override === undefined ? {} : { useCompletionUrls: input.override },
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.getModel(ProviderID.make(input.provider), ModelID.make("configured"))
        expect(Object.keys(model.variants ?? {})).toEqual(input.chat ? ["high"] : ["high", "max"])
        expect((await Provider.getLanguage(model)).provider).toBe(input.chat ? "azure.chat" : "azure.responses")
        const session = SessionID.make("session-azure-reasoning")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const effort = input.chat ? "high" : "max"
        const stream = await LLM.stream({
          user: {
            id: MessageID.make("user-azure-reasoning"),
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
        expect(requests[0].path).toBe(input.chat ? "/v1/chat/completions" : "/v1/responses")
        expect(requests[0].body.model).toBe("gpt-6-astra")
        expect(requests[0].body.reasoning_effort).toBe(input.chat ? "high" : undefined)
        expect(requests[0].body.reasoning).toEqual(input.chat ? undefined : { effort: "max", summary: "auto" })
        expect(requests[0].body.include).toEqual(input.chat ? undefined : ["reasoning.encrypted_content"])
        expect(requests[0].body.reasoningSummary).toBeUndefined()
        expect(requests[0].body.reasoning_summary).toBeUndefined()
      },
    })
  } finally {
    server.stop(true)
    if (auth) await Auth.set(input.provider, auth)
    if (!auth) await Auth.remove(input.provider)
  }
})
