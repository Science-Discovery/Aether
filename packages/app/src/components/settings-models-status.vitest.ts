import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createModelsStatus } from "./settings-models-status"

const cleanup: Array<() => void> = []

function setup() {
  const state = {
    checkedAt: 1,
    updatedAt: 1,
    error: null as string | null,
    enabled: false,
    pending: undefined as Promise<void> | undefined,
    calls: [] as string[],
  }
  const value = createRoot((dispose) => {
    cleanup.push(dispose)
    const event = createGlobalEmitter<{ [key: string]: Event }>()
    const client = createOpencodeClient({
      baseUrl: "http://models.test",
      fetch: async (request) => {
        const path = new URL(request instanceof Request ? request.url : String(request)).pathname
        state.calls.push(path)
        await state.pending
        return Response.json({
          source: "remote",
          checkedAt: state.checkedAt,
          updatedAt: state.updatedAt,
          etag: "catalog",
          hash: "catalog",
          error: state.error,
          ...(path.includes("codex") ? { enabled: state.enabled } : {}),
        })
      },
    })
    return { ...createModelsStatus({ client, event }), event, dispose }
  })
  return { ...value, state }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose())
  vi.useRealTimers()
})

describe("model catalog status", () => {
  test("refreshes checks and errors without a catalog change event", async () => {
    const value = setup()
    await vi.advanceTimersByTimeAsync(0)
    expect(value.status()?.checkedAt).toBe(1)
    expect(value.codex()?.enabled).toBe(false)

    value.state.checkedAt = 2
    value.state.error = "temporary upstream failure"
    await vi.advanceTimersByTimeAsync(15_000)
    expect(value.status()?.checkedAt).toBe(2)
    expect(value.status()?.updatedAt).toBe(1)
    expect(value.status()?.error).toBe("temporary upstream failure")
    expect(value.codex()?.error).toBe("temporary upstream failure")

    value.state.checkedAt = 3
    value.state.error = null
    await vi.advanceTimersByTimeAsync(15_000)
    expect(value.status()?.checkedAt).toBe(3)
    expect(value.status()?.error).toBeNull()
    expect(value.codex()?.checkedAt).toBe(3)
    expect(value.state.calls).toHaveLength(6)
  })

  test.each(["provider.updated", "provider.models.updated"] as const)("refreshes on %s", async (type) => {
    const value = setup()
    await vi.advanceTimersByTimeAsync(0)
    value.state.checkedAt = 2
    value.state.enabled = true
    const event: Event =
      type === "provider.updated"
        ? { type, properties: {} }
        : { type, properties: { checkedAt: 2, updatedAt: 1, hash: "catalog" } }

    value.event.emit("project", event)
    await vi.advanceTimersByTimeAsync(0)
    expect(value.state.calls).toHaveLength(2)
    value.event.emit("global", event)
    await vi.advanceTimersByTimeAsync(0)
    expect(value.status()?.checkedAt).toBe(2)
    expect(value.codex()?.enabled).toBe(true)
    expect(value.state.calls).toHaveLength(4)
  })

  test("avoids overlapping requests and stops polling when settings close", async () => {
    const value = setup()
    await vi.advanceTimersByTimeAsync(0)
    const pending = Promise.withResolvers<void>()
    value.state.pending = pending.promise
    await vi.advanceTimersByTimeAsync(15_000)
    expect(value.state.calls).toHaveLength(4)
    value.event.emit("global", { type: "provider.updated", properties: {} })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(value.state.calls).toHaveLength(4)

    value.dispose()
    pending.resolve()
    await vi.advanceTimersByTimeAsync(0)
    value.event.emit("global", { type: "provider.updated", properties: {} })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(value.state.calls).toHaveLength(4)
    expect(vi.getTimerCount()).toBe(0)
  })
})
