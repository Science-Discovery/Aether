import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createNativeRun, type NativeRun } from "./native-run"

const idle = (): NativeRun => ({ active: null, queue: { paused: false, items: [] } })
const active = (): NativeRun => ({
  ...idle(),
  active: { phase: "running", turnID: "turn-1", mode: "default", steer: true },
})
let dispose: VoidFunction | undefined

function setup(opts: Partial<Parameters<typeof createNativeRun>[0]> = {}) {
  const [state, set] = createStore({ id: "one", server: "local", enabled: true, working: false })
  const reads: string[] = []
  const sent: { messageID: string; turnID: string; text: string }[] = []
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
      steer: async (input) => {
        sent.push(input)
        return { status: "accepted" }
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

  test("retains the request identity and expected turn when a failed HTTP request is retried", async () => {
    const calls: { messageID: string; turnID: string; text: string }[] = []
    let running = true
    const fixture = setup({
      read: async () => (running ? active() : idle()),
      steer: async (input) => {
        calls.push(input)
        if (calls.length === 1) {
          running = false
          throw new Error("connection closed")
        }
        return { status: "accepted" }
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await fixture.run.submit("steer", "Keep the original file")).toBe(false)
    expect(fixture.run.notice()?.type).toBe("error")
    expect(fixture.run.retry()).toBe("steer")
    await fixture.run.remove("unrelated-queue-entry")
    expect(fixture.run.retry()).toBe("steer")
    await fixture.run.refresh()
    expect(fixture.run.data()?.active).toBeNull()
    expect(await fixture.run.submit("steer", "Keep the original file")).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(calls[1].turnID).toBe("turn-1")
    expect(fixture.run.notice()?.type).toBe("accepted")
    expect(fixture.run.retry()).toBeUndefined()
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
    expect(await fixture.run.submit("queue", "Next task")).toBe(false)
    expect(fixture.run.notice()?.text).toBe("connection interrupted")
    model = "changed"
    expect(await fixture.run.submit("queue", "Next task")).toBe(true)
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
    expect(await fixture.run.submit("queue", "Preserved draft")).toBe(false)
    expect(fixture.run.retry()).toBe("queue")
    fixture.run.discard()
    expect(fixture.run.retry()).toBeUndefined()
    expect(fixture.run.notice()?.type).toBe("discarded")
    expect(count).toBe(1)
  })

  test("preserves an unresolved request when its text or action is changed", async () => {
    const calls: { messageID: string; text: string }[] = []
    const fixture = setup({
      read: async () => active(),
      steer: async (input) => {
        calls.push(input)
        if (calls.length === 1) throw new Error("connection closed")
        return { status: "accepted" }
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await fixture.run.submit("steer", "Original draft")).toBe(false)
    expect(await fixture.run.submit("steer", "Edited draft")).toBe(false)
    expect(await fixture.run.submit("queue", "Original draft")).toBe(false)
    expect(calls).toHaveLength(1)
    expect(fixture.queued).toHaveLength(0)
    expect(fixture.run.retry()).toBe("steer")
    expect(fixture.run.notice()?.type).toBe("retry")
    expect(await fixture.run.submit("steer", "Original draft")).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
  })

  test("records uncertain delivery without a silent retry and retains rejected input", async () => {
    let count = 0
    const fixture = setup({
      read: async () => active(),
      steer: async () => {
        count++
        return { status: count === 1 ? "uncertain" : "rejected", error: "turn ended" }
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await fixture.run.submit("steer", "First")).toBe(true)
    expect(fixture.run.notice()?.type).toBe("uncertain")
    await vi.advanceTimersByTimeAsync(4_000)
    expect(count).toBe(1)
    expect(await fixture.run.submit("steer", "Second")).toBe(false)
    expect(fixture.run.notice()?.type).toBe("rejected")
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
    const first = fixture.run.submit("queue", "Next task")
    expect(fixture.run.busy()).toBe(true)
    expect(await fixture.run.submit("queue", "Duplicate")).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ sessionID: "one", text: "Next task", model: "model", effort: "high" })
    fixture.set("id", "two")
    expect(fixture.run.busy()).toBe(false)
    pending.resolve(idle().queue)
    expect(await first).toBe(true)
    expect(fixture.run.notice()).toBeUndefined()
    expect(fixture.run.busy()).toBe(false)
  })
})
