import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"
import type { NativeMcpAuthStatus } from "@opencode-ai/sdk/v2"
import { NativeMcp } from "./native-mcp"

const mocks = vi.hoisted(() => ({
  directory: () => "/project",
  open: vi.fn(),
  mcp: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ openLink: mocks.open }) }))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    url: "local",
    get directory() {
      return mocks.directory()
    },
    client: {
      native: { mcp: mocks.mcp, mcpLogin: mocks.post, mcpLoginStatus: mocks.get, cancelMcpLogin: mocks.cancel },
    },
  }),
}))
vi.mock("@opencode-ai/ui/dialog", () => ({ Dialog: (props: { children: JSX.Element }) => <div>{props.children}</div> }))
vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: JSX.Element; disabled?: boolean; onClick?: () => void; "data-action"?: string }) => (
    <button disabled={props.disabled} onClick={props.onClick} data-action={props["data-action"]}>
      {props.children}
    </button>
  ),
}))
const pending = (id: string): NativeMcpAuthStatus => ({
  id,
  name: "papers",
  state: "pending",
  url: "https://example.com/oauth",
})
const ok = (data: NativeMcpAuthStatus) => ({ data, response: new Response(null, { status: 200 }) })
const catalog = (auth = "notLoggedIn", scope = "catalog") => ({
  data: {
    state: "ready",
    scope,
    servers: [{ name: "papers", status: "unknown", auth, tools: [] }],
  },
})
let host: HTMLDivElement
let dispose: VoidFunction
let change: (value: string) => void
const button = (action: string) => host.querySelector<HTMLButtonElement>(`[data-action="mcp-${action}"]`)
const click = (action: string) => button(action)!.click()

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  const [state, setState] = createStore({ directory: "/project" })
  mocks.directory = () => state.directory
  change = (value) => setState("directory", value)
  mocks.mcp.mockResolvedValue(catalog())
  mocks.post.mockImplementation(async (input: { id: string }) => ok(pending(input.id)))
  mocks.get.mockImplementation(async (input: { id: string }) => ok(pending(input.id)))
  mocks.cancel.mockImplementation(async (input: { id: string }) => ok({ id: input.id, state: "cancelled" }))
  host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => <NativeMcp sessionID="session" />, host)
})
afterEach(() => {
  dispose()
  host.remove()
  vi.useRealTimers()
})

test("MCP uses the conversation identity, starts OAuth only on click, and never automatically opens its URL", async () => {
  await vi.waitFor(() => expect(button("login")?.disabled).toBe(false))
  expect(mocks.mcp).toHaveBeenCalledWith({ refresh: false, sessionID: "session" }, { throwOnError: true })
  expect(host.textContent).toContain("native.mcp.description")
  expect(mocks.post).not.toHaveBeenCalled()
  click("login")
  await vi.waitFor(() => expect(button("open")).not.toBeNull())
  expect(mocks.open).not.toHaveBeenCalled()
  click("open")
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledWith("https://example.com/oauth"))
  await vi.advanceTimersByTimeAsync(2_000)
  expect(mocks.get).toHaveBeenCalledTimes(1)
  expect(mocks.post).toHaveBeenCalledTimes(1)
  expect(mocks.open).toHaveBeenCalledTimes(1)
})

test("MCP unsupported or token authentication has no OAuth login button", async () => {
  mocks.mcp.mockResolvedValue(catalog("unsupported", "session"))
  change("/unsupported")
  await vi.waitFor(() => expect(host.textContent).toContain("native.mcp.auth.unsupported"))
  expect(host.textContent).toContain("native.mcp.session")
  expect(button("login")).toBeNull()
  mocks.mcp.mockResolvedValue(catalog("bearerToken"))
  change("/token")
  await vi.waitFor(() => expect(host.textContent).toContain("native.mcp.auth.token"))
  expect(button("login")).toBeNull()
})

test("MCP a lost OAuth response recovers using the same UUID and never starts twice", async () => {
  mocks.post.mockRejectedValue(new Error("Response lost"))
  mocks.get.mockRejectedValueOnce(new Error("Offline"))
  await vi.waitFor(() => expect(button("login")?.disabled).toBe(false))
  click("login")
  await vi.waitFor(() => expect(host.textContent).toContain("native.mcp.login.recovering"))
  expect(button("login")?.disabled).toBe(true)
  click("check")
  await vi.waitFor(() => expect(host.textContent).toContain("native.mcp.login.pending"))
  expect(mocks.post).toHaveBeenCalledTimes(1)
  expect(new Set(mocks.get.mock.calls.map(([input]) => input.id))).toEqual(new Set([mocks.post.mock.calls[0][0].id]))
})

