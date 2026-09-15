import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs/promises"
import type { Agent } from "../../../src/agent/agent"
import type { Config } from "../../../src/config/config"
import { Auth } from "../../../src/auth"
import { Global } from "../../../src/global"
import { GlobalBus } from "../../../src/bus/global"
import { Instance } from "../../../src/project/instance"
import { CodexModels } from "../../../src/plugin/codex-models"
import { ModelsDev } from "../../../src/provider/models"
import { Provider } from "../../../src/provider/provider"
import { ProviderID, ModelID } from "../../../src/provider/schema"
import { SessionID, MessageID } from "../../../src/session/schema"
import { LLM } from "../../../src/session/llm"
import { Database } from "../../../src/storage/db"

const dir = process.argv[2]
const origin = process.env.OPENCODE_MODELS_URL!
const events: string[] = []
const request = globalThis.fetch

// Only catalog discovery is redirected. Inference uses the configured local
// Responses endpoint through the real SDK and built-in OAuth plugin.
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.href === CodexModels.REGISTRY) return request(`${origin}/registry`, init)
    if (url.origin + url.pathname === CodexModels.URL) return request(`${origin}/models${url.search}`, init)
    assert.equal(url.origin, origin, `unexpected external request: ${url.origin}${url.pathname}`)
    return request(input, init)
  },
  { preconnect: request.preconnect },
)

await Global.ensureDirs()
await fs.mkdir(Global.Path.home, { recursive: true })
await Bun.write(
  path.join(dir, "opencode.json"),
  JSON.stringify({
    enabled_providers: ["openai"],
    provider: {
      openai: {
        options: { baseURL: `${origin}/api` },
        models: {
          alias: { id: "gpt-5" },
          configured: {
            id: "gpt-5",
            name: "User name",
            limit: { context: 64000, input: 60000, output: 4096 },
            modalities: { input: ["text", "image"], output: ["text"] },
            options: { reasoningEffort: "low" },
            reasoning_options: [{ type: "effort", values: ["low", "high"] }],
            variants: { high: { disabled: true }, manual: { reasoningEffort: "low" } },
          },
          disabled: { id: "gpt-5", reasoning: false },
          empty: { id: "gpt-5", reasoning_options: [] },
        },
      },
    },
  } satisfies Config.Info),
)
await Auth.set("openai", {
  type: "oauth",
  refresh: "subscription-refresh",
  access: "subscription-access",
  expires: Date.now() + 600_000,
  accountId: "subscription-account",
})
GlobalBus.on("event", (event) => {
  if (event.payload.type !== "provider.models.updated") return
  if (event.payload.properties.source !== "codex") return
  events.push(event.payload.properties.hash)
})

async function stream(model: Provider.Model, variant?: string) {
  const session = SessionID.make("session-subscription-refresh")
  const agent = {
    name: "test",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  } satisfies Agent.Info
  const output = await LLM.stream({
    user: {
      id: MessageID.make("user-subscription-refresh"),
      sessionID: session,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: model.providerID, modelID: model.id },
      variant,
    },
    sessionID: session,
    model,
    agent,
    system: [],
    abort: new AbortController().signal,
    messages: [{ role: "user", content: "Hello" }],
    tools: {},
  })
  assert.equal(await output.text, "Hello")
}

