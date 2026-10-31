import { afterEach, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { createAutoScroll } from "./create-auto-scroll"

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

test("explicit display changes can pause before expansion creates overflow", async () => {
  const callbacks = new Set<ResizeObserverCallback>()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.add(callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  const view = document.createElement("div")
  const content = document.createElement("div")
  view.append(content)
  document.body.append(view)
  const state = { height: 200 }
  Object.defineProperty(view, "clientHeight", { get: () => 300 })
  Object.defineProperty(view, "scrollHeight", { get: () => state.height })
  const paused = vi.fn()
  const root = createRoot((dispose) => ({
    dispose,
    scroll: createAutoScroll({ working: () => true, onUserInteracted: paused }),
  }))
  root.scroll.scrollRef(view)
  root.scroll.contentRef(content)
  await Promise.resolve()
  root.scroll.pause()
  expect(root.scroll.userScrolled()).toBe(false)
  root.scroll.pause(true)
  expect(root.scroll.userScrolled()).toBe(true)
  expect(paused).toHaveBeenCalledOnce()
  root.scroll.handleScroll()
  expect(root.scroll.userScrolled()).toBe(true)
  expect(callbacks.size).toBeGreaterThan(0)
  state.height = 900
  for (const callback of callbacks) {
    callback(
      [{ target: content, contentRect: new DOMRect(0, 0, 300, 900) } as ResizeObserverEntry],
      {} as ResizeObserver,
    )
  }
  expect(root.scroll.userScrolled()).toBe(true)
  root.scroll.scrollToBottom()
  expect(view.scrollTop).toBe(0)
  root.scroll.resume()
  expect(root.scroll.userScrolled()).toBe(false)
  expect(view.scrollTop).toBe(900)
  root.dispose()
})
