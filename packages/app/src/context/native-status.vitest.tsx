import { afterEach, describe, expect, test, vi } from "vitest"
import type { NativeCodexStatus } from "@opencode-ai/sdk/v2"
import { createRoot, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { createNativeStatus } from "./native-status"

function status(path = "/codex"): NativeCodexStatus {
  return {
    enabled: true,
    installed: true,
    connected: true,
    auth: "chatgpt",
    path,
    models: [{ id: "model", name: "Model", default: true, efforts: [] }],
  }
}

function deferred() {
  let resolve!: (value: NativeCodexStatus) => void
  let reject!: (error: Error) => void
  const promise = new Promise<NativeCodexStatus>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

let dispose: VoidFunction | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  vi.useRealTimers()
})

describe("native connection status", () => {
  test("a pending probe never suspends switching or the conversation content", async () => {
    const wait = deferred()
    const [state, setState] = createStore({ active: false })
    let calls = 0
    host = document.createElement("div")
    document.body.append(host)
    const Content = () => {
      const probe = createNativeStatus({
        key: () => "server/project/path",
        enabled: () => true,
        active: () => state.active,
        read: () => {
          calls++
          return wait.promise
        },
      })
      return (
        <>
          <p>Conversation stays visible</p>
          <Show when={state.active} fallback={<span>Aether</span>}>
            <span>Codex: {probe.data()?.models[0]?.name ?? "checking"}</span>
          </Show>
        </>
      )
    }
    dispose = render(
      () => (
        <Suspense fallback={<p>Suspended</p>}>
          <Content />
        </Suspense>
      ),
      host,
    )
    expect(host.textContent).toContain("Aether")
    setState("active", true)
    expect(host.textContent).toContain("Codex: checking")
    expect(host.textContent).toContain("Conversation stays visible")
    expect(host.textContent).not.toContain("Suspended")
    setState("active", false)
    setState("active", true)
    expect(calls).toBe(1)
    wait.resolve(status())
    await vi.waitFor(() => expect(host?.textContent).toContain("Codex: Model"))
    expect(calls).toBe(1)
  })

  test("disabled status never probes and a late response cannot re-enable it", async () => {
    const wait = deferred()
    const [state, setState] = createStore({ enabled: false })
    let calls = 0
    const probe = createRoot((cleanup) => {
      dispose = cleanup
      return createNativeStatus({
        key: () => "server/path",
        enabled: () => state.enabled,
        active: () => true,
        read: () => {
          calls++
          return wait.promise
        },
      })
    })
    await probe.refresh()
    expect(calls).toBe(0)
    setState("enabled", true)
    expect(calls).toBe(1)
    setState("enabled", false)
    wait.resolve(status())
    await wait.promise
    await Promise.resolve()
    expect(probe.data()).toBeUndefined()
    expect(probe.fresh()).toBe(false)
    expect(probe.loading()).toBe(false)
  })

  test("a new server or executable path rejects the previous response", async () => {
    const wait = deferred()
    const [state, setState] = createStore({ key: "old" })
    const probe = createRoot((cleanup) => {
      dispose = cleanup
      return createNativeStatus({
        key: () => state.key,
        enabled: () => true,
        active: () => true,
        read: () => (state.key === "old" ? wait.promise : Promise.resolve(status("/new"))),
      })
    })
    setState("key", "new")
    await vi.waitFor(() => expect(probe.data()?.path).toBe("/new"))
    wait.resolve(status("/old"))
    await wait.promise
    await Promise.resolve()
    expect(probe.data()?.path).toBe("/new")
    expect(probe.fresh()).toBe(true)
  })

  test("retains the catalog while an explicit refresh is pending", async () => {
    const wait = deferred()
    const calls: boolean[] = []
    const probe = createRoot((cleanup) => {
      dispose = cleanup
      return createNativeStatus({
        key: () => "server/path",
        enabled: () => true,
        active: () => false,
        read: (refresh) => {
          calls.push(refresh)
          return refresh ? wait.promise : Promise.resolve(status())
        },
      })
    })
    await vi.waitFor(() => expect(probe.fresh()).toBe(true))
    const task = probe.refresh()
    expect(probe.data()?.models[0]?.id).toBe("model")
    expect(probe.loading()).toBe(true)
    expect(probe.fresh()).toBe(false)
    expect(calls).toEqual([false, true])
    wait.resolve(status())
    await task
    expect(probe.fresh()).toBe(true)
  })

  test("an expired inactive catalog is not ready and refreshes when selected", async () => {
    vi.useFakeTimers()
    const wait = deferred()
    const [state, setState] = createStore({ active: false })
    let calls = 0
    const probe = createRoot((cleanup) => {
      dispose = cleanup
      return createNativeStatus({
        key: () => "server/path",
        enabled: () => true,
        active: () => state.active,
        read: () => (++calls === 1 ? Promise.resolve(status()) : wait.promise),
      })
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(probe.fresh()).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probe.fresh()).toBe(false)
    expect(probe.data()?.models).toHaveLength(1)
    expect(calls).toBe(1)
    setState("active", true)
    expect(calls).toBe(2)
    expect(probe.loading()).toBe(true)
    wait.resolve(status())
    await vi.advanceTimersByTimeAsync(0)
    expect(probe.fresh()).toBe(true)
  })

  test("a failed probe is not retried in an endless background loop", async () => {
    vi.useFakeTimers()
    const [state, setState] = createStore({ active: true })
    let calls = 0
    const probe = createRoot((cleanup) => {
      dispose = cleanup
      return createNativeStatus({
        key: () => "server/path",
        enabled: () => true,
        active: () => state.active,
        read: () => {
          calls++
          return Promise.reject(new Error("unavailable"))
        },
      })
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls).toBe(1)
    expect(probe.fresh()).toBe(false)
    expect(probe.error()).toBeInstanceOf(Error)
    setState("active", false)
    setState("active", true)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)
  })
})
