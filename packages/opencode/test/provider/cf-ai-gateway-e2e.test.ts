import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { JSONValue } from "ai"
import { generateText } from "ai"
import { createAiGateway } from "ai-gateway-provider"
import { createUnified } from "ai-gateway-provider/providers/unified"
import { ProviderTransform } from "../../src/provider/transform"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"

type Captured = {
  url: string
  body: unknown
}

type Options = Record<string, Record<string, JSONValue>>

const real = globalThis.fetch
let captured: Captured | undefined

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

beforeEach(() => {
  captured = undefined
  const handle = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith("https://gateway.ai.cloudflare.com/")) {
      const text = typeof init?.body === "string" ? init.body : ""
      captured = { url, body: text ? JSON.parse(text) : undefined }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "openai/gpt-5.4",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    return real(input, init)
  }
  globalThis.fetch = Object.assign(handle, { preconnect: real.preconnect.bind(real) })
})

afterEach(() => {
  globalThis.fetch = real
})

function model(id: string): Provider.Model {
  return {
    id: ModelID.make(`cloudflare-ai-gateway/${id}`),
    providerID: ProviderID.make("cloudflare-ai-gateway"),
    name: id,
    api: { id, url: "https://gateway.ai.cloudflare.com/v1/compat", npm: "ai-gateway-provider" },
    capabilities: {
      reasoning: true,
      temperature: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    limit: { context: 1_000_000, output: 128_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-03-05",
  }
}

function query(body: unknown) {
  if (!Array.isArray(body)) return undefined
  const first = body.at(0)
  if (!record(first)) return undefined
  if (!record(first.query)) return undefined
  return first.query
}

async function call(id: string, opts: Options) {
  const gateway = createAiGateway({ accountId: "test", gateway: "test", apiKey: "test" })
  const unified = createUnified()
  await generateText({ model: gateway(unified(id)), prompt: "hi", providerOptions: opts })
  return query(captured?.body)
}

describe("cf-ai-gateway end-to-end", () => {
  test("puts ProviderTransform reasoning effort on the upstream wire payload", async () => {
    const opts = ProviderTransform.providerOptions(model("openai/gpt-5.4"), { reasoningEffort: "xhigh" })

    expect(opts).toEqual({ openaiCompatible: { reasoningEffort: "xhigh" } })
    expect((await call("openai/gpt-5.4", opts))?.reasoning_effort).toBe("xhigh")
  })

  test("does not send legacy cloudflare providerOptions key upstream", async () => {
    const upstream = await call("openai/gpt-5.4", {
      "cloudflare-ai-gateway": { reasoningEffort: "high" },
    })

    expect(upstream?.reasoning_effort).toBeUndefined()
  })
})
