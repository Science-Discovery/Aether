import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { tmpdir } from "../fixture/fixture"

test.each(["message", "prompt_async"])("%s accepts deferred native context without a catalog model", async (route) => {
  await using tmp = await tmpdir({ config: { enabled_providers: [] } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ engine: { type: "codex", model: "research" } })
      const done = Promise.withResolvers<void>()
      const stop = Bus.subscribe(Session.Event.Updated, (event) => {
        if (event.properties.info.id === session.id) done.resolve()
      })
      try {
        const response = await Server.Default().request(`/session/${session.id}/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-opencode-directory": tmp.path },
          body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: "Keep this research context" }] }),
        })
        expect(response.status).toBe(route === "message" ? 200 : 204)
        await done.promise
        const messages = await Session.messages({ sessionID: session.id })
        expect(messages).toHaveLength(1)
        expect(messages[0].info).toMatchObject({
          role: "user",
          model: { providerID: "codex-native", modelID: "research" },
        })
        expect(messages[0].parts).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "text", text: "Keep this research context" })]),
        )
      } finally {
        stop()
        await Session.remove(session.id)
      }
    },
  })
})

test.each(["message", "prompt_async"])(
  "%s rejects an unconfigured chat model before persisting the prompt",
  async (route) => {
    await using tmp = await tmpdir({ config: { enabled_providers: [] } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const response = await Server.Default().request(`/session/${session.id}/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-opencode-directory": tmp.path },
          body: JSON.stringify({ parts: [{ type: "text", text: "keep my unsent question" }] }),
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          name: "NoModelConfiguredError",
          data: { message: "No model configured. Connect a provider and select a model." },
        })
        expect(await Session.messages({ sessionID: session.id })).toEqual([])
        await Session.remove(session.id)
      },
    })
  },
)

test.each(["message", "prompt_async"])(
  "%s rejects a retired explicit model without substituting a paid model",
  async (route) => {
    await using tmp = await tmpdir({
      config: { provider: { anthropic: { options: { apiKey: "other-paid-key", baseURL: "http://127.0.0.1:1" } } } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const response = await Server.Default().request(`/session/${session.id}/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-opencode-directory": tmp.path },
          body: JSON.stringify({
            model: { providerID: "opencode", modelID: "big-pickle" },
            parts: [{ type: "text", text: "keep my unsent question" }],
          }),
        })

        expect(response.status).toBe(400)
        expect((await response.json()).name).toBe("ProviderModelNotFoundError")
        expect(await Session.messages({ sessionID: session.id })).toEqual([])
        await Session.remove(session.id)
      },
    })
  },
)
