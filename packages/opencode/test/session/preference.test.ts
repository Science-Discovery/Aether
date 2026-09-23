import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Bus } from "../../src/bus"
import { SessionPreference } from "../../src/session/preference"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Log } from "../../src/util/log"
import { Wildcard } from "../../src/util/wildcard"
import type { Permission } from "../../src/permission"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(() => {
  SessionPreference.clear()
  Instance.disposeAll()
})

const sid = () => SessionID.make(`ses_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`)
const pid = (id: string) => ProviderID.make(id)
const mid = (id: string) => ModelID.make(id)

describe("SessionPreference", () => {
  describe("update – field merge", () => {
    test("single-field patches do not overwrite other fields", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const id = sid()
          await SessionPreference.update({ sessionID: id, agent: "build" })
          await SessionPreference.update({ sessionID: id, model: { providerID: pid("openai"), modelID: mid("gpt-4") } })
          const pref = SessionPreference.get(id)!
          expect(pref.agent).toBe("build")
          expect(pref.model!.providerID).toBe(pid("openai"))
          expect(pref.model!.modelID).toBe(mid("gpt-4"))
        },
      })
    })

    test("variant patch preserves agent and model", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const id = sid()
          await SessionPreference.update({
            sessionID: id,
            agent: "plan",
            model: { providerID: pid("anthropic"), modelID: mid("claude-3") },
          })
          await SessionPreference.update({ sessionID: id, variant: "high" })
          const pref = SessionPreference.get(id)!
          expect(pref.agent).toBe("plan")
          expect(pref.model!.providerID).toBe(pid("anthropic"))
          expect(pref.model!.modelID).toBe(mid("claude-3"))
          expect(pref.variant).toBe("high")
        },
      })
    })

    test("variant: null clears variant; variant: undefined keeps previous", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const id = sid()
          await SessionPreference.update({ sessionID: id, agent: "build" })
          await SessionPreference.update({ sessionID: id, variant: "high" })
          await SessionPreference.update({ sessionID: id, variant: null })
          expect(SessionPreference.get(id)?.variant).toBeUndefined()

          const id2 = sid()
          await SessionPreference.update({ sessionID: id2, agent: "docs", variant: "minimal" })
          await SessionPreference.update({ sessionID: id2, agent: "docs2" })
          expect(SessionPreference.get(id2)?.variant).toBe("minimal")
        },
      })
    })

    test("model change resets variant", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const id = sid()
          await SessionPreference.update({ sessionID: id, agent: "build" })
          await SessionPreference.update({ sessionID: id, model: { providerID: pid("openai"), modelID: mid("gpt-4") } })
          await SessionPreference.update({ sessionID: id, variant: "high" })
          await SessionPreference.update({
            sessionID: id,
            model: { providerID: pid("anthropic"), modelID: mid("claude-3") },
          })
          const pref = SessionPreference.get(id)!
          expect(pref.model!.providerID).toBe(pid("anthropic"))
          expect(pref.variant).toBeUndefined()
        },
      })
    })

    test("same model patch keeps variant", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const id = sid()
          await SessionPreference.update({ sessionID: id, agent: "build" })
          await SessionPreference.update({ sessionID: id, model: { providerID: pid("openai"), modelID: mid("gpt-4") } })
          await SessionPreference.update({ sessionID: id, variant: "low" })
          await SessionPreference.update({ sessionID: id, model: { providerID: pid("openai"), modelID: mid("gpt-4") } })
          expect(SessionPreference.get(id)?.variant).toBe("low")
        },
      })
    })

    test("autoAccept true then false toggles correctly", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "pref-test" })
          const id = session.id
          await SessionPreference.update({ sessionID: id, agent: "build" })
          await SessionPreference.update({ sessionID: id, variant: "max" })
          await SessionPreference.update({ sessionID: id, autoAccept: true })
          const pref1 = SessionPreference.get(id)!
          expect(pref1.agent).toBe("build")
          expect(pref1.variant).toBe("max")
          expect(pref1.autoAccept).toBe(true)

          await SessionPreference.update({ sessionID: id, autoAccept: false })
          const pref2 = SessionPreference.get(id)!
          expect(pref2.agent).toBe("build")
          expect(pref2.variant).toBe("max")
          expect(pref2.autoAccept).toBe(false)
        },
      })
    })
  })

  describe("update – event broadcast", () => {
    test("PreferenceUpdated event carries merged state", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const id = sid()
          const events: SessionPreference.Info[] = []
          const unsub = Bus.subscribe(SessionPreference.PreferenceUpdated, (evt) => {
            events.push(evt.properties.preference as SessionPreference.Info)
          })
          await Bun.sleep(10)
          await SessionPreference.update({ sessionID: id, agent: "build" })
          await SessionPreference.update({ sessionID: id, variant: "high" })
          await Bun.sleep(10)
          unsub()
          expect(events.length).toBeGreaterThanOrEqual(2)
          const last = events[events.length - 1]
          expect(last.agent).toBe("build")
          expect(last.variant).toBe("high")
          expect(last.sessionID).toBe(id)
        },
      })
    })

    test("event variant field is null when undefined", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const id = sid()
          const events: any[] = []
          const unsub = Bus.subscribe(SessionPreference.PreferenceUpdated, (evt) => {
            events.push(evt.properties.preference)
          })
          await Bun.sleep(10)
          await SessionPreference.update({ sessionID: id, agent: "build" })
          await Bun.sleep(10)
          unsub()
          const last = events[events.length - 1]
          expect(last.variant).toBe(null)
        },
      })
    })
  })

  describe("update – cross-patch idempotency", () => {
    test("sequential patches accumulate correctly", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const id = sid()
          await SessionPreference.update({ sessionID: id, agent: "build" })
          await SessionPreference.update({ sessionID: id, model: { providerID: pid("openai"), modelID: mid("gpt-4") } })
          await SessionPreference.update({ sessionID: id, variant: "low" })
          const pref = SessionPreference.get(id)!
          expect(pref.sessionID).toBe(id)
          expect(pref.agent).toBe("build")
          expect(pref.model!.providerID).toBe(pid("openai"))
          expect(pref.model!.modelID).toBe(mid("gpt-4"))
          expect(pref.variant).toBe("low")
        },
      })
    })
  })

  describe("get / remove / clear", () => {
    test("get returns undefined for unknown session", () => {
      expect(SessionPreference.get(sid())).toBeUndefined()
    })

    test("remove deletes entry", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const id = sid()
          await SessionPreference.update({ sessionID: id, agent: "build" })
          expect(SessionPreference.get(id)).toBeDefined()
          SessionPreference.remove(id)
          expect(SessionPreference.get(id)).toBeUndefined()
        },
      })
    })

    test("clear empties all entries", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const id1 = sid()
          const id2 = sid()
          await SessionPreference.update({ sessionID: id1, agent: "build" })
          await SessionPreference.update({ sessionID: id2, agent: "plan" })
          SessionPreference.clear()
          expect(SessionPreference.get(id1)).toBeUndefined()
          expect(SessionPreference.get(id2)).toBeUndefined()
        },
      })
    })
  })
})

