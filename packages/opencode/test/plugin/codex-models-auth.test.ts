import { afterEach, expect, spyOn, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { CodexModels } from "../../src/plugin/codex-models"
import { CodexAuthPlugin } from "../../src/plugin/codex"
import type { ModelsDev } from "../../src/provider/models"
import { Provider } from "../../src/provider/provider"

const base: ModelsDev.Model = {
  id: "gpt-5",
  name: "GPT-5",
  release_date: "2026-01-01",
  attachment: true,
  reasoning: true,
  temperature: false,
  tool_call: true,
  limit: {
    context: 128000,
    output: 8192,
  },
  modalities: {
    input: ["text"],
    output: ["text"],
  },
  cost: {
    input: 1,
    output: 2,
  },
  options: {},
}

function model(id: string): ModelsDev.Model {
  return {
    ...base,
    id,
    name: id,
  }
}

afterEach(() => CodexModels.Test.reset())

test("uses the built-in fallback before the first valid remote catalog", async () => {
  const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("offline", { status: 503 }))
  const hooks = await CodexAuthPlugin({} as unknown as PluginInput)
  const load = hooks.auth?.loader
  if (!load) throw new Error("missing codex auth loader")

  const prov = Provider.fromModelsDevProvider({
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    api: "https://api.openai.com/v1",
    models: {
      "gpt-5": model("gpt-5"),
      "gpt-5.4": model("gpt-5.4"),
      "gpt-5.5": model("gpt-5.5"),
      "gpt-5.5-pro": model("gpt-5.5-pro"),
      "gpt-5.6-codex": model("gpt-5.6-codex"),
    },
  })

  try {
    await load(
      async () => ({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 60_000,
      }),
      prov as unknown as Parameters<typeof load>[1],
    )
    await CodexModels.refresh({ force: true })

    expect(Object.keys(prov.models).sort()).toEqual([
      "gpt-5.3-codex",
      "gpt-5.4",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.6-codex",
    ])
    expect(prov.models["gpt-5.5"].cost.input).toBe(0)
    expect(prov.models["gpt-5.5-pro"].cost.output).toBe(0)
  } finally {
    request.mockRestore()
  }
})

test("uses remote slugs as the sole allowlist and matches model api ids", async () => {
  CodexModels.Test.prime({
    identity: "account",
    seed: "refresh",
    models: ["gpt-5.5", "gpt-5.6-sol"],
  })
  const hooks = await CodexAuthPlugin({} as unknown as PluginInput)
  const load = hooks.auth?.loader
  if (!load) throw new Error("missing codex auth loader")

  const prov = Provider.fromModelsDevProvider({
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    api: "https://api.openai.com/v1",
    models: {
      "gpt-5.5": model("gpt-5.5"),
      "gpt-5.6-codex": model("gpt-5.6-codex"),
      "aether-alias": model("aether-alias"),
    },
  })
  prov.models["aether-alias"].api.id = "gpt-5.6-sol"

  await load(
    async () =>
      ({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 60_000,
        accountId: "account",
      }) as Awaited<ReturnType<Parameters<typeof load>[0]>>,
    prov as unknown as Parameters<typeof load>[1],
  )

  expect(Object.keys(prov.models).sort()).toEqual(["aether-alias", "gpt-5.5"])
  expect(prov.models["aether-alias"].cost.input).toBe(0)
})

test("authenticates catalog requests with the current subscription account", async () => {
  const request = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        models: [{ slug: "gpt-5.5", visibility: "list", minimal_client_version: "0.144.0" }],
      }),
    ),
  )
  const hooks = await CodexAuthPlugin({} as unknown as PluginInput)
  const load = hooks.auth?.loader
  if (!load) throw new Error("missing codex auth loader")
  const prov = Provider.fromModelsDevProvider({
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    api: "https://api.openai.com/v1",
    models: { "gpt-5.5": model("gpt-5.5") },
  })

  try {
    await load(
      async () =>
        ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
          accountId: "account",
        }) as Awaited<ReturnType<Parameters<typeof load>[0]>>,
      prov as unknown as Parameters<typeof load>[1],
    )
    await CodexModels.refresh({ force: true })

    const call = request.mock.calls.at(-1)
    const url = call?.[0]
    const headers = new Headers(call?.[1]?.headers)
    expect(url instanceof Request ? url.url : url?.toString()).toBe(CodexModels.URL)
    expect(headers.get("authorization")).toBe("Bearer access")
    expect(headers.get("chatgpt-account-id")).toBe("account")
  } finally {
    request.mockRestore()
  }
})

test("does not activate the subscription catalog for API keys", async () => {
  const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("unexpected"))
  const hooks = await CodexAuthPlugin({} as unknown as PluginInput)
  const load = hooks.auth?.loader
  if (!load) throw new Error("missing codex auth loader")
  const prov = Provider.fromModelsDevProvider({
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    api: "https://api.openai.com/v1",
    models: { "gpt-5.5": model("gpt-5.5") },
  })

  try {
    await load(async () => ({ type: "api", key: "key" }), prov as unknown as Parameters<typeof load>[1])
    expect(request).not.toHaveBeenCalled()
    expect(CodexModels.status().enabled).toBe(false)
  } finally {
    request.mockRestore()
  }
})
