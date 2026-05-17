import { afterEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { CodeEditor } from "./code-editor"

const wait = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  document.body.innerHTML = ""
})

describe("code editor wrapping", () => {
  test("enables wrapping for wrapped editors", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const off = render(
      () => (
        <div style={{ width: "240px", height: "160px" }}>
          <CodeEditor content={"alpha beta gamma delta epsilon ".repeat(8)} filename="notes.md" onChange={() => {}} wordWrap />
        </div>
      ),
      host,
    )

    await wait()

    expect(host.querySelector(".cm-lineWrapping")).toBeTruthy()

    off()
  })

  test("reports horizontal scroll for nowrap editors", async () => {
    const spy = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    const off = render(
      () => (
        <div style={{ width: "240px", height: "160px" }}>
          <CodeEditor
            content={"averyveryveryveryveryveryveryveryveryveryverylongline"}
            filename="notes.md"
            onChange={() => {}}
            wordWrap={false}
            onScroll={spy}
          />
        </div>
      ),
      host,
    )

    await wait()

    expect(host.querySelector(".cm-lineWrapping")).toBeNull()
    const el = host.querySelector(".cm-scroller") as HTMLElement | null
    expect(el).toBeTruthy()
    expect(getComputedStyle(el!).overflowX).toBe("auto")

    Object.defineProperty(el, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 64,
    })
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      writable: true,
      value: 12,
    })

    el?.dispatchEvent(new Event("scroll"))
    await wait()

    expect(spy).toHaveBeenCalledWith({ x: 64, y: 12 })

    off()
  })
})
