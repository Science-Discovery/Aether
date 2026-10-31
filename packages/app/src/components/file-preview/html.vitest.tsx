import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createEffect, createRoot, createSignal, on } from "solid-js"
import { render } from "solid-js/web"
import type { HtmlOutput } from "./html-bridge"
import type { htmlRender } from "./html-render"

const pending = vi.hoisted(
  () =>
    [] as Array<{
      input: Parameters<typeof htmlRender>[0]
      resolve: (value: HtmlOutput) => void
      reject: (error: Error) => void
    }>,
)
vi.mock("@/context/language", () => ({ useLanguage: () => ({ locale: () => "zh" }) }))
vi.mock("./html-render", () => ({
  htmlRender: (input: Parameters<typeof htmlRender>[0]) =>
    new Promise<HtmlOutput>((resolve, reject) => {
      pending.push({ input, resolve, reject })
    }),
}))

import Html from "./html"

const result = (html = "<p>hello</p>", deps: string[] = []) => ({ html, deps, missing: 0, blocked: 0 })
const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
const disposers: Array<() => void> = []

beforeEach(() => {
  pending.length = 0
  vi.useFakeTimers()
})
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  vi.useRealTimers()
})

function mount(props: Partial<Parameters<typeof Html>[0]> = {}) {
  const host = document.createElement("div")
  document.body.append(host)
  const error = vi.fn()
  const dispose = render(
    () => (
      <Html
        path="site/index.html"
        source="<p>hello</p>"
        version={0}
        read={async () => {
          throw new Error("unexpected")
        }}
        onError={error}
        {...props}
      />
    ),
    host,
  )
  disposers.push(dispose)
  return { host, dispose, error }
}

describe("HTML preview component", () => {
  test("mounts a sandboxed readable frame only when conversion succeeds", async () => {
    const fixture = mount()
    expect(fixture.host.querySelector("iframe")).toBeNull()
    expect(fixture.host.textContent).toContain("正在准备预览")
    pending[0]!.resolve(result())
    await tick()
    const frame = fixture.host.querySelector("iframe")!
    expect(frame.getAttribute("sandbox")).toBe("")
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(frame.getAttribute("srcdoc")).toBe("<p>hello</p>")
    expect(["#fff", "rgb(255, 255, 255)"]).toContain(frame.style.backgroundColor)
    expect(fixture.error).not.toHaveBeenCalled()
  })
  test("exposes reactive dependencies and refreshes changed CSS drafts without looping", async () => {
    const [draft, update] = createSignal("body{color:red}")
    const stop = vi.fn()
    const fixture = mount({
      draft: (path) => (path === "site/theme.css" ? draft() : undefined),
      subscribe: (paths, callback) =>
        createRoot((dispose) => {
          createEffect(
            on(
              () => JSON.stringify([...paths()].map((path) => [path, path === "site/theme.css" ? draft() : undefined])),
              callback,
              { defer: true },
            ),
          )
          return () => {
            stop()
            dispose()
          }
        }),
    })
    pending[0]!.resolve(result("first", ["site/theme.css"]))
    await tick()
    await vi.advanceTimersByTimeAsync(200)
    expect(pending).toHaveLength(2)
    pending[1]!.resolve(result("second", ["site/theme.css"]))
    await tick()
    await vi.advanceTimersByTimeAsync(200)
    expect(pending).toHaveLength(2)
    update("body{color:blue}")
    await vi.advanceTimersByTimeAsync(200)
    expect(pending).toHaveLength(3)
    fixture.dispose()
    disposers.splice(disposers.indexOf(fixture.dispose), 1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(pending[2]!.input.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  test("aborts replaced sources and refuses late results from the old document", async () => {
    const [source, update] = createSignal("first")
    const fixture = mount({
      get source() {
        return source()
      },
    })
    update("second")
    expect(pending[0]!.input.signal.aborted).toBe(true)
    pending[1]!.resolve(result("new document"))
    await tick()
    pending[0]!.resolve(result("old document"))
    await tick()
    expect(fixture.host.querySelector("iframe")?.getAttribute("srcdoc")).toBe("new document")
    expect(fixture.error).not.toHaveBeenCalled()
  })
  test("clears stale content on failed refresh and permits an explicit retry", async () => {
    const fixture = mount()
    pending[0]!.resolve(result("first"))
    await tick()
    ;(fixture.host.querySelector('button[aria-label="刷新预览"]') as HTMLButtonElement).click()
    expect(fixture.host.querySelector("iframe")).toBeNull()
    pending[1]!.reject(new Error("timeout"))
    await tick()
    expect(fixture.host.textContent).toContain("无法预览此网页")
    expect(fixture.error).toHaveBeenCalledTimes(1)
    ;(fixture.host.querySelector('[role="alert"] button') as HTMLButtonElement).click()
    pending[2]!.resolve(result("retried"))
    await tick()
    expect(fixture.host.querySelector("iframe")?.getAttribute("srcdoc")).toBe("retried")
  })
  test("unmount cancels pending work and debounced refreshes", async () => {
    let callback: (() => void) | undefined
    const stop = vi.fn()
    const fixture = mount({
      subscribe: (_paths, update) => {
        callback = update
        return stop
      },
    })
    callback?.()
    fixture.dispose()
    disposers.splice(disposers.indexOf(fixture.dispose), 1)
    expect(pending[0]!.input.signal.aborted).toBe(true)
    pending[0]!.reject(new Error("late failure"))
    await tick()
    await vi.advanceTimersByTimeAsync(500)
    expect(pending).toHaveLength(1)
    expect(fixture.error).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
