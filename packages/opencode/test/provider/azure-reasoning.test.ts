import { expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"
import { reply, stream } from "../lib/llm"

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
      return reply(path.endsWith("/responses") ? "responses" : "chat", "gpt-6-astra")
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
        const effort = input.chat ? "high" : "max"
        expect(await stream(model, effort)).toBe("Hello")
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
