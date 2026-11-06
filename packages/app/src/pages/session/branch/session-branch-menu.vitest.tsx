import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { ErrorBoundary } from "solid-js"
import { createStore } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { ConversationGraphList } from "./conversation-graph-list"
import type { ConversationGraphNode } from "./conversation-graph-model"
import { dict } from "@/i18n/en"

const calls = vi.hoisted(() => ({
  detach: vi.fn(),
  update: vi.fn(),
  load: vi.fn(),
  remove: vi.fn(),
  select: vi.fn(),
  parent: vi.fn(),
  toast: vi.fn(),
  client: vi.fn(),
}))
vi.mock("@/context/global-sdk", () => ({ useGlobalSDK: () => ({ createClient: calls.client }) }))
vi.mock("@/context/global-sync", () => ({
  useGlobalSync: () => ({ session: { update: calls.update }, project: { loadSessions: calls.load } }),
}))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: calls.toast }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const text = (dict as Record<string, string>)[key] ?? key
      return text.replace(/{{(\w+)}}/g, (_, name: string) => params?.[name] ?? "")
    },
  }),
}))

const child = () =>
  ({
    id: "B",
    title: "Selected branch B",
    directory: "/project",
    parentID: "A",
    forkParentSessionID: "A",
    time: { created: 1, updated: 1 },
  }) as Session
const node = (id: string, sessionID: string, row: number, kind: ConversationGraphNode["kind"] = "turn") =>
  ({
    id,
    sessionID,
    label: id,
    kind,
    time: 1,
    origin: "tree",
    lane: row,
    row,
    displayRow: row,
    displayLane: row,
    colorIndex: row,
    isCurrentPath: sessionID !== "C",
    isCurrentTarget: sessionID === "B",
    userMessageID: kind === "turn" ? id : undefined,
  }) as ConversationGraphNode
const disposers: (() => void)[] = []

function mount(session = child()) {
  const [state, setState] = createStore({ session, current: session.id })
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    render(
      () => (
        <ErrorBoundary fallback={(err: Error) => <div data-boundary>{err.message}</div>}>
          <DialogProvider>
            <div onContextMenu={calls.parent}>
              <ConversationGraphList
                currentSessionID={state.current}
                session={state.session}
                deleteSession={calls.remove}
                nodes={[node("prefix", "A", 0), node("own", "B", 1), node("bud", "B", 2, "bud"), node("other", "C", 3)]}
                edges={[]}
                laneCount={4}
                rowHeight={24}
                labelClass="text-12-medium"
                onSelect={(node) => {
                  calls.select(node)
                  setState({
                    current: node.sessionID,
                    session: { ...child(), id: node.sessionID, title: `Branch ${node.sessionID}` },
                  })
                }}
                onFork={() => {}}
                onRename={() => {}}
                showRowActions={false}
              />
            </div>
          </DialogProvider>
        </ErrorBoundary>
      ),
      host,
    ),
  )
  return {
    row: (id: string) => host.querySelector<HTMLElement>(`[data-graph-node-id="${id}"]`)!,
    set: (session: Session) => setState({ session, current: session.id }),
    current: (id: string) => setState("current", id),
    error: () => host.querySelector("[data-boundary]")?.textContent,
  }
}

const item = (action: string) => document.querySelector<HTMLElement>(`[data-action="${action}"]`)
const open = (row: HTMLElement) =>
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }))
const select = (target: HTMLElement) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))

beforeEach(() => {
  vi.resetAllMocks()
  calls.load.mockResolvedValue(undefined)
  calls.remove.mockResolvedValue(true)
  calls.client.mockReturnValue({ session: { detach: calls.detach } })
})
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ""
})

