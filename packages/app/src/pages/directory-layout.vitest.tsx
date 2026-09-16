import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createMemoryHistory, MemoryRouter, Route, useNavigate, useParams } from "@solidjs/router"
import { type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { base64Encode } from "@opencode-ai/util/encode"
import { OpenIntent } from "@/utils/open-intent"

const state = vi.hoisted(() => ({
  path: "",
  mounts: [] as string[],
  directories: vi.fn(async () => ({ data: [] as string[] })),
  toast: vi.fn(),
}))

vi.mock("@opencode-ai/ui/context", () => ({ DataProvider: (props: ParentProps) => props.children }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: state.toast }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/local", () => ({ LocalProvider: (props: ParentProps) => props.children }))
vi.mock("@/context/server", () => ({ useServer: () => server }))
vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({ createClient: () => ({ project: { directories: state.directories } }) }),
}))
vi.mock("@/context/sdk", () => ({
  SDKProvider: (props: ParentProps<{ directory: () => string }>) => {
    state.mounts.push(props.directory())
    return props.children
  },
}))
vi.mock("@/context/sync", () => ({
  SyncProvider: (props: ParentProps) => props.children,
  useSync: () => ({
    data: {
      path: {
        get directory() {
          return state.path
        },
      },
    },
  }),
}))

import Layout from "./directory-layout"

const disposers: (() => void)[] = []
const [server, set] = createStore({ key: "local" })

function mount(dir: string, opts: { base?: string; slug?: string; suffix?: string } = {}) {
  const history = createMemoryHistory()
  history.set({ value: `${opts.base ?? ""}/${opts.slug ?? base64Encode(dir)}/session/one${opts.suffix ?? ""}` })
  const host = document.createElement("div")
  document.body.appendChild(host)
  const session = () => {
    const params = useParams()
    const navigate = useNavigate()
    return <button onClick={() => navigate(`/${base64Encode(dir)}/session/two`)}>{params.id}</button>
  }
  const dispose = render(
    () => (
      <MemoryRouter history={history} base={opts.base}>
        <Route path="/" component={() => <div>home</div>} />
        <Route path="/:dir" component={Layout}>
          <Route path="/session/:id?" component={session} />
          <Route path="/session/:id/reading" component={session} />
        </Route>
      </MemoryRouter>
    ),
    host,
  )
  disposers.push(() => {
    dispose()
    host.remove()
  })
  return { history, host }
}

beforeEach(() => {
  state.path = ""
  set("key", "local")
  state.mounts = []
  state.toast.mockClear()
  state.directories.mockReset().mockResolvedValue({ data: [] })
})

afterEach(() => disposers.splice(0).forEach((dispose) => dispose()))

