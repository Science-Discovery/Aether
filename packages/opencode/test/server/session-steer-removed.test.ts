import { describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

describe("retired steer endpoint", () => {
  test("returns 404 without changing history or reaching the web proxy", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const id = MessageID.ascending()
        await Session.updateMessage({
          id,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        })
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: id,
          sessionID: session.id,
          type: "text",
          text: "-用户补充：已有备注",
          metadata: { steer: true },
        })
        const before = await Session.messages({ sessionID: session.id })
        const upstream = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 502 }))
        try {
          const response = await Server.Default().request(`/session/${session.id}/steer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "must not be appended" }),
          })
          expect(response.status).toBe(404)
          expect(upstream).not.toHaveBeenCalled()
          expect(await Session.messages({ sessionID: session.id })).toEqual(before)
        } finally {
          upstream.mockRestore()
        }
      },
    })
  })

  test("does not expose the retired route in OpenAPI", async () => {
    expect((await Server.openapi()).paths).not.toHaveProperty("/session/{sessionID}/steer")
  })
})