try {
  assert.equal((await ModelsDev.refresh({ force: true })).changed, true)
  await Instance.provide({
    directory: dir,
    fn: async () => {
      const model = (id: string) => Provider.getModel(ProviderID.openai, ModelID.make(id))
      await Provider.list()
      assert.equal((await CodexModels.refresh({ force: true })).error, null)
      const first = await model("gpt-5")
      assert.equal(first.name, "Subscription initial")
      assert.deepEqual(first.limit, { context: 96000, input: 96000, output: 8192 })
      assert.equal(first.capabilities.input.image, true)
      assert.equal(first.options.reasoningEffort, "high")
      assert.deepEqual(Object.keys(first.variants ?? {}), ["low", "high"])
      assert.equal(first.cost.input, 0)
      assert.equal(first.cost.output, 0)
      assert.deepEqual((await model("alias")).variants, first.variants)
      assert.deepEqual((await model("disabled")).variants, {})
      assert.equal((await model("disabled")).options.reasoningEffort, undefined)
      assert.deepEqual((await model("empty")).variants, {})
      const before = CodexModels.status().hash
      const count = events.length

      await fetch(`${origin}/next`)
      assert.equal((await CodexModels.refresh({ force: true })).changed, true)
      assert.notEqual(CodexModels.status().hash, before)
      assert.equal(events.length, count + 1)
      const updated = await model("gpt-5")
      assert.notEqual(updated, first)
      assert.equal(updated.name, "Subscription updated")
      assert.deepEqual(updated.limit, { context: 256000, input: 120000, output: 8192 })
      assert.equal(updated.capabilities.input.image, false)
      assert.equal(updated.options.reasoningEffort, "ultra")
      assert.deepEqual(Object.keys(updated.variants ?? {}), ["high", "ultra", "future"])
      assert.deepEqual((await model("alias")).variants, updated.variants)
      const configured = await model("configured")
      assert.equal(configured.name, "User name")
      assert.deepEqual(configured.limit, { context: 64000, input: 60000, output: 4096 })
      assert.equal(configured.capabilities.input.image, true)
      assert.equal(configured.options.reasoningEffort, "low")
      assert.deepEqual(Object.keys(configured.variants ?? {}), ["low", "manual"])
      assert.deepEqual((await model("disabled")).variants, {})
      assert.deepEqual((await model("empty")).variants, {})
      await stream(updated)
      await stream(await model("alias"), "future")

      const unchanged = events.length
      assert.equal((await CodexModels.refresh({ force: true })).changed, false)
      assert.equal(events.length, unchanged)

      await fetch(`${origin}/next`)
      assert.equal((await CodexModels.refresh({ force: true })).changed, true)
      const added = await model("gpt-subscription-only")
      assert.equal(added.name, "Subscription updated")
      assert.equal(added.limit.context, 256000)
      assert.equal(added.limit.output, 0)
      assert.equal(added.capabilities.input.text, true)
      assert.deepEqual(Object.keys(added.variants ?? {}), ["high", "ultra", "future"])
      await stream(added, "ultra")

      await fetch(`${origin}/next`)
      assert.equal((await CodexModels.refresh({ force: true })).changed, true)
      const final = await Provider.list()
      assert.equal(final[ProviderID.openai].models[ModelID.make("gpt-subscription-only")], undefined)
      assert.equal(final[ProviderID.openai].models[ModelID.make("gpt-subscription-removed")], undefined)
      assert.equal(final[ProviderID.openai].models[ModelID.make("gpt-subscription-hidden")], undefined)
      assert.equal(final[ProviderID.openai].models[ModelID.make("gpt-api-only")], undefined)
      assert.deepEqual(Object.keys((await model("alias")).variants ?? {}), ["ultra", "future"])

      // An absent or retired subscription default must not resurrect GPT-5's
      // built-in medium default after the subscription removes that effort.
      for (const stage of [4, 5]) {
        assert.equal((await (await fetch(`${origin}/next`)).json()).stage, stage)
        assert.equal((await CodexModels.refresh({ force: true })).changed, true)
        const current = await model("gpt-5")
        assert.equal(current.options.reasoningEffort, undefined)
        assert.deepEqual(Object.keys(current.variants ?? {}), ["ultra", "future"])
        assert.equal((await model("configured")).options.reasoningEffort, "low")
        await stream(current)
      }
    },
  })
  await Instance.disposeAll()
  await Auth.set("openai", { type: "api", key: "api-key" })
  await Instance.provide({
    directory: dir,
    fn: async () => {
      const providers = await Provider.list()
      const model = providers[ProviderID.openai].models[ModelID.make("gpt-5")]
      assert.equal(model.name, "Catalog name")
      assert.deepEqual(model.limit, { context: 128000, input: 120000, output: 8192 })
      assert.deepEqual(Object.keys(model.variants ?? {}), ["low", "medium", "high"])
      assert.equal(model.capabilities.input.image, false)
      assert.equal(model.options.reasoningEffort, undefined)
      assert.equal(model.cost.input, 1)
      assert.ok(providers[ProviderID.openai].models[ModelID.make("gpt-api-only")])
      assert.ok(providers[ProviderID.openai].models[ModelID.make("gpt-subscription-removed")])
      assert.equal(providers[ProviderID.openai].models[ModelID.make("gpt-subscription-only")], undefined)
    },
  })
  console.log("subscription metadata refresh verified")
} finally {
  await Instance.disposeAll()
  CodexModels.Test.reset()
  Database.close()
  globalThis.fetch = request
}
