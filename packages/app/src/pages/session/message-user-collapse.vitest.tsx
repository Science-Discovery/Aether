import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { UserMessageContent } from "@opencode-ai/ui/user-message-content"
import { createUserCollapse } from "./message-user-collapse"

const frames = new Map<number, FrameRequestCallback>()
const disposals: (() => void)[] = []

beforeEach(() => {
  let serial = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++serial, callback)
    return serial
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
})

afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
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

function mount(height = 400, enabled = true) {
  const [state, setState] = createStore({ enabled })
  const host = document.createElement("div")
  const view = document.createElement("div")
  view.className = "scroll-view__viewport"
  view.style.setProperty("--session-title-block", "54px")
  view.style.lineHeight = "20px"
  host.append(view)
  document.body.append(host)
  view.getBoundingClientRect = () => new DOMRect(0, 0, 500, 600)
  const pause = vi.fn()
  const resize = vi.fn()
  const off = render(() => {
    const collapse = createUserCollapse({
      enabled: () => state.enabled,
      root: () => host,
      pause,
    })
    return [0, 1, 2].map((index) => (
      <div data-slot="session-turn-message-container" data-index={index}>
        <UserMessageContent id={String(index)} version="original" collapse={collapse.enabled()} onResize={resize}>
          <span>Original text {index}</span>
        </UserMessageContent>
      </div>
    ))
  }, view)
  disposals.push(off)
  const turns = [...view.querySelectorAll<HTMLElement>('[data-slot="session-turn-message-container"]')]
  const size = (el: HTMLElement) => 400 + (el.querySelector('[data-collapsed="true"]') ? Math.min(height, 200) : height)
  turns.forEach((el, index) => {
    el.getBoundingClientRect = () =>
      new DOMRect(0, turns.slice(0, index).reduce((sum, item) => sum + size(item), 0) - view.scrollTop, 400, size(el))
    el.querySelector<HTMLElement>('[data-slot="user-message-content"]')!.getBoundingClientRect = () =>
      new DOMRect(0, 0, 300, height)
  })
  return { host, view, turns, pause, resize, set: setState, off }
}

describe("global user message collapse", () => {
  test("uses one visible turn anchor when multiple rendered messages change height", () => {
    const item = mount()
    item.view.scrollTop = 650
    const top = item.turns[1].getBoundingClientRect().top
    item.set("enabled", false)
    expect(item.pause).toHaveBeenCalledOnce()
    expect(item.resize).not.toHaveBeenCalled()
    expect(frames.size).toBe(1)
    flush()
    expect(item.view.scrollTop).toBe(850)
    expect(item.turns[1].getBoundingClientRect().top).toBe(top)
    item.set("enabled", true)
    flush()
    expect(item.view.scrollTop).toBe(650)
    expect(item.turns[1].getBoundingClientRect().top).toBe(top)
    expect(item.pause).toHaveBeenCalledTimes(2)
  })

  test("does not pause or reposition a session with only short user messages", () => {
    const item = mount(100)
    item.view.scrollTop = 650
    item.set("enabled", false)
    item.set("enabled", true)
    expect(item.pause).not.toHaveBeenCalled()
    expect(item.resize).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
    expect(item.view.scrollTop).toBe(650)
  })

  test("does not pause initial restoration and cancels stale anchor callbacks", () => {
    const item = mount(400, false)
    expect(item.pause).not.toHaveBeenCalled()
    item.view.scrollTop = 850
    item.set("enabled", true)
    expect(frames.size).toBe(1)
    item.turns[1].remove()
    flush()
    expect(item.view.scrollTop).toBe(850)
    item.set("enabled", false)
    expect(frames.size).toBe(1)
    item.off()
    disposals.splice(disposals.indexOf(item.off), 1)
    expect(frames.size).toBe(0)
  })
})