describe("SessionPreference permission tier", () => {
  function lastWritten(events: any[]) {
    const withPermission = events.filter((e) => e?.info?.permission !== undefined)
    return withPermission.at(-1)?.info?.permission
  }

  test("mode=full writes allow-all rules and mirrors autoAccept", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const id = session.id
        const events: any[] = []
        const unsub = Bus.subscribe(Session.Event.Updated, (e) => events.push(e.properties))
        try {
          const pref = await SessionPreference.update({ sessionID: id, mode: "full" })
          expect(pref.mode).toBe("full")
          expect(pref.autoAccept).toBe(true)
          expect(lastWritten(events)).toEqual([{ permission: "*", pattern: "*", action: "allow" }])
        } finally {
          unsub()
        }
      },
    })
  })

  test("mode=off clears session rules", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const id = session.id
        const events: any[] = []
        const unsub = Bus.subscribe(Session.Event.Updated, (e) => events.push(e.properties))
        try {
          await SessionPreference.update({ sessionID: id, mode: "full" })
          const pref = await SessionPreference.update({ sessionID: id, mode: "off" })
          expect(pref.mode).toBe("off")
          expect(pref.autoAccept).toBe(false)
          expect(lastWritten(events)).toEqual([])
        } finally {
          unsub()
        }
      },
    })
  })

  test("mode=safe writes safe-zone rules with external_read baseline", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const id = session.id
        const events: any[] = []
        const unsub = Bus.subscribe(Session.Event.Updated, (e) => events.push(e.properties))
        try {
          const pref = await SessionPreference.update({ sessionID: id, mode: "safe" })
          expect(pref.mode).toBe("safe")
          const rules = lastWritten(events)
          expect(Array.isArray(rules)).toBe(true)
          expect(rules[0]).toEqual({ permission: "external_read", pattern: "*", action: "allow" })
          expect(rules.length).toBeGreaterThan(1)
          expect(rules).toContainEqual({
            permission: "read",
            pattern: `${path.join(os.tmpdir(), "**").replaceAll("\\", "/")}`,
            action: "allow",
          })
        } finally {
          unsub()
        }
      },
    })
  })

  test("legacy autoAccept=true behaves as full tier", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const id = session.id
        const events: any[] = []
        const unsub = Bus.subscribe(Session.Event.Updated, (e) => events.push(e.properties))
        try {
          const pref = await SessionPreference.update({ sessionID: id, autoAccept: true })
          expect(pref.mode).toBe("full")
          expect(pref.autoAccept).toBe(true)
          expect(lastWritten(events)).toEqual([{ permission: "*", pattern: "*", action: "allow" }])

          const off = await SessionPreference.update({ sessionID: id, autoAccept: false })
          expect(off.mode).toBe("off")
          expect(off.autoAccept).toBe(false)
          expect(lastWritten(events)).toEqual([])
        } finally {
          unsub()
        }
      },
    })
  })

  test("no-tier patches do not rewrite rules", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const id = session.id
        const events: any[] = []
        const unsub = Bus.subscribe(Session.Event.Updated, (e) => events.push(e.properties))
        try {
          await SessionPreference.update({ sessionID: id, mode: "safe" })
          events.length = 0
          await SessionPreference.update({ sessionID: id, variant: "high" })
          expect(lastWritten(events)).toBeUndefined()
        } finally {
          unsub()
        }
      },
    })
  })
})

