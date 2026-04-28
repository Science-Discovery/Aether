import { afterEach, describe, expect, test } from "vitest"
import { render } from "solid-js/web"
import { DialogProvider, useDialog } from "./dialog"

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function Second() {
  const dialog = useDialog()
  return (
    <div data-dialog="second">
      <button type="button" onClick={() => dialog.close()}>
        close second
      </button>
    </div>
  )
}

function First() {
  const dialog = useDialog()
  return (
    <div data-dialog="first">
      <button
        type="button"
        onClick={() => {
          dialog.close()
          dialog.show(() => <Second />)
        }}
      >
        open second
      </button>
    </div>
  )
}

function App() {
  const dialog = useDialog()
  return (
    <>
      <button type="button" onClick={() => dialog.show(() => <First />)}>
        open first
      </button>
      <div data-state={dialog.active ? "open" : "closed"} />
    </>
  )
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("dialog stack", () => {
  test("removes a closing dialog even after another dialog is pushed on top", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const off = render(
      () => (
        <DialogProvider>
          <App />
        </DialogProvider>
      ),
      host,
    )

    const open = document.querySelector("button")
    open?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()

    const next = [...document.querySelectorAll("button")].find((item) => item.textContent === "open second")
    next?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await wait(150)

    expect(document.querySelector('[data-dialog="second"]')).toBeTruthy()
    expect(document.querySelector("[data-state]")?.getAttribute("data-state")).toBe("open")

    const close = [...document.querySelectorAll("button")].find((item) => item.textContent === "close second")
    close?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await wait(150)

    expect(document.querySelector("[data-state]")?.getAttribute("data-state")).toBe("closed")

    off()
  })
})
