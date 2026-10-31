import { afterEach, describe, expect, test, vi } from "vitest"
import { observe } from "./session-pin"

function setup(input: { height: number; viewport: number; local?: boolean }) {
  const state = { ...input }
  const view = document.createElement("div")
  if (input.local) view.setAttribute("data-slot", "session-turn-content")
  if (!input.local) view.className = "scroll-view__viewport"
  const el = document.createElement("div")
  el.style.top = "54px"
  view.append(el)
  document.body.append(view)
  Object.defineProperty(view, "clientHeight", { get: () => state.viewport })
  el.getBoundingClientRect = () => new DOMRect(0, 0, 300, state.height)
  const resize = { fire: () => {}, observed: [] as Element[], disconnected: false }
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize.fire = callback
      }
      observe(target: Element) {
        resize.observed.push(target)
      }
      disconnect() {
        resize.disconnected = true
      }
    },
  )
  const off = observe(el)
  return { state, el, view, resize, off }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("user message sticky placement", () => {
  test("keeps a complete multiline message at the positive header offset", () => {
    const { el, view, resize, off } = setup({ height: 150, viewport: 600 })
    expect(el.getAttribute("data-sticky")).toBe("true")
    expect(el.style.top).toBe("54px")
    expect(el.style.getPropertyValue("--pin-shift")).toBe("")
    expect(resize.observed).toEqual([el, view])
    off()
  })

  test("lets an oversized prompt scroll normally and recovers after reflow", () => {
    const { state, el, resize, off } = setup({ height: 700, viewport: 600 })
    expect(el.getAttribute("data-sticky")).toBe("false")
    state.height = 200
    resize.fire()
    expect(el.getAttribute("data-sticky")).toBe("true")
    state.viewport = 220
    resize.fire()
    expect(el.getAttribute("data-sticky")).toBe("false")
    state.viewport = 600
    resize.fire()
    expect(el.getAttribute("data-sticky")).toBe("true")
    off()
  })

  test("does not pin when the message exactly consumes the remaining viewport", () => {
    const { el, off } = setup({ height: 546, viewport: 600 })
    expect(el.getAttribute("data-sticky")).toBe("false")
    off()
  })

  test("restores sticky behavior after a hidden panel becomes visible", () => {
    const { state, el, resize, off } = setup({ height: 150, viewport: 0 })
    expect(el.getAttribute("data-sticky")).toBe("false")
    state.viewport = 600
    resize.fire()
    expect(el.getAttribute("data-sticky")).toBe("true")
    off()
    expect(resize.disconnected).toBe(true)
    expect(el.hasAttribute("data-sticky")).toBe(false)
  })

  test("uses the local scroll container when rendered outside a timeline", () => {
    const { el, off } = setup({ height: 150, viewport: 600, local: true })
    expect(el.getAttribute("data-sticky")).toBe("true")
    off()
  })

  test("leaves a detached message unchanged", () => {
    const el = document.createElement("div")
    expect(observe(el)).not.toThrow()
    expect(el.hasAttribute("data-sticky")).toBe(false)
  })
})