test("MCP a missing attempt after a lost start response is cancelled before permitting another start", async () => {
  mocks.post.mockRejectedValue(new Error("Response lost"))
  mocks.get.mockResolvedValue({ error: { error: "Missing" }, response: new Response(null, { status: 404 }) })
  const stop = Promise.withResolvers<ReturnType<typeof ok>>()
  mocks.cancel.mockReturnValueOnce(stop.promise)
  await vi.waitFor(() => expect(button("login")?.disabled).toBe(false))
  click("login")
  await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(1))
  expect(button("login")?.disabled).toBe(true)
  stop.resolve(ok({ id: mocks.post.mock.calls[0][0].id, state: "cancelled" }))
  await vi.waitFor(() => expect(button("login")?.disabled).toBe(false))
  expect(mocks.cancel.mock.calls[0][0].id).toBe(mocks.post.mock.calls[0][0].id)
})

test("MCP cancellation clears authorization and late pending status cannot restore it", async () => {
  const status = Promise.withResolvers<ReturnType<typeof ok>>()
  mocks.get.mockReturnValueOnce(status.promise)
  await vi.waitFor(() => expect(button("login")?.disabled).toBe(false))
  click("login")
  await vi.waitFor(() => expect(button("open")).not.toBeNull())
  await vi.advanceTimersByTimeAsync(2_000)
  click("cancel")
  await vi.waitFor(() => expect(host.textContent).toContain("native.mcp.login.cancelled"))
  status.resolve(ok(pending(mocks.post.mock.calls[0][0].id)))
  await Promise.resolve()
  expect(button("open")).toBeNull()
  expect(host.textContent).toContain("native.mcp.login.cancelled")
})

test("MCP switching project cancels pending authorization and discards a late login response", async () => {
  const post = Promise.withResolvers<ReturnType<typeof ok>>()
  mocks.post.mockReturnValueOnce(post.promise)
  await vi.waitFor(() => expect(button("login")?.disabled).toBe(false))
  click("login")
  const id = mocks.post.mock.calls[0][0].id
  change("/another")
  await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith({ id }, expect.anything()))
  post.resolve(ok(pending(id)))
  await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(2))
  expect(button("open")).toBeNull()
  expect(mocks.open).not.toHaveBeenCalled()
})

test("MCP success refreshes inventory while provider rejection leaves retry available", async () => {
  mocks.get.mockImplementationOnce(async (input: { id: string }) =>
    ok({ id: input.id, name: "papers", state: "complete" }),
  )
  await vi.waitFor(() => expect(button("login")?.disabled).toBe(false))
  click("login")
  await vi.advanceTimersByTimeAsync(2_000)
  await vi.waitFor(() => expect(mocks.mcp).toHaveBeenCalledTimes(2))
  expect(mocks.mcp.mock.calls[1][0]).toMatchObject({ refresh: true, sessionID: "session" })
  expect(host.textContent).toContain("native.mcp.login.complete")
  expect(button("open")).toBeNull()
  mocks.post.mockResolvedValueOnce({
    error: { error: "Other login in progress" },
    response: new Response(null, { status: 409 }),
  })
  click("login")
  await vi.waitFor(() => expect(host.textContent).toContain("Other login in progress"))
  expect(mocks.cancel).not.toHaveBeenCalled()
  expect(button("login")?.disabled).toBe(false)
})

test("MCP refuses browser navigation for an invalid authorization URL", async () => {
  mocks.post.mockImplementationOnce(async (input: { id: string }) =>
    ok({ ...pending(input.id), url: "javascript:alert(1)" }),
  )
  await vi.waitFor(() => expect(button("login")?.disabled).toBe(false))
  click("login")
  await vi.waitFor(() => expect(button("open")).not.toBeNull())
  click("open")
  await vi.waitFor(() => expect(host.textContent).toContain("native.mcp.login.invalid"))
  expect(mocks.open).not.toHaveBeenCalled()
})

test("MCP a previous project's late browser error cannot overwrite the current panel", async () => {
  const opened = Promise.withResolvers<void>()
  mocks.open.mockReturnValueOnce(opened.promise)
  await vi.waitFor(() => expect(button("login")?.disabled).toBe(false))
  click("login")
  await vi.waitFor(() => expect(button("open")).not.toBeNull())
  click("open")
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
  change("/another")
  await vi.waitFor(() => expect(button("login")?.disabled).toBe(false))
  opened.reject(new Error("Old browser failure"))
  await Promise.resolve()
  await Promise.resolve()
  expect(host.textContent).not.toContain("Old browser failure")
})

test("MCP authorization success preserves the reconnect warning after refreshing the inventory", async () => {
  mocks.get.mockImplementationOnce(async (input: { id: string }) =>
    ok({
      id: input.id,
      name: "papers",
      state: "complete",
      error: "Existing tools need /release to reconnect",
    }),
  )
  await vi.waitFor(() => expect(button("login")?.disabled).toBe(false))
  click("login")
  await vi.advanceTimersByTimeAsync(2_000)
  await vi.waitFor(() => expect(mocks.mcp).toHaveBeenCalledTimes(2))
  expect(host.textContent).toContain("native.mcp.login.complete")
  expect(host.textContent).toContain("Existing tools need /release to reconnect")
  expect(button("open")).toBeNull()
})
