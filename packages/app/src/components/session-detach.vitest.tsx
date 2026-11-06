import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { ErrorBoundary } from "solid-js"
import { createStore } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { SessionDetach } from "./session-detach"

const calls = vi.hoisted(() => ({ detach: vi.fn(), update: vi.fn(), load: vi.fn(), toast: vi.fn(), client: vi.fn() }))
vi.mock("@/context/global-sdk", () => ({ useGlobalSDK: () => ({ createClient: calls.client }) }))
vi.mock("@/context/global-sync", () => ({
  useGlobalSync: () => ({ session: { update: calls.update }, project: { loadSessions: calls.load } }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: calls.toast }))

const child = {
  id: "child",
  parentID: "parent",
  forkParentSessionID: "parent",
  directory: "/project",
  time: { created: 1, updated: 1 },
} as Session
const disposers: (() => void)[] = []

function mount(session: Session, context = false) {
  const [state, setState] = createStore({ session: { ...session, time: { ...session.time } } })
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    render(
      () => (
        <ErrorBoundary fallback={(err: Error) => <div data-boundary>{err.message}</div>}>
          {context ? (
            <ContextMenu modal={false}>
              <ContextMenu.Trigger data-trigger>Menu</ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content>
                  <SessionDetach session={state.session} context />
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu>
          ) : (
            <DropdownMenu open modal={false}>
              <DropdownMenu.Trigger>Menu</DropdownMenu.Trigger>
              <DropdownMenu.Content>
                <SessionDetach session={state.session} />
              </DropdownMenu.Content>
            </DropdownMenu>
          )}
        </ErrorBoundary>
      ),
      host,
    ),
  )
  if (context)
    host
      .querySelector("[data-trigger]")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
  return {
    item: () => document.querySelector<HTMLElement>('[data-action="session-detach"]'),
    set: (session: Session) => setState("session", session),
    error: () => host.querySelector("[data-boundary]")?.textContent,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  calls.load.mockResolvedValue(undefined)
  calls.client.mockReturnValue({ session: { detach: calls.detach } })
})

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ""
})

describe("SessionDetach", () => {
  test.each([false, true])("mounts context=%s without directory SDK or Sync providers", (context) => {
    const view = mount(child, context)
    expect(view.error()).toBeUndefined()
    expect(view.item()).not.toBeNull()
  })

  test("is offered only for active human fork children", () => {
    const view = mount(child)
    expect(view.item()?.textContent).toBe("session.detach.action")
    view.set({ ...child, forkParentSessionID: undefined })
    expect(view.item()).toBeNull()
    view.set({ ...child, parentID: undefined })
    expect(view.item()).toBeNull()
    view.set({ ...child, time: { ...child.time, archived: 2 } })
    expect(view.item()).toBeNull()
  })

  test("applies the response to the same session and refreshes descendants once", async () => {
    const root = { ...child, parentID: undefined, forkParentSessionID: undefined, treeID: "new" }
    const pending = Promise.withResolvers<{ data: Session }>()
    calls.detach.mockReturnValue(pending.promise)
    const view = mount(child)
    view.item()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    view.item()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(calls.detach).toHaveBeenCalledExactlyOnceWith({ sessionID: "child" })
    expect(calls.client).toHaveBeenCalledExactlyOnceWith({ directory: "/project", throwOnError: true })
    pending.resolve({ data: root })
    await vi.waitFor(() => expect(calls.load).toHaveBeenCalledExactlyOnceWith("/project", { force: true }))
    expect(calls.update).toHaveBeenCalledExactlyOnceWith(root)
    expect(calls.toast).not.toHaveBeenCalled()
  })

  test("shows a clear busy error without changing session metadata", async () => {
    calls.detach.mockRejectedValue({ name: "SessionBusyError", data: { message: "Session child is busy" } })
    const view = mount(child)
    view.item()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await vi.waitFor(() => expect(calls.toast).toHaveBeenCalledTimes(1))
    expect(calls.toast).toHaveBeenCalledWith({
      variant: "error",
      title: "session.detach.failed.title",
      description:
        "This session or one of its branches is running or awaiting an answer. Finish or stop it and try again.",
    })
    expect(calls.update).not.toHaveBeenCalled()
    expect(calls.load).not.toHaveBeenCalled()
    expect(view.item()).not.toBeNull()
  })

  test("keeps the successful split and reports list refresh failure separately", async () => {
    const root = { ...child, parentID: undefined, forkParentSessionID: undefined, treeID: "new" }
    calls.detach.mockResolvedValue({ data: root })
    calls.load.mockRejectedValue(new Error("Refresh failed"))
    const view = mount(child)
    view.item()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await vi.waitFor(() => expect(calls.toast).toHaveBeenCalledTimes(1))
    expect(calls.update).toHaveBeenCalledExactlyOnceWith(root)
    expect(calls.detach).toHaveBeenCalledTimes(1)
    expect(calls.toast).toHaveBeenCalledWith({
      variant: "error",
      title: "session.detach.refreshFailed.title",
      description: "Refresh failed",
    })
  })

  test.each([false, true])(
    "targets the original directory after selection changes while context=%s is pending",
    async (context) => {
      const source = { ...child, directory: "/source" }
      const root = { ...source, parentID: undefined, forkParentSessionID: undefined, treeID: "new" }
      const pending = Promise.withResolvers<{ data: Session }>()
      calls.detach.mockReturnValue(pending.promise)
      const view = mount(source, context)
      view.item()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      view.set({ ...child, id: "other", directory: "/other" })
      pending.resolve({ data: root })
      await vi.waitFor(() => expect(calls.load).toHaveBeenCalledOnce())
      expect(calls.client).toHaveBeenCalledExactlyOnceWith({ directory: "/source", throwOnError: true })
      expect(calls.detach).toHaveBeenCalledExactlyOnceWith({ sessionID: "child" })
      expect(calls.update).toHaveBeenCalledExactlyOnceWith(root)
      expect(calls.load).toHaveBeenCalledExactlyOnceWith("/source", { force: true })
      expect(view.error()).toBeUndefined()
    },
  )

  test("a failed pending request cannot update the newly selected session and releases its pending guard", async () => {
    const pending = Promise.withResolvers<{ data: Session }>()
    calls.detach.mockReturnValueOnce(pending.promise)
    const view = mount({ ...child, directory: "/source" })
    view.item()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    view.set({ ...child, id: "other", directory: "/other" })
    pending.reject({ name: "SessionBusyError", data: { message: "Session child is busy" } })
    await vi.waitFor(() => expect(calls.toast).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(view.item()?.getAttribute("aria-disabled")).not.toBe("true"))
    expect(calls.update).not.toHaveBeenCalled()
    expect(calls.load).not.toHaveBeenCalled()
    expect(calls.detach).toHaveBeenCalledExactlyOnceWith({ sessionID: "child" })
    expect(view.error()).toBeUndefined()
  })
})
