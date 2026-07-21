import { afterEach, describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { SessionPreference } from "../../src/session/preference"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Log } from "../../src/util/log"
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