describe("SessionPreference safe tier vs user denies", () => {
  test("permission-config denies survive the safe-tier blanket allow", async () => {
    await using tmp = await tmpdir({
      config: {
        permission: {
          external_directory: {
            "**/secrets/**": "deny",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const events: any[] = []
        const unsub = Bus.subscribe(Session.Event.Updated, (e) => events.push(e.properties))
        try {
          await SessionPreference.update({ sessionID: session.id, mode: "safe" })
          const rules = (events.filter((e) => e?.info?.permission !== undefined).at(-1)?.info?.permission ??
            []) as Permission.Ruleset
          const hit = (permission: string, pattern: string) => {
            let action
            for (const rule of rules) {
              if (Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))
                action = rule.action
            }
            return action
          }
          expect(rules[0]).toEqual({ permission: "external_read", pattern: "*", action: "allow" })
          expect(hit("external_read", "D:/proj/secrets/a.txt")).toBe("deny")
          expect(hit("external_directory", "D:/proj/secrets/b.txt")).toBe("deny")
          expect(hit("external_read", "D:/proj/other/a.txt")).toBe("allow")

          const { Agent } = await import("../../src/agent/agent")
          const { Permission } = await import("../../src/permission")
          const agent = await Agent.get("build")
          const merged = Permission.merge(agent!.permission, rules)
          expect(Permission.evaluate("external_read", "D:/proj/secrets/a.txt", merged).action).toBe("deny")
          expect(Permission.evaluate("external_read", "D:/proj/other/a.txt", merged).action).toBe("allow")
        } finally {
          unsub()
        }
      },
    })
  })
})
