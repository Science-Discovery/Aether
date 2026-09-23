import { afterEach, test, expect } from "bun:test"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"

afterEach(async () => {
  await Instance.disposeAll()
})

const sid = SessionID.make("session_deny_first")

test("ask - persisted always approval still resolves ask rules", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const first = Permission.ask({
        sessionID: sid,
        permission: "read",
        patterns: ["/outside/notes/a.txt"],
        metadata: {},
        always: ["*"],
        ruleset: [{ permission: "read", pattern: "*", action: "ask" }],
      })
      const pending = await Permission.list()
      expect(pending).toHaveLength(1)
      await Permission.reply({ requestID: pending[0]!.id, reply: "always" })
      await first

      const second = await Permission.ask({
        sessionID: sid,
        permission: "read",
        patterns: ["/outside/notes/b.txt"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "read", pattern: "*", action: "ask" }],
      })
      expect(second).toBeUndefined()
    },
  })
})

test("ask - ruleset deny beats persisted always approval", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const first = Permission.ask({
        sessionID: sid,
        permission: "read",
        patterns: ["/outside/notes/a.txt"],
        metadata: {},
        always: ["*"],
        ruleset: [{ permission: "read", pattern: "*", action: "ask" }],
      })
      const pending = await Permission.list()
      expect(pending).toHaveLength(1)
      await Permission.reply({ requestID: pending[0]!.id, reply: "always" })
      await first

      // The persisted approval is {read, *, allow}; an explicit deny must win.
      await expect(
        Permission.ask({
          sessionID: sid,
          permission: "read",
          patterns: ["/outside/secrets/auth.json"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "read", pattern: "*", action: "ask" },
            { permission: "read", pattern: "**/auth.json", action: "deny" },
          ],
        }),
      ).rejects.toBeInstanceOf(Permission.DeniedError)
    },
  })
})

test("ask - session privacy deny wins over safe-tier allow", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        Permission.ask({
          sessionID: sid,
          permission: "read",
          patterns: ["/data/auth.json"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "read", pattern: "*", action: "allow" },
            { permission: "read", pattern: "**/auth.json", action: "deny" },
          ],
        }),
      ).rejects.toBeInstanceOf(Permission.DeniedError)
    },
  })
})
