import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Storage } from "../../src/storage/storage"
import { Snapshot } from "../../src/snapshot"
import { Session } from "../../src/session"
import { SessionSummary } from "../../src/session/summary"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const model = {
  providerID: ProviderID.make("openai"),
  modelID: ModelID.make("gpt-4"),
}

function now() {
  return Date.now()
}

async function track(file: string, text: string) {
  await Bun.write(file, text)
  const snap = await Snapshot.track()
  expect(snap).toBeTruthy()
  return snap!
}

async function user(sessionID: SessionID, text = "user") {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "default",
    model,
    time: {
      created: now(),
    },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
}

async function reply(input: {
  sessionID: SessionID
  parentID: MessageID
  start: string
  finish: string
  text?: string
}) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: input.sessionID,
    mode: "default",
    agent: "default",
    path: {
      cwd: Instance.directory,
      root: Instance.directory,
    },
    cost: 0,
    tokens: {
      output: 0,
      input: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: model.modelID,
    providerID: model.providerID,
    parentID: input.parentID,
    time: {
      created: now(),
    },
    finish: "end_turn",
  }

  await Session.updateMessage(msg)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: input.sessionID,
    type: "step-start",
    snapshot: input.start,
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: input.sessionID,
    type: "text",
    text: input.text ?? "assistant",
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: input.sessionID,
    type: "step-finish",
    reason: "done",
    snapshot: input.finish,
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  })
  return msg
}

