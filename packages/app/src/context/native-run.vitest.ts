import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createNativeRun, type NativeRun } from "./native-run"

const idle = (): NativeRun => ({ active: null, queue: { paused: false, items: [] } })
const active = (): NativeRun => ({
  ...idle(),
  active: { phase: "running", turnID: "turn-1", mode: "default", steer: true },
})
const waiting = (): NativeRun => ({
  ...active(),
  queue: {
    paused: false,
    items: ["first", "second"].map((id) => ({ id, text: id, state: "pending", created: 0 })),
  },
})
let dispose: VoidFunction | undefined

function setup(opts: Partial<Parameters<typeof createNativeRun>[0]> = {}) {
  const [state, set] = createStore({ id: "one", server: "local", enabled: true, working: false })
  const reads: string[] = []
  const sent: { messageID: string; turnID: string }[] = []
  const queued: { sessionID: string; messageID: string; text: string; model?: string; effort?: string }[] = []
  const run = createRoot((cleanup) => {
    dispose = cleanup
    return createNativeRun({
      key: () => `${state.server}/${state.id}`,
      id: () => state.id,
      enabled: () => state.enabled,
      working: () => state.working,
      selection: () => ({ model: "model", effort: "high" }),
      read: async (id) => {
        reads.push(id)
        return idle()
      },
      send: async (input) => {
        sent.push(input)
        return { queue: idle().queue, delivery: { ...input, status: "accepted" } }
      },
      enqueue: async (input) => {
        queued.push(input)
        return idle().queue
      },
      dequeue: async () => idle().queue,
      resume: async () => idle().queue,
      ...opts,
    })
  })
  return { run, state, set, reads, sent, queued }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.useRealTimers()
})

