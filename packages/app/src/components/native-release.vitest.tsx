import { describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"
import { render } from "solid-js/web"
import { NativeRelease } from "./native-release"

const mocks = vi.hoisted(() => ({ release: vi.fn() }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({ url: "server", directory: "project", client: { native: { release: mocks.release } } }),
}))
vi.mock("@opencode-ai/ui/dialog", () => ({ Dialog: (props: { children: JSX.Element }) => <div>{props.children}</div> }))

function mount(valid: () => boolean = () => true) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => <NativeRelease sessionID="session" valid={valid} />, host)
  return {
    host,
    [Symbol.dispose]() {
      dispose()
      host.remove()
    },
  }
}

describe("releasing a Codex chat", () => {
  test("prevents duplicate release and displays success after the request finishes", async () => {
    mocks.release.mockReset()
    const result = Promise.withResolvers<unknown>()
    mocks.release.mockReturnValue(result.promise)
    using view = mount()
    view.host.querySelector("button")!.click()
    view.host.querySelector("button")!.click()
    expect(mocks.release).toHaveBeenCalledOnce()
    expect(view.host.querySelector("[role=status]")).toBeNull()
    result.resolve({ data: { released: true } })
    await vi.waitFor(() => expect(view.host.querySelector("[role=status]")?.textContent).toBe("native.release.done"))
  })
  test("shows refusal without claiming release and allows retry", async () => {
    mocks.release.mockReset().mockRejectedValue({ error: "Task is running" })
    using view = mount()
    view.host.querySelector("button")!.click()
    await vi.waitFor(() => expect(view.host.querySelector("[role=alert]")?.textContent).toBe("Task is running"))
    expect(view.host.querySelector("[role=status]")).toBeNull()
    expect(view.host.querySelector("button")!.disabled).toBe(false)
  })
  test("navigation makes an old dialog inert and discards its late result", async () => {
    mocks.release.mockReset()
    const result = Promise.withResolvers<unknown>()
    mocks.release.mockReturnValue(result.promise)
    let valid = true
    using view = mount(() => valid)
    view.host.querySelector("button")!.click()
    valid = false
    result.resolve({ data: { released: true } })
    await Promise.resolve()
    await Promise.resolve()
    expect(view.host.querySelector("[role=status]")).toBeNull()
    view.host.querySelector("button")!.click()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
