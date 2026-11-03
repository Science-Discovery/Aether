import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"
import type { NativeAuthStatus } from "@opencode-ai/sdk/v2"
import { NativeLogin } from "./native-login"

const mocks = vi.hoisted(() => ({
  local: true,
  open: vi.fn(),
  refresh: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  copy: vi.fn(),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ openLink: mocks.open }) }))
vi.mock("@/context/server", () => ({ useServer: () => ({ isLocal: () => mocks.local }) }))
vi.mock("@/context/native-status", () => ({ refreshNativeStatus: mocks.refresh }))
vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: JSX.Element; disabled?: boolean; onClick?: () => void; "data-action"?: string }) => (
    <button disabled={props.disabled} onClick={props.onClick} data-action={props["data-action"]}>
      {props.children}
    </button>
  ),
}))

const client = {
  native: { login: mocks.post, loginStatus: mocks.get, cancelLogin: mocks.cancel },
} as unknown as Parameters<typeof NativeLogin>[0]["client"]
const [state, setState] = createStore({ scope: "local\n/project\n", server: "http://localhost:1234", disabled: false })
const pending = (id: string, method: "browser" | "device" = "browser"): NativeAuthStatus => ({
  id,
  method,
  state: "pending",
  url: "https://auth.openai.com/codex/device",
  ...(method === "device" ? { code: "ABCD-EFGH", expiresAt: Date.now() + 60_000 } : {}),
})
const ok = (data: NativeAuthStatus) => ({ data, response: new Response(null, { status: 200 }) })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let host: HTMLDivElement
let dispose: VoidFunction
const click = (action: string) =>
  host.querySelector<HTMLButtonElement>(`[data-action="native-login${action}"]`)!.click()

beforeEach(() => {
  vi.useFakeTimers()
  mocks.local = true
  mocks.open.mockReset()
  mocks.refresh.mockReset().mockResolvedValue(undefined)
  mocks.copy.mockReset().mockResolvedValue(undefined)
  mocks.post
    .mockReset()
    .mockImplementation(async (input: { id: string; method: "browser" | "device" }) =>
      ok(pending(input.id, input.method)),
    )
  mocks.get.mockReset().mockImplementation(async (input: { id: string }) => ok(pending(input.id)))
  mocks.cancel
    .mockReset()
    .mockImplementation(async (input: { id: string }) =>
      ok({ id: input.id, method: mocks.local ? "browser" : "device", state: "cancelled" }),
    )
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.copy } })
  setState({ scope: "local\n/project\n", server: "http://localhost:1234", disabled: false })
  host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () => <NativeLogin client={client} scope={state.scope} server={state.server} disabled={state.disabled} />,
    host,
  )
})
afterEach(() => {
  dispose()
  host.remove()
  vi.useRealTimers()
})

