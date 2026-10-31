import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { UserMessageContent } from "./user-message-content"

const observers = new Set<() => void>()
const frames = new Map<number, FrameRequestCallback>()
const roots = new Set<() => void>()
const heights = new Map<HTMLElement, () => number>()

beforeEach(() => {
  const rect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const match = [...heights].find(([host]) => host.contains(this))
    if (match && this.dataset.slot === "user-message-content") return new DOMRect(0, 0, 300, match[1]())
    return rect.call(this)
  })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        observers.add(this.callback)
      }
      disconnect() {
        observers.delete(this.callback)
      }
    },
  )
  let serial = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++serial, callback)
    return serial
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
})

afterEach(() => {
  roots.forEach((off) => off())
  roots.clear()
  heights.clear()
  observers.clear()
  frames.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

function mount(height: number, extra?: { enabled?: boolean; resize?: () => (() => void) | void; click?: () => void }) {
  const [state, setState] = createStore({
    height,
    enabled: extra?.enabled ?? true,
    id: "msg",
    text: "full original text",
  })
  const host = document.createElement("div")
  host.style.lineHeight = "20px"
  document.body.append(host)
  heights.set(host, () => state.height)
  const off = render(
    () => (
      <div onClick={extra?.click}>
        <UserMessageContent id={state.id} version={state.text} collapse={state.enabled} onResize={extra?.resize}>
          <span data-highlight="file">{state.text}</span>
        </UserMessageContent>
      </div>
    ),
    host,
  )
  roots.add(off)
  const button = () => host.querySelector<HTMLButtonElement>("button")
  const viewport = () => host.querySelector<HTMLElement>('[data-slot="user-message-viewport"]')!
  return { host, state, setState, off, button, viewport }
}

function flush() {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => callback(0))
}

describe("long user message content", () => {
  test.each([180, 200, 220])("uses actual rendered height around ten lines: %s", (height) => {
    const { host, button } = mount(height)
    expect(!!button()).toBe(height > 200)
    expect(host.querySelector('[data-slot="user-message-content"]')?.textContent).toBe("full original text")
    expect(host.querySelector('[data-highlight="file"]')?.textContent).toBe("full original text")
    if (!button()) return
    expect(button()?.textContent).toContain("Show more")
    expect(button()?.getAttribute("aria-expanded")).toBe("false")
    expect(document.getElementById(button()!.getAttribute("aria-controls")!)?.dataset.slot).toBe("user-message-content")
  })

  test("toggles independently without bubbling and brackets the layout change", () => {
    const events: string[] = []
    const click = vi.fn()
    const first = mount(260, {
      click,
      resize: () => {
        events.push(first.button()!.getAttribute("aria-expanded")!)
        return () => events.push(first.button()!.getAttribute("aria-expanded")!)
      },
    })
    const second = mount(260)
    first.button()!.click()
    expect(events).toEqual(["false"])
    expect(first.button()?.getAttribute("aria-expanded")).toBe("true")
    expect(first.button()?.textContent).toContain("Show less")
    expect(first.viewport().hasAttribute("data-collapsed")).toBe(false)
    expect(second.button()?.getAttribute("aria-expanded")).toBe("false")
    expect(click).not.toHaveBeenCalled()
    flush()
    expect(events).toEqual(["false", "true"])
    first.button()!.click()
    flush()
    expect(events).toEqual(["false", "true", "true", "false"])
    expect(first.viewport().getAttribute("data-collapsed")).toBe("true")
  })

  test("retains explicit expansion across reflow but resets for new text and identity", () => {
    const view = mount(240)
    view.button()!.click()
    view.setState("height", 180)
    observers.forEach((callback) => callback())
    expect(view.button()).toBeNull()
    view.setState("height", 300)
    observers.forEach((callback) => callback())
    expect(view.button()?.getAttribute("aria-expanded")).toBe("true")
    view.setState("text", "changed original")
    expect(view.button()?.getAttribute("aria-expanded")).toBe("false")
    view.button()!.click()
    view.setState("id", "other")
    expect(view.button()?.getAttribute("aria-expanded")).toBe("false")
    expect(view.host.querySelector('[data-slot="user-message-content"]')?.textContent).toBe("changed original")
  })

  test("starts disabled without a hydration interaction and reapplies defaults when enabled", () => {
    const before = vi.fn(() => vi.fn())
    const view = mount(300, { enabled: false, resize: before })
    expect(view.button()).toBeNull()
    expect(view.viewport().hasAttribute("data-collapsed")).toBe(false)
    expect(before).not.toHaveBeenCalled()
    view.setState("enabled", true)
    expect(before).not.toHaveBeenCalled()
    expect(view.button()?.getAttribute("aria-expanded")).toBe("false")
    view.button()!.click()
    view.setState("enabled", false)
    expect(frames.size).toBe(0)
    expect(view.button()).toBeNull()
    expect(view.viewport().hasAttribute("data-collapsed")).toBe(false)
    view.setState("enabled", true)
    expect(view.button()?.getAttribute("aria-expanded")).toBe("false")
  })

  test("reveals a search match without repeating display changes for already visible content", () => {
    const before = vi.fn(() => vi.fn())
    const view = mount(300, { resize: before })
    const content = view.host.querySelector<HTMLElement>('[data-slot="user-message-content"]')!
    content.dispatchEvent(new Event("beforematch"))
    expect(view.button()?.getAttribute("aria-expanded")).toBe("true")
    expect(before).toHaveBeenCalledOnce()
    content.dispatchEvent(new Event("beforematch"))
    expect(before).toHaveBeenCalledOnce()
    view.setState("enabled", false)
    content.dispatchEvent(new Event("beforematch"))
    expect(before).toHaveBeenCalledOnce()
    const short = mount(100, { resize: before })
    short.host.querySelector<HTMLElement>('[data-slot="user-message-content"]')!.dispatchEvent(new Event("beforematch"))
    expect(before).toHaveBeenCalledOnce()
    view.off()
    roots.delete(view.off)
    content.dispatchEvent(new Event("beforematch"))
    expect(before).toHaveBeenCalledOnce()
  })

  test("remeasures line metrics on resize and cleans observers and pending layout callbacks", () => {
    const after = vi.fn()
    const view = mount(240, { resize: () => after })
    view.host.style.lineHeight = "30px"
    window.dispatchEvent(new Event("resize"))
    expect(view.button()).toBeNull()
    view.host.style.lineHeight = "20px"
    window.dispatchEvent(new Event("resize"))
    view.button()!.click()
    expect(observers.size).toBe(1)
    expect(frames.size).toBe(1)
    view.off()
    roots.delete(view.off)
    expect(observers.size).toBe(0)
    expect(frames.size).toBe(0)
    flush()
    expect(after).not.toHaveBeenCalled()
  })
})