describe("directory layout navigation", () => {
  test("keeps an explicitly opened directory mounted when switching sessions", async () => {
    const dir = "F:/Desktop/Paper"
    OpenIntent.mark(server.key, dir)
    const app = mount(dir)
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    app.host.querySelector("button")!.click()
    await vi.waitFor(() => expect(app.host.textContent).toBe("two"))
    expect(state.directories).not.toHaveBeenCalled()
    expect(state.mounts).toEqual([dir])
    expect(state.toast).not.toHaveBeenCalled()
  })

  test("switches sessions through a Windows directory alias", async () => {
    const dir = "F:/Desktop/Paper"
    state.path = "F:\\Desktop\\Paper"
    state.directories.mockResolvedValue({ data: [state.path] })
    OpenIntent.mark(server.key, dir)
    const app = mount(dir)
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    app.host.querySelector("button")!.click()
    await vi.waitFor(() => expect(app.host.textContent).toBe("two"))
    expect(app.history.get()).toBe(`/${base64Encode(state.path)}/session/two`)
    expect(state.toast).not.toHaveBeenCalled()
  })

  test("keeps switching sessions through a Windows alias when the directory endpoint is unavailable", async () => {
    const dir = "F:/Desktop/Paper"
    state.path = "F:\\Desktop\\Paper"
    state.directories.mockRejectedValue(new Error("Failed to fetch"))
    OpenIntent.mark(server.key, dir)
    const app = mount(dir)
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    app.host.querySelector("button")!.click()
    await vi.waitFor(() => expect(app.host.textContent).toBe("two"))
    expect(app.history.get()).toBe(`/${base64Encode(state.path)}/session/two`)
    expect(state.directories).not.toHaveBeenCalled()
    expect(state.toast).not.toHaveBeenCalled()
  })

  test("reuses a fresh directory check for equivalent session links", async () => {
    const dir = "F:/Desktop/Paper/"
    state.path = "F:\\Desktop\\Paper"
    state.directories.mockResolvedValueOnce({ data: [state.path] }).mockRejectedValue(new Error("Failed to fetch"))
    const app = mount(dir)
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    app.host.querySelector("button")!.click()
    await vi.waitFor(() => expect(app.host.textContent).toBe("two"))
    expect(state.directories).toHaveBeenCalledTimes(1)
    expect(state.toast).not.toHaveBeenCalled()
  })

  test("still checks a different directory before mounting its providers", async () => {
    const dir = "F:/Desktop/Paper"
    OpenIntent.mark(server.key, dir)
    const app = mount(dir)
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    app.history.set({ value: `/${base64Encode("F:/Desktop/Other")}/session/two` })
    await vi.waitFor(() => expect(app.host.textContent).toBe("home"))
    expect(state.directories).toHaveBeenCalledTimes(1)
    expect(state.mounts).toEqual([dir])
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "directory.error.invalidUrl" }))
  })

  test("blocks an unknown directory on the initial route", async () => {
    const app = mount("F:/Desktop/Unknown")
    await vi.waitFor(() => expect(app.host.textContent).toBe("home"))
    expect(state.directories).toHaveBeenCalledTimes(1)
    expect(state.mounts).toEqual([])
  })

  test("does not reuse directory access across servers", async () => {
    const dir = "F:/Desktop/Paper"
    OpenIntent.mark(server.key, dir)
    const app = mount(dir)
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    set("key", "remote")
    await vi.waitFor(() => expect(app.host.textContent).toBe("home"))
    expect(state.directories).toHaveBeenCalledTimes(1)
    expect(state.mounts).toEqual([dir])
  })

  test("does not preserve directory access after leaving the project", async () => {
    const dir = "F:/Desktop/Paper"
    OpenIntent.mark(server.key, dir)
    const app = mount(dir)
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    app.host.querySelector("button")!.click()
    await vi.waitFor(() => expect(app.host.textContent).toBe("two"))
    app.history.set({ value: "/" })
    await vi.waitFor(() => expect(app.host.textContent).toBe("home"))
    app.history.set({ value: `/${base64Encode(dir)}/session/two` })
    await vi.waitFor(() => expect(state.directories).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(app.host.textContent).toBe("home"))
    expect(state.mounts).toEqual([dir])
  })

  test("ignores an old directory response after navigating to an unknown directory", async () => {
    const dir = "F:/Desktop/Paper"
    const pending = Promise.withResolvers<{ data: string[] }>()
    state.directories.mockReturnValueOnce(pending.promise)
    const app = mount(dir)
    await vi.waitFor(() => expect(state.directories).toHaveBeenCalledTimes(1))
    app.history.set({ value: `/${base64Encode("F:/Desktop/Other")}/session/two` })
    await vi.waitFor(() => expect(app.host.textContent).toBe("home"))
    pending.resolve({ data: [dir] })
    await pending.promise
    expect(app.history.get()).toBe("/")
    expect(state.mounts).toEqual([])
  })

  test("ignores a delayed failure after returning to the approved directory", async () => {
    const dir = "F:/Desktop/Paper"
    const pending = Promise.withResolvers<{ data: string[] }>()
    state.directories.mockReturnValueOnce(pending.promise)
    OpenIntent.mark(server.key, dir)
    const app = mount(dir)
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    app.history.set({ value: `/${base64Encode("F:/Desktop/Other")}/session/other` })
    await vi.waitFor(() => expect(state.directories).toHaveBeenCalledTimes(1))
    const href = `/${base64Encode("F:\\Desktop\\Paper")}/session/two`
    app.history.set({ value: href })
    await vi.waitFor(() => expect(app.host.textContent).toBe("two"))
    pending.reject(new Error("Failed to fetch"))
    await expect(pending.promise).rejects.toThrow("Failed to fetch")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(app.history.get()).toBe(href)
    expect(app.host.textContent).toBe("two")
    expect(state.directories).toHaveBeenCalledTimes(1)
    expect(state.toast).not.toHaveBeenCalled()
  })

  test("keeps a failed directory check on the current route and allows retry", async () => {
    const dir = "F:/Desktop/Paper"
    state.directories.mockRejectedValueOnce(new Error("temporary outage")).mockResolvedValueOnce({ data: [dir] })
    const app = mount(dir)
    await vi.waitFor(() => expect(app.host.querySelector('[role="alert"]')?.textContent).toContain("temporary outage"))
    expect(app.history.get()).toBe(`/${base64Encode(dir)}/session/one`)
    expect(state.mounts).toEqual([])
    expect(state.toast).not.toHaveBeenCalled()
    app.host.querySelector("button")!.click()
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    expect(state.directories).toHaveBeenCalledTimes(2)
    expect(state.mounts).toEqual([dir])
  })

  test("still blocks an unknown directory after retrying a failed request", async () => {
    state.directories.mockRejectedValueOnce(new Error("temporary outage"))
    const app = mount("F:/Desktop/Unknown")
    await vi.waitFor(() => expect(app.host.querySelector('[role="alert"]')).not.toBeNull())
    app.host.querySelector("button")!.click()
    await vi.waitFor(() => expect(app.host.textContent).toBe("home"))
    expect(state.mounts).toEqual([])
    expect(state.directories).toHaveBeenCalledTimes(2)
  })

  test("preserves the session and URL suffix when canonicalizing below a router base", async () => {
    const dir = "F:/Desktop/Paper"
    state.path = "F:\\Desktop\\Paper"
    OpenIntent.mark(server.key, dir)
    const app = mount(dir, { base: "/aether", suffix: "?view=diff#message-one" })
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    expect(app.history.get()).toBe(`/aether/${base64Encode(state.path)}/session/one?view=diff#message-one`)
    expect(state.toast).not.toHaveBeenCalled()
  })

  test("preserves the session when canonicalizing a padded directory slug", async () => {
    const dir = "F:/Desktop/Paper/"
    state.path = "F:\\Desktop\\Paper"
    OpenIntent.mark(server.key, dir)
    const app = mount(dir, { slug: btoa(dir), suffix: "?view=diff#message-one" })
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    expect(app.history.get()).toBe(`/${base64Encode(state.path)}/session/one?view=diff#message-one`)
    expect(state.toast).not.toHaveBeenCalled()
  })

  test("opens and switches UNC sessions using the backend directory spelling", async () => {
    const dir = "//server/share/Paper"
    state.path = "\\\\server\\share\\Paper"
    state.directories.mockResolvedValueOnce({ data: [state.path] }).mockRejectedValue(new Error("temporary outage"))
    const app = mount(dir)
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    app.host.querySelector("button")!.click()
    await vi.waitFor(() => expect(app.host.textContent).toBe("two"))
    expect(app.history.get()).toBe(`/${base64Encode(state.path)}/session/two`)
    expect(state.directories).toHaveBeenCalledTimes(1)
    expect(state.toast).not.toHaveBeenCalled()
  })

  test("preserves a reading session while canonicalizing a directory", async () => {
    const dir = "F:/Desktop/Paper"
    state.path = "F:\\Desktop\\Paper"
    OpenIntent.mark(server.key, dir)
    const app = mount(dir, { base: "/aether", suffix: "/reading?file=paper.pdf#page-2" })
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    expect(app.history.get()).toBe(`/aether/${base64Encode(state.path)}/session/one/reading?file=paper.pdf#page-2`)
    expect(state.toast).not.toHaveBeenCalled()
  })

  test("does not mount a new directory while its check is pending", async () => {
    const dir = "F:/Desktop/Paper"
    const pending = Promise.withResolvers<{ data: string[] }>()
    OpenIntent.mark(server.key, dir)
    const app = mount(dir)
    await vi.waitFor(() => expect(app.host.textContent).toBe("one"))
    state.directories.mockReturnValueOnce(pending.promise)
    app.history.set({ value: `/${base64Encode("F:/Desktop/Other")}/session/two` })
    await vi.waitFor(() => expect(state.directories).toHaveBeenCalledTimes(1))
    expect(state.mounts).toEqual([dir])
    pending.resolve({ data: [] })
    await vi.waitFor(() => expect(app.host.textContent).toBe("home"))
    expect(state.mounts).toEqual([dir])
  })
})
