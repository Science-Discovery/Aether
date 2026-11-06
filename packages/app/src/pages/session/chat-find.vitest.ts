import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { createChatFind } from "./chat-find"

const frames = new Map<number, FrameRequestCallback>()
const disposals: (() => void)[] = []

beforeEach(() => {
  let serial = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++serial, callback)
    return serial
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 1000, 50, 20))
})

afterEach(() => {
  disposals.splice(0).forEach((off) => off())
  frames.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

function flush() {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => callback(0))
}

function mount() {
  const view = document.createElement("div")
  view.className = "scroll-view__viewport"
  view.tabIndex = -1
  view.innerHTML =
    '<div data-collapsed="true"><div data-slot="user-message-content"><span>hidden first hidden second</span></div></div>'
  document.body.append(view)
  Object.defineProperty(view, "clientHeight", { value: 600 })
  view.getBoundingClientRect = () => new DOMRect(0, 0, 400, 600)
  const content = view.querySelector<HTMLElement>('[data-slot="user-message-content"]')!
  content.getBoundingClientRect = () => new DOMRect(0, 0, 400, 400)
  content.parentElement!.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200)
  const reveal = vi.fn()
  content.addEventListener("beforematch", reveal)
  const root = createRoot((off) => ({ off, find: createChatFind({ root: () => view }) }))
  disposals.push(root.off)
  view.focus()
  view.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }))
  flush()
  expect(root.find.open()).toBe(true)
  root.find.setQuery("hidden")
  expect(reveal).toHaveBeenCalledOnce()
  return { view, root, reveal }
}

test.each(["close", "query", "next", "dispose"])("cancels stale collapsed-hit centering after %s", (action) => {
  const { view, root, reveal } = mount()
  if (action === "close") root.find.close()
  if (action === "query") root.find.setQuery("missing")
  if (action === "next") root.find.next(1)
  if (action === "dispose") {
    root.off()
    disposals.splice(disposals.indexOf(root.off), 1)
  }
  flush()
  expect(view.scrollTop).toBe(action === "next" ? 710 : 0)
  expect(reveal).toHaveBeenCalledTimes(action === "next" ? 2 : 1)
})