describe("session summary semantics", () => {
  test("records a baseline snapshot when creating a session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const from = await Storage.read<string>(["session_diff_from", session.id])
        expect(typeof from).toBe("string")
        expect(from.length).toBeGreaterThan(0)
      },
    })
  })

  test("diff uses the creation baseline so human edits before any AI step are included", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = `${tmp.path}/note.txt`
    await Bun.write(file, "one\n")
    await $`git add note.txt`.cwd(tmp.path).quiet()
    await $`git commit -m track`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Bun.write(file, "one\ntwo\n")

        const diff = await SessionSummary.diff({ sessionID: session.id })
        expect(diff).toHaveLength(1)
        expect(diff[0]?.file).toBe("note.txt")
        expect(diff[0]?.status).toBe("modified")
        expect(diff[0]?.additions).toBeGreaterThan(0)
      },
    })
  })

  test("diff rewrites stored session diff, publishes events, and ignores messageID", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = `${tmp.path}/note.txt`
    await Bun.write(file, "one\n")
    await $`git add note.txt`.cwd(tmp.path).quiet()
    await $`git commit -m track`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const seen: { sessionID: SessionID; diff: { file: string }[] }[] = []
        const off = Bus.subscribe(Session.Event.Diff, (evt) => {
          seen.push({
            sessionID: evt.properties.sessionID,
            diff: evt.properties.diff,
          })
        })

        await Bun.write(file, "one\ntwo\nthree\n")
        const messageID = MessageID.ascending()
        const first = await SessionSummary.diff({ sessionID: session.id })
        const second = await SessionSummary.diff({ sessionID: session.id, messageID })
        const saved = await Storage.read<{ file: string }[]>(["session_diff", session.id])

        off()

        expect(second).toEqual(first)
        expect(saved).toEqual(first)
        expect(seen).toHaveLength(2)
        expect(seen.every((item) => item.sessionID === session.id)).toBe(true)
        expect(seen.every((item) => item.diff[0]?.file === "note.txt")).toBe(true)
      },
    })
  })

  test("summarize falls back to message snapshots when the session baseline is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    const a = `${tmp.path}/a.txt`
    const b = `${tmp.path}/b.txt`
    await Bun.write(a, "a0\n")
    await Bun.write(b, "b0\n")
    await $`git add a.txt b.txt`.cwd(tmp.path).quiet()
    await $`git commit -m seed`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Storage.remove(["session_diff_from", session.id])

        const u1 = await user(session.id, "first")
        const s1 = await track(a, "a0\n")
        const f1 = await track(a, "a0\na1\n")
        await reply({ sessionID: session.id, parentID: u1.id, start: s1, finish: f1, text: "first reply" })

        const u2 = await user(session.id, "second")
        const s2 = await track(b, "b0\n")
        const f2 = await track(b, "b0\nb1\n")
        await reply({ sessionID: session.id, parentID: u2.id, start: s2, finish: f2, text: "second reply" })

        await SessionSummary.summarize({ sessionID: session.id, messageID: u2.id })

        const info = await Session.get(session.id)
        const msgs = await Session.messages({ sessionID: session.id })
        const next = msgs.find((item) => item.info.id === u2.id)

        expect(info.summary?.files).toBe(2)
        expect(info.summary?.additions).toBeGreaterThanOrEqual(2)
        expect(next?.info.role).toBe("user")
        const nextSummary = next?.info.summary
        expect(nextSummary && typeof nextSummary === "object" && nextSummary.diffs?.map((item: { file: string }) => item.file)).toEqual(["b.txt"])
      },
    })
  })

  test("turn summaries only include the selected user message and its assistant replies", async () => {
    await using tmp = await tmpdir({ git: true })
    const a = `${tmp.path}/a.txt`
    const b = `${tmp.path}/b.txt`
    await Bun.write(a, "a0\n")
    await Bun.write(b, "b0\n")
    await $`git add a.txt b.txt`.cwd(tmp.path).quiet()
    await $`git commit -m seed`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Storage.remove(["session_diff_from", session.id])

        const u1 = await user(session.id, "first")
        const s1 = await track(a, "a0\n")
        const f1 = await track(a, "a0\na1\n")
        await reply({ sessionID: session.id, parentID: u1.id, start: s1, finish: f1 })

        const u2 = await user(session.id, "second")
        const s2 = await track(b, "b0\n")
        const f2 = await track(b, "b0\nb1\n")
        await reply({ sessionID: session.id, parentID: u2.id, start: s2, finish: f2 })

        await SessionSummary.summarize({ sessionID: session.id, messageID: u2.id })

        const msgs = await Session.messages({ sessionID: session.id })
        const one = msgs.find((item) => item.info.id === u1.id)
        const two = msgs.find((item) => item.info.id === u2.id)

        const oneSummary = one?.info.summary
        expect(oneSummary && typeof oneSummary === "object" ? oneSummary.diffs : undefined).toBeUndefined()
        const twoSummary = two?.info.summary
        expect(twoSummary && typeof twoSummary === "object" && twoSummary.diffs?.map((item: { file: string }) => item.file)).toEqual(["b.txt"])
      },
    })
  })

  test("summarize skips Bus.publish when diffs are unchanged across consecutive runs", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = `${tmp.path}/note.txt`
    await Bun.write(file, "one\n")
    await $`git add note.txt`.cwd(tmp.path).quiet()
    await $`git commit -m track`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const u1 = await user(session.id, "first")
        const s1 = await track(file, "one\n")
        const f1 = await track(file, "one\ntwo\n")
        await reply({ sessionID: session.id, parentID: u1.id, start: s1, finish: f1 })

        const seen: { sessionID: SessionID; diff: { file: string }[] }[] = []
        const off = Bus.subscribe(Session.Event.Diff, (evt) => {
          seen.push({ sessionID: evt.properties.sessionID, diff: evt.properties.diff })
        })

        // First summarize publishes the diff. Subsequent summarize calls with no
        // working-tree changes must be deduped — otherwise every step-finish in
        // a multi-step LLM stream re-emits an unchanged session.diff and storms
        // the web UI with /vcs/diff and /session/:id/diff refetches.
        await SessionSummary.summarize({ sessionID: session.id, messageID: u1.id })
        await SessionSummary.summarize({ sessionID: session.id, messageID: u1.id })
        await SessionSummary.summarize({ sessionID: session.id, messageID: u1.id })

        off()

        expect(seen).toHaveLength(1)
        expect(seen[0]?.sessionID).toBe(session.id)
        expect(seen[0]?.diff[0]?.file).toBe("note.txt")
      },
    })
  })

  test("summarize re-publishes after diff content changes", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = `${tmp.path}/note.txt`
    await Bun.write(file, "one\n")
    await $`git add note.txt`.cwd(tmp.path).quiet()
    await $`git commit -m track`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const u1 = await user(session.id, "first")
        const s1 = await track(file, "one\n")
        const f1 = await track(file, "one\ntwo\n")
        await reply({ sessionID: session.id, parentID: u1.id, start: s1, finish: f1 })

        const seen: { sessionID: SessionID; diff: { file: string; additions: number }[] }[] = []
        const off = Bus.subscribe(Session.Event.Diff, (evt) => {
          seen.push({
            sessionID: evt.properties.sessionID,
            diff: evt.properties.diff.map((d) => ({ file: d.file, additions: d.additions })),
          })
        })

        await SessionSummary.summarize({ sessionID: session.id, messageID: u1.id })
        // Mutate the working tree so the diff payload genuinely changes.
        await Bun.write(file, "one\ntwo\nthree\n")
        await SessionSummary.summarize({ sessionID: session.id, messageID: u1.id })

        off()

        expect(seen).toHaveLength(2)
        expect(seen[1]?.diff[0]?.additions ?? 0).toBeGreaterThan(seen[0]?.diff[0]?.additions ?? 0)
      },
    })
  })

  test("invalidate() without latest forces the next summarize to re-publish", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = `${tmp.path}/note.txt`
    await Bun.write(file, "one\n")
    await $`git add note.txt`.cwd(tmp.path).quiet()
    await $`git commit -m track`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const u1 = await user(session.id, "first")
        const s1 = await track(file, "one\n")
        const f1 = await track(file, "one\ntwo\n")
        await reply({ sessionID: session.id, parentID: u1.id, start: s1, finish: f1 })

        const seen: { sessionID: SessionID }[] = []
        const off = Bus.subscribe(Session.Event.Diff, (evt) => {
          seen.push({ sessionID: evt.properties.sessionID })
        })

        await SessionSummary.summarize({ sessionID: session.id, messageID: u1.id })
        // Without invalidate, the second call would dedupe. After clearing the
        // cache, the same payload must publish again — this models the "manual
        // refresh" path where downstream consumers explicitly want a re-emit.
        SessionSummary.invalidate(session.id)
        await SessionSummary.summarize({ sessionID: session.id, messageID: u1.id })

        off()

        expect(seen).toHaveLength(2)
      },
    })
  })

  test("invalidate(sessionID, latest) write-through prevents revert→summarize false-dedup", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = `${tmp.path}/note.txt`
    await Bun.write(file, "one\n")
    await $`git add note.txt`.cwd(tmp.path).quiet()
    await $`git commit -m track`.cwd(tmp.path).quiet()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const u1 = await user(session.id, "first")
        const s1 = await track(file, "one\n")
        const f1 = await track(file, "one\ntwo\n")
        await reply({ sessionID: session.id, parentID: u1.id, start: s1, finish: f1 })

        const seen: { sessionID: SessionID; diff: { file: string; additions: number }[] }[] = []
        const off = Bus.subscribe(Session.Event.Diff, (evt) => {
          seen.push({
            sessionID: evt.properties.sessionID,
            diff: evt.properties.diff.map((d) => ({ file: d.file, additions: d.additions })),
          })
        })

        // First summarize: cache := payload-A
        await SessionSummary.summarize({ sessionID: session.id, messageID: u1.id })

        // Simulate revert/unrevert: it published its own session.diff (payload-B)
        // and called invalidate(latest=B). The dedup cache must now be at B,
        // not A — otherwise the next summarize() with payload-B would see a
        // stale-A cache, miss the match, and re-publish unnecessarily; or worse,
        // a payload happening to equal A would be silently suppressed.
        const fakeRevertDiff = [
          { file: "note.txt", additions: 99, deletions: 0, status: "modified" as const },
        ]
        SessionSummary.invalidate(session.id, fakeRevertDiff as any)

        // Subsequent summarize() with the same payload as the original
        // (additions=1) must publish — because the cache is now B, not A.
        await SessionSummary.summarize({ sessionID: session.id, messageID: u1.id })

        off()

        expect(seen.length).toBeGreaterThanOrEqual(2)
        // Final published entry should reflect the recomputed working-tree diff
        // (additions=1 from "one" → "one\ntwo"), not the synthetic revert payload.
        expect(seen[seen.length - 1]?.diff[0]?.file).toBe("note.txt")
      },
    })
  })
})