describe("selected graph branch context menu", () => {
  test("mounts the sidebar context menu without directory SDK or Sync providers", () => {
    const view = mount()
    open(view.row("own"))
    expect(view.error()).toBeUndefined()
    expect(item("session-detach")).not.toBeNull()
    expect(item("branch-delete")).not.toBeNull()
  })

  test("inherited highlighted nodes and unselected branches cannot manage or navigate on right click", () => {
    const view = mount()
    expect(view.row("own").querySelector("button")).toBeNull()
    expect(view.row("prefix").querySelector("[data-graph-node-label]")?.classList.contains("font-semibold")).toBe(true)
    open(view.row("prefix"))
    open(view.row("other"))
    expect(item("session-detach")).toBeNull()
    expect(item("branch-delete")).toBeNull()
    expect(calls.select).not.toHaveBeenCalled()
    expect(calls.parent).not.toHaveBeenCalled()
    view.row("other").click()
    expect(calls.select).toHaveBeenCalledOnce()
    open(view.row("other"))
    expect(item("branch-delete")).not.toBeNull()
  })

  test("a matching current node cannot manage stale metadata belonging to another session", () => {
    const view = mount()
    view.current("C")
    open(view.row("other"))
    expect(item("session-detach")).toBeNull()
    expect(item("branch-delete")).toBeNull()
    expect(calls.select).not.toHaveBeenCalled()
  })

  test("busy split failures retain the existing error behavior without deleting or navigating", async () => {
    calls.detach.mockRejectedValue({ name: "SessionBusyError", data: { message: "Session B is busy" } })
    const view = mount()
    open(view.row("own"))
    select(item("session-detach")!)
    await vi.waitFor(() => expect(calls.toast).toHaveBeenCalledOnce())
    expect(calls.toast.mock.calls[0]?.[0].description).toBe(dict["error.chain.session.busy"])
    expect(calls.remove).not.toHaveBeenCalled()
    expect(calls.update).not.toHaveBeenCalled()
    expect(calls.select).not.toHaveBeenCalled()
  })

  test.each(["own", "bud"])("right clicking selected %s exposes the exact session without navigating", async (id) => {
    calls.detach.mockResolvedValue({ data: { ...child(), parentID: undefined, forkParentSessionID: undefined } })
    const view = mount()
    open(view.row(id))
    expect(document.body.textContent).toContain("Branch: Selected branch B")
    expect(item("session-detach")?.textContent).toBe("Split out branch")
    expect(item("branch-delete")?.textContent).toBe("Delete branch")
    select(item("session-detach")!)
    await vi.waitFor(() => expect(calls.detach).toHaveBeenCalledExactlyOnceWith({ sessionID: "B" }))
    expect(calls.client).toHaveBeenCalledExactlyOnceWith({ directory: "/project", throwOnError: true })
    expect(calls.select).not.toHaveBeenCalled()
    expect(calls.parent).not.toHaveBeenCalled()
  })

  test.each([{ key: "ContextMenu" }, { key: "F10", shiftKey: true }])(
    "keyboard $key opens selected branch actions",
    (keys) => {
      const view = mount()
      view.row("own").focus()
      view.row("own").dispatchEvent(new KeyboardEvent("keydown", { ...keys, bubbles: true, cancelable: true }))
      expect(item("branch-delete")).not.toBeNull()
      expect(calls.select).not.toHaveBeenCalled()
    },
  )

  test("an independent root can be deleted and offers no split action", () => {
    const view = mount({ ...child(), parentID: undefined, forkParentSessionID: undefined })
    open(view.row("own"))
    expect(item("session-detach")).toBeNull()
    expect(item("branch-delete")).not.toBeNull()
  })

  test("delete confirms the named branch and all descendants, and prevents duplicate submissions", async () => {
    const pending = Promise.withResolvers<boolean>()
    calls.remove.mockReturnValue(pending.promise)
    const view = mount()
    open(view.row("own"))
    select(item("branch-delete")!)
    expect(calls.remove).not.toHaveBeenCalled()
    expect(document.querySelector('[data-slot="dialog-body"]')?.textContent).toContain(
      "branch “Selected branch B” and all of its descendant sessions",
    )
    item("branch-delete-confirm")!.click()
    item("branch-delete-confirm")!.click()
    expect(calls.remove).toHaveBeenCalledOnce()
    expect(calls.remove.mock.calls[0]?.[0].id).toBe("B")
    pending.resolve(true)
    await vi.waitFor(() => expect(item("branch-delete-confirm")).toBeNull())
    expect(calls.select).not.toHaveBeenCalled()
  })

  test("a failed deletion retains the confirmation and releases pending state", async () => {
    calls.remove.mockResolvedValue(false)
    const view = mount()
    open(view.row("own"))
    select(item("branch-delete")!)
    item("branch-delete-confirm")!.click()
    await vi.waitFor(() => expect((item("branch-delete-confirm") as HTMLButtonElement)?.disabled).toBe(false))
    expect(item("branch-delete-confirm")).not.toBeNull()
    expect(calls.remove).toHaveBeenCalledOnce()
  })

  test("cancelling confirmation leaves the branch untouched", async () => {
    const view = mount()
    open(view.row("own"))
    select(item("branch-delete")!)
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-body"] button')].find(
      (button) => button.textContent === "Cancel",
    )
    cancel!.click()
    await vi.waitFor(() => expect(item("branch-delete-confirm")).toBeNull())
    expect(calls.remove).not.toHaveBeenCalled()
  })

  test("changing selection closes an open branch menu", () => {
    const view = mount()
    open(view.row("own"))
    expect(item("branch-delete")).not.toBeNull()
    view.set({ ...child(), id: "C", title: "Other branch C" })
    expect(item("branch-delete")).toBeNull()
    expect(calls.remove).not.toHaveBeenCalled()
  })

  test("an in-flight context action stays scoped to its original directory after the selected branch changes", async () => {
    const source = { ...child(), directory: "/sandbox" }
    const root = { ...source, parentID: undefined, forkParentSessionID: undefined }
    const pending = Promise.withResolvers<{ data: Session }>()
    calls.detach.mockReturnValue(pending.promise)
    const view = mount(source)
    open(view.row("own"))
    select(item("session-detach")!)
    view.set({ ...child(), id: "C", title: "Other branch C", directory: "/other" })
    pending.resolve({ data: root })
    await vi.waitFor(() => expect(calls.load).toHaveBeenCalledOnce())
    expect(calls.client).toHaveBeenCalledExactlyOnceWith({ directory: "/sandbox", throwOnError: true })
    expect(calls.update).toHaveBeenCalledExactlyOnceWith(root)
    expect(calls.load).toHaveBeenCalledExactlyOnceWith("/sandbox", { force: true })
    open(view.row("other"))
    expect(document.body.textContent).toContain("Branch: Other branch C")
    expect(view.error()).toBeUndefined()
  })

  test("a failed context action after navigation preserves the newly selected branch", async () => {
    const pending = Promise.withResolvers<{ data: Session }>()
    calls.detach.mockReturnValue(pending.promise)
    const view = mount({ ...child(), directory: "/sandbox" })
    open(view.row("own"))
    select(item("session-detach")!)
    view.set({ ...child(), id: "C", title: "Other branch C", directory: "/other" })
    pending.reject({ name: "SessionBusyError", data: { message: "Session B is busy" } })
    await vi.waitFor(() => expect(calls.toast).toHaveBeenCalledOnce())
    expect(calls.update).not.toHaveBeenCalled()
    expect(calls.load).not.toHaveBeenCalled()
    open(view.row("other"))
    expect(item("branch-delete")).not.toBeNull()
    expect(document.body.textContent).toContain("Branch: Other branch C")
    expect(view.error()).toBeUndefined()
  })
})
