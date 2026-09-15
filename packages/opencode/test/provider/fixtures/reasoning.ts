import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs/promises"
import type { Agent } from "../../../src/agent/agent"
import type { Config } from "../../../src/config/config"
import { Global } from "../../../src/global"
import { GlobalBus } from "../../../src/bus/global"
import { Instance } from "../../../src/project/instance"
import { ModelsDev } from "../../../src/provider/models"
import { Provider } from "../../../src/provider/provider"
import { ProviderID, ModelID } from "../../../src/provider/schema"
import { SessionID, MessageID } from "../../../src/session/schema"
import { LLM } from "../../../src/session/llm"
import { Database } from "../../../src/storage/db"

const dir = process.argv[2]
const events: string[] = []

await Global.ensureDirs()
await fs.mkdir(Global.Path.home, { recursive: true })
await Bun.write(
  path.join(dir, "opencode.json"),
  JSON.stringify({
    enabled_providers: ["deepseek"],
    provider: {
      deepseek: {
        options: { apiKey: "test-key" },
        models: {
          renamed: { id: "deepseek-future" },
          customized: {
            id: "deepseek-future",
            variants: {
              low: { disabled: true },
              high: { reasoningEffort: "low" },
              manual: { thinking: { type: "enabled" }, reasoningEffort: "high" },
            },
          },
          disabled: { id: "deepseek-future", reasoning: false },
          empty: { id: "deepseek-future", reasoning_options: [] },
          explicit: { id: "deepseek-future", reasoning_options: [{ type: "effort", values: ["medium"] }] },
          protocol: { id: "deepseek-future", provider: { npm: "@openrouter/ai-sdk-provider" } },
        },
      },
    },
  } satisfies Config.Info),
)

GlobalBus.on("event", (event) => {
  if (event.payload.type === "provider.models.updated") events.push(event.payload.type)
})

try {
  assert.equal((await ModelsDev.refresh({ force: true })).changed, true)
  await Instance.provide({
    directory: dir,
    fn: async () => {
      const model = (id: string) => Provider.getModel(ProviderID.make("deepseek"), ModelID.make(id))
      const first = await model("deepseek-future")
      assert.deepEqual(Object.keys(first.variants ?? {}), ["none", "low", "high"])
      assert.deepEqual((await model("renamed")).variants, first.variants)
      assert.deepEqual((await model("disabled")).variants, {})
      assert.deepEqual((await model("empty")).variants, {})
      assert.deepEqual(Object.keys((await model("explicit")).variants ?? {}), ["medium"])
      assert.deepEqual((await model("protocol")).variants?.high, { reasoning: { effort: "high" } })
      assert.deepEqual((await model("customized")).variants, {
        none: { thinking: { type: "disabled" }, reasoningEffort: undefined, reasoning_effort: undefined },
        high: { thinking: { type: "enabled" }, reasoningEffort: "low" },
        manual: { thinking: { type: "enabled" }, reasoningEffort: "high" },
      })

      assert.equal((await fetch(`${process.env.OPENCODE_MODELS_URL}/next`)).ok, true)
      const result = await ModelsDev.refresh({ force: true })
      assert.equal(result.changed, true)
      assert.equal(result.error, null)
      assert.equal(events.length, 2)
      const updated = await model("renamed")
      assert.deepEqual(Object.keys(updated.variants ?? {}), ["none", "high", "max"])
      assert.deepEqual(Object.keys((await model("customized")).variants ?? {}), ["none", "high", "max", "manual"])
      assert.deepEqual((await model("customized")).variants?.high, {
        thinking: { type: "enabled" },
        reasoningEffort: "low",
      })
      assert.deepEqual((await model("empty")).variants, {})
      assert.deepEqual((await model("disabled")).variants, {})
      assert.deepEqual(Object.keys((await model("explicit")).variants ?? {}), ["medium"])

      const session = SessionID.make("session-catalog-refresh")
      const agent = {
        name: "test",
        mode: "primary",
        options: {},
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      } satisfies Agent.Info
      const stream = await LLM.stream({
        user: {
          id: MessageID.make("user-catalog-refresh"),
          sessionID: session,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: updated.providerID, modelID: updated.id },
          variant: "max",
        },
        sessionID: session,
        model: updated,
        agent,
        system: [],
        abort: new AbortController().signal,
        messages: [{ role: "user", content: "Hello" }],
        tools: {},
      })
      assert.equal(await stream.text, "Hello")
    },
  })
  console.log("reasoning catalog refresh verified")
} finally {
  await Instance.disposeAll()
  Database.close()
}