describe("native active-turn controls", () => {
  test("reads idle state once and makes no background calls after disable or disposal", async () => {
    const fixture = setup()
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.reads).toEqual(["one"])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fixture.reads).toEqual(["one"])
    fixture.set("enabled", false)
    await fixture.run.refresh()
    expect(fixture.run.data()).toBeUndefined()
    expect(fixture.reads).toEqual(["one"])
    dispose?.()
    await fixture.run.refresh()
    expect(fixture.reads).toEqual(["one"])
  })

  test("ignores an old session snapshot and preserves the selected session", async () => {
    const pending = Promise.withResolvers<NativeRun>()
    const fixture = setup({ read: (id) => (id === "one" ? pending.promise : Promise.resolve(active())) })
    fixture.set("id", "two")
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.run.data()?.active?.turnID).toBe("turn-1")
    pending.resolve(idle())
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.run.data()?.active?.turnID).toBe("turn-1")
  })

  test("polls a running session and stops polling after it becomes idle", async () => {
    let count = 0
    const fixture = setup({ read: async () => (++count === 1 ? active() : idle()) })
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.run.data()?.active).not.toBeNull()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fixture.run.data()?.active).toBeNull()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(count).toBe(2)
  })

  test("always queues running input instead of sending it into the current turn", async () => {
    const fixture = setup({ read: async () => active() })
    await vi.advanceTimersByTimeAsync(0)
    expect(await fixture.run.submit("Continue after this task")).toBe(true)
    expect(fixture.queued).toHaveLength(1)
    expect(fixture.sent).toHaveLength(0)
  })

  test("only sends pending entries while the active turn supports steering", async () => {
    const snapshot = waiting()
    snapshot.active!.steer = false
    const fixture = setup({ read: async () => structuredClone(snapshot) })
    await vi.advanceTimersByTimeAsync(0)
    expect(await fixture.run.send("first")).toBe(false)
    snapshot.active!.steer = true
    snapshot.queue.items[0].state = "dispatching"
    await fixture.run.refresh()
    expect(await fixture.run.send("first")).toBe(false)
    expect(await fixture.run.send("missing")).toBe(false)
    expect(fixture.sent).toHaveLength(0)
    expect(await fixture.run.send("second")).toBe(true)
    expect(fixture.sent).toEqual([{ sessionID: "one", messageID: "second", turnID: "turn-1" }])
  })

  test("retains the queued message and expected turn when checking an unconfirmed delivery", async () => {
    const calls: { messageID: string; turnID: string }[] = []
    let running = true
    const fixture = setup({
      read: async () => (running ? waiting() : idle()),
      send: async (input) => {
        calls.push(input)
        if (calls.length === 1) {
          running = false
          throw new Error("connection closed")
        }
        return { queue: idle().queue, delivery: { ...input, status: "accepted" } }
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await fixture.run.send("first")).toBe(false)
    expect(fixture.run.notice()?.type).toBe("error")
    expect(fixture.run.unconfirmed()).toBe("first")
    expect(await fixture.run.send("second")).toBe(false)
    expect(calls).toHaveLength(1)
    await fixture.run.remove("unrelated-queue-entry")
    expect(fixture.run.unconfirmed()).toBe("first")
    await fixture.run.refresh()
    expect(fixture.run.data()?.active).toBeNull()
    expect(await fixture.run.send("first")).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(calls[1].turnID).toBe("turn-1")
    expect(fixture.run.notice()?.type).toBe("accepted")
    expect(fixture.run.unconfirmed()).toBeUndefined()
  })

  test("retries a failed enqueue with the original identity and model snapshot", async () => {
    const calls: { messageID: string; model?: string; effort?: string }[] = []
    let model = "original"
    const fixture = setup({
      selection: () => ({ model, effort: "high" }),
      enqueue: async (input) => {
        calls.push(input)
        if (calls.length === 1) throw { error: "connection interrupted" }
        return idle().queue
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await fixture.run.submit("Next task")).toBe(false)
    expect(fixture.run.notice()?.text).toBe("connection interrupted")
    model = "changed"
    expect(await fixture.run.submit("Next task")).toBe(true)
    expect(calls[0]).toEqual(calls[1])
    expect(calls[1].model).toBe("original")
  })

  test("allows explicitly discarding an unresolved retry without another submission", async () => {
    let count = 0
    const fixture = setup({
      enqueue: async () => {
        count++
        throw { error: "This message has already been submitted. Check the conversation before sending again." }
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await fixture.run.submit("Preserved draft")).toBe(false)
    expect(fixture.run.retry()).toBe(true)
    fixture.run.discard()
    expect(fixture.run.retry()).toBe(false)
    expect(fixture.run.notice()?.type).toBe("discarded")
    expect(count).toBe(1)
  })

  test("preserves an unresolved enqueue request when its text is changed", async () => {
    const calls: { messageID: string; text: string }[] = []
    const fixture = setup({
      read: async () => active(),
      enqueue: async (input) => {
        calls.push(input)
        if (calls.length === 1) throw new Error("connection closed")
        return idle().queue
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await fixture.run.submit("Original draft")).toBe(false)
    expect(await fixture.run.submit("Edited draft")).toBe(false)
    expect(calls).toHaveLength(1)
    expect(fixture.run.retry()).toBe(true)
    expect(fixture.run.notice()?.type).toBe("retry")
    expect(await fixture.run.submit("Original draft")).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
  })

  test("records uncertain delivery without retrying and preserves rejected queue entries", async () => {
    let count = 0
    const snapshot = waiting()
    const fixture = setup({
      read: async () => structuredClone(snapshot),
      send: async (input) => {
        count++
        if (count === 1) snapshot.queue.items[0].state = "uncertain"
        return {
          queue: structuredClone(snapshot.queue),
          delivery: { ...input, status: count === 1 ? "uncertain" : "rejected", error: "turn ended" },
        }
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await fixture.run.send("first")).toBe(true)
    expect(fixture.run.notice()?.type).toBe("uncertain")
    expect(fixture.run.unconfirmed()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(count).toBe(1)
    expect(await fixture.run.send("first")).toBe(false)
    expect(count).toBe(1)
    expect(await fixture.run.send("second")).toBe(false)
    expect(fixture.run.notice()?.type).toBe("rejected")
    expect(fixture.run.data()?.queue.items[1].state).toBe("pending")
  })

  test("serializes submissions and queues the model selection without steering another turn", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof idle>["queue"]>()
    const calls: { sessionID: string; messageID: string; text: string; model?: string; effort?: string }[] = []
    const fixture = setup({
      enqueue: async (input) => {
        calls.push(input)
        return pending.promise
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    const first = fixture.run.submit("Next task")
    expect(fixture.run.busy()).toBe(true)
    expect(await fixture.run.submit("Duplicate")).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ sessionID: "one", text: "Next task", model: "model", effort: "high" })
    fixture.set("id", "two")
    expect(fixture.run.busy()).toBe(false)
    pending.resolve(idle().queue)
    expect(await first).toBe(true)
    expect(fixture.run.notice()).toBeUndefined()
    expect(fixture.run.busy()).toBe(false)
  })

  test("does not apply queued delivery results to a newly selected conversation", async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<Parameters<typeof createNativeRun>[0]["send"]>>>()
    const fixture = setup({
      read: async (id) => (id === "one" ? waiting() : idle()),
      send: () => pending.promise,
    })
    await vi.advanceTimersByTimeAsync(0)
    const first = fixture.run.send("first")
    expect(fixture.run.busy()).toBe(true)
    fixture.set("id", "two")
    await vi.advanceTimersByTimeAsync(0)
    pending.resolve({
      queue: waiting().queue,
      delivery: { status: "accepted", messageID: "first", turnID: "turn-1" },
    })
    expect(await first).toBe(true)
    expect(fixture.run.data()).toEqual(idle())
    expect(fixture.run.notice()).toBeUndefined()
    expect(fixture.run.unconfirmed()).toBeUndefined()
  })
})
