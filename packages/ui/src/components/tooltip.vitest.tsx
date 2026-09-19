import { afterEach, describe, expect, test } from "vitest"
import { render } from "solid-js/web"
import { createSignal, type JSX } from "solid-js"
import { Tooltip } from "./tooltip"

const wait = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const content = () => document.body.querySelector('[data-component="tooltip"]')

function trigger(host: HTMLElement) {
  const el = host.querySelector<HTMLElement>('[data-component="tooltip-trigger"]')
  if (!el) throw new Error("tooltip trigger not found")
  return el
}

function hover(el: HTMLElement) {
  el.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }))
}

function unhover(el: HTMLElement) {
  el.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }))
}

let dispose: (() => void) | undefined

function mount(ui: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(ui, host)
  return host
}

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

describe("Tooltip", () => {
  test("stays hidden while a descendant is expanded", async () => {
    const host = mount(() => (
      <Tooltip value="hint" openDelay={0}>
        <button type="button" aria-expanded="true">
          toggle
        </button>
      </Tooltip>
    ))

    hover(trigger(host))
    await wait()
    expect(content()).toBeNull()

    unhover(trigger(host))
    hover(trigger(host))
    await wait()
    expect(content()).toBeNull()
  })

  test("shows while a descendant is expanded when hideOnExpand is false", async () => {
    const host = mount(() => (
      <Tooltip value="hint" openDelay={0} hideOnExpand={false}>
        <button type="button" aria-expanded="true">
          toggle
        </button>
      </Tooltip>
    ))

    hover(trigger(host))
    await wait()
    expect(content()).not.toBeNull()
    expect(content()?.textContent).toContain("hint")
  })

  test("tracks expansion changes when hideOnExpand is false", async () => {
    const [open, setOpen] = createSignal(true)
    const host = mount(() => (
      <Tooltip value={open() ? "close" : "open"} openDelay={0} hideOnExpand={false}>
        <button type="button" aria-expanded={open()}>
          toggle
        </button>
      </Tooltip>
    ))

    hover(trigger(host))
    await wait()
    expect(content()?.textContent).toContain("close")

    setOpen(false)
    await wait()
    expect(content()?.textContent).toContain("open")
  })

  test("opens by default when nothing is expanded", async () => {
    const host = mount(() => (
      <Tooltip value="hint" openDelay={0}>
        <button type="button">plain</button>
      </Tooltip>
    ))

    hover(trigger(host))
    await wait()
    expect(content()).not.toBeNull()
    expect(content()?.textContent).toContain("hint")
  })
})