describe("native sign-in", () => {
  test("starts one browser attempt locally and polls without reopening its link", async () => {
    click("")
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1))
    expect(mocks.post.mock.calls[0][0]).toMatchObject({ method: "browser" })
    expect(host.querySelector('[data-action="native-login"]')).toBeNull()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.open).toHaveBeenCalledTimes(1)
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })

  test("uses a device code by default for remote servers and supports copying and cancellation", async () => {
    mocks.local = false
    click("")
    await vi.waitFor(() => expect(host.textContent).toContain("ABCD-EFGH"))
    expect(mocks.post.mock.calls[0][0]).toMatchObject({ method: "device" })
    click("-copy")
    await vi.waitFor(() => expect(mocks.copy).toHaveBeenCalledWith("ABCD-EFGH"))
    click("-cancel")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.cancelled"))
    expect(mocks.cancel.mock.calls[0][0].id).toBe(mocks.post.mock.calls[0][0].id)
    expect(host.querySelector('[data-component="native-login-code"]')).toBeNull()
  })

  test("offers device-code fallback locally", async () => {
    click("-device")
    await vi.waitFor(() => expect(host.textContent).toContain("ABCD-EFGH"))
    expect(mocks.post.mock.calls[0][0].method).toBe("device")
  })

  test("refreshes all probes after completion before allowing another sign-in", async () => {
    const refresh = deferred<void>()
    mocks.refresh.mockReturnValue(refresh.promise)
    mocks.get.mockImplementation(async (input: { id: string }) => ok({ ...pending(input.id), state: "complete" }))
    click("")
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.refresh).toHaveBeenCalledWith("http://localhost:1234")
    expect(host.textContent).toContain("native.login.verifying")
    expect(host.querySelector('[data-action="native-login"]')).toBeNull()
    refresh.resolve()
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.complete"))
    expect(host.textContent).not.toContain("native.setup.ready")
  })

  test("recovers a lost start response using its UUID without creating another attempt", async () => {
    mocks.post.mockRejectedValue(new Error("Response lost"))
    click("")
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1))
    expect(mocks.get.mock.calls[0][0].id).toBe(mocks.post.mock.calls[0][0].id)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.pending"))
  })

  test("keeps uncertain attempts for status checks and does not start a duplicate", async () => {
    mocks.post.mockRejectedValue(new Error("Response lost"))
    mocks.get.mockRejectedValueOnce(new Error("Offline"))
    click("")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.recovering"))
    expect(host.querySelector('[data-action="native-login"]')).toBeNull()
    click("-check")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.pending"))
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(new Set(mocks.get.mock.calls.map((call) => call[0].id)).size).toBe(1)
  })

  test("handles nonthrowing SDK network errors without an HTTP response", async () => {
    mocks.post.mockResolvedValue({ error: new Error("Start response lost"), response: undefined })
    mocks.get.mockResolvedValueOnce({ error: new Error("Offline"), response: undefined })
    click("")
    await vi.waitFor(() => expect(host.textContent).toContain("Offline"))
    expect(host.textContent).not.toContain("Cannot read")
    expect(host.textContent).toContain("native.login.recovering")
    click("-check")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.pending"))
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })

  test("allows retry when a failed start is confirmed absent", async () => {
    mocks.post.mockRejectedValue(new Error("Could not start login"))
    mocks.get.mockResolvedValue({ error: { error: "Login not found" }, response: new Response(null, { status: 404 }) })
    click("")
    await vi.waitFor(() => expect(host.textContent).toContain("Could not start login"))
    expect(host.querySelector('[data-action="native-login"]')).not.toBeNull()
  })

  test("reports a rejected start without querying or cancelling another login", async () => {
    mocks.post.mockResolvedValue({
      error: { error: "A login is already in progress" },
      response: new Response(null, { status: 409 }),
    })
    click("")
    await vi.waitFor(() => expect(host.textContent).toContain("A login is already in progress"))
    expect(host.querySelector('[data-action="native-login"]')).not.toBeNull()
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  test("an expired server-side attempt releases the local attempt on an actual 404", async () => {
    click("")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.pending"))
    mocks.get.mockResolvedValue({ error: { error: "Login not found" }, response: new Response(null, { status: 404 }) })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(host.textContent).toContain("Login not found")
    expect(host.querySelector('[data-action="native-login"]')).not.toBeNull()
  })

  test("does not permit a new attempt while cancellation is uncertain", async () => {
    click("")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.pending"))
    mocks.cancel.mockRejectedValueOnce(new Error("Offline"))
    click("-cancel")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.recovering"))
    expect(host.querySelector('[data-action="native-login"]')).toBeNull()
    click("-cancel")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.cancelled"))
  })

  test("a late poll cannot restore a cancelled attempt", async () => {
    const response = deferred<ReturnType<typeof ok>>()
    mocks.get.mockReturnValue(response.promise)
    click("")
    await vi.advanceTimersByTimeAsync(2_000)
    click("-cancel")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.cancelled"))
    response.resolve(ok(pending(mocks.post.mock.calls[0][0].id)))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(host.textContent).toContain("native.login.cancelled")
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })

  test("a late lookup error for a cancelled attempt cannot clear its replacement", async () => {
    const response = deferred<{ error: { error: string }; response: Response }>()
    mocks.get.mockReturnValueOnce(response.promise)
    click("")
    await vi.advanceTimersByTimeAsync(2_000)
    click("-cancel")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.cancelled"))
    click("")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.pending"))
    const id = mocks.post.mock.calls[1][0].id
    response.resolve({ error: { error: "Old login not found" }, response: new Response(null, { status: 404 }) })
    await vi.advanceTimersByTimeAsync(1)
    expect(host.textContent).not.toContain("Old login not found")
    expect(host.textContent).toContain("native.login.pending")
    click("-cancel")
    await vi.waitFor(() => expect(mocks.cancel.mock.calls.at(-1)?.[0]).toEqual({ id }))
  })

  test("cancels a device attempt before its initial POST is acknowledged", async () => {
    const response = deferred<ReturnType<typeof ok>>()
    mocks.post.mockReturnValue(response.promise)
    click("-device")
    const id = mocks.post.mock.calls[0][0].id
    click("-cancel")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.cancelled"))
    response.resolve(ok({ ...pending(id, "device"), state: "cancelled" }))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(host.textContent).toContain("native.login.cancelled")
    expect(mocks.open).not.toHaveBeenCalled()
    expect(host.querySelector('[data-action="native-login"]')).not.toBeNull()
  })

  test("scope changes cancel the owned attempt and ignore its late initial response", async () => {
    const response = deferred<ReturnType<typeof ok>>()
    mocks.post.mockReturnValue(response.promise)
    click("")
    const id = mocks.post.mock.calls[0][0].id
    setState({ scope: "other\n/project\n", server: "http://other:1234" })
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith({ id }, expect.anything()))
    response.resolve(ok(pending(id)))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain("native.login.pending")
    expect(mocks.cancel).toHaveBeenCalledTimes(2)
  })

  test("closing settings cancels only its own pending attempt", async () => {
    click("")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.pending"))
    const id = mocks.post.mock.calls[0][0].id
    dispose()
    expect(mocks.cancel).toHaveBeenCalledWith({ id }, expect.anything())
    await vi.advanceTimersByTimeAsync(4_000)
    expect(mocks.get).not.toHaveBeenCalled()
  })

  test("expired attempts can be retried with a different UUID", async () => {
    mocks.post.mockImplementation(async (input: { id: string }) => ok({ ...pending(input.id), state: "expired" }))
    click("")
    await vi.waitFor(() => expect(host.textContent).toContain("native.login.expired"))
    click("")
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2))
    expect(mocks.post.mock.calls[1][0].id).not.toBe(mocks.post.mock.calls[0][0].id)
  })
})
