import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { AsyncStorage } from "@solid-primitives/storage"
import type { NativeQuestion } from "@opencode-ai/sdk/v2"
import { NativeChats } from "./native-chats"
import { NativeCompact } from "./native-compact"
import { NativeTaskButton, NativeTasks } from "./native-tasks"

const mocks = vi.hoisted(() => ({
  directory: () => "/first",
  storage: undefined as AsyncStorage | undefined,
  chats: vi.fn(),
  attach: vi.fn(),
  compact: vi.fn(),
  status: vi.fn(),
  tasks: vi.fn(),
  open: vi.fn(),
  answer: vi.fn(),
  reply: vi.fn(),
  skip: vi.fn(),
  close: vi.fn(),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    url: "local",
    get directory() {
      return mocks.directory()
    },
    client: {
      native: {
        chats: mocks.chats,
        attachChat: mocks.attach,
        compact: mocks.compact,
        compactStatus: mocks.status,
        tasks: mocks.tasks,
        openTask: mocks.open,
        replyTask: mocks.answer,
        replyQuestion: mocks.reply,
        skipQuestion: mocks.skip,
      },
    },
    event: { listen: () => () => undefined },
  }),
}))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ platform: "desktop", storage: () => mocks.storage! }) }))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ close: mocks.close }) }))
vi.mock("@opencode-ai/ui/dialog", () => ({ Dialog: (props: { children: JSX.Element }) => <div>{props.children}</div> }))

const cleanups: VoidFunction[] = []
const page = (name: string) => ({
  data: { scope: name, chats: [{ id: name, title: name, updated: 1000, state: "idle" }] },
})
const question = (): NativeQuestion => ({
  thread: "child-thread",
  turn: "child-turn",
  item: "raw-child-item",
  state: "pending",
  questions: [{ title: "Which analysis?", options: ["Method A", "Method B"] }],
})
const task = (name: string, questions: NativeQuestion[] = []) => ({
  thread: name,
  root: "root-thread",
  origin: "root-turn",
  parent: "root-thread",
  turn: "child-turn",
  name,
  state: "completed",
  output: "Child result",
  updated: 1000,
  questions,
})

function mount(view: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(view, host)
  const dispose = () => {
    off()
    host.remove()
  }
  cleanups.push(dispose)
  return {
    host,
    dispose,
    button: (label: string) =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label),
  }
}

function scope() {
  const [state, setState] = createStore({ directory: "/first" })
  mocks.directory = () => state.directory
  return (value: string) => setState("directory", value)
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.directory = () => "/first"
  const values = new Map<string, string>()
  mocks.storage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value)
    },
    removeItem: async (key) => {
      values.delete(key)
    },
  }
  mocks.chats.mockResolvedValue({ data: { scope: "empty", chats: [] } })
  mocks.status.mockResolvedValue({ data: null })
  mocks.tasks.mockResolvedValue({ data: [] })
})
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

test("chat list ignores a previous project's late response", async () => {
  const change = scope()
  const old = Promise.withResolvers<ReturnType<typeof page>>()
  mocks.chats.mockImplementationOnce(() => old.promise).mockResolvedValueOnce(page("Current chat"))
  const panel = mount(() => <NativeChats onSelect={() => undefined} />)
  await vi.waitFor(() => expect(mocks.chats).toHaveBeenCalledOnce())
  change("/second")
  await vi.waitFor(() => expect(panel.host.textContent).toContain("Current chat"))
  old.resolve(page("Old chat"))
  await old.promise
  await Promise.resolve()
  expect(panel.host.textContent).not.toContain("Old chat")
  expect(panel.host.textContent).toContain("Current chat")
})

test("a chat linked after changing projects cannot navigate or close the new dialog", async () => {
  const change = scope()
  const old = Promise.withResolvers<{ data: { id: string } }>()
  const select = vi.fn()
  mocks.chats.mockResolvedValueOnce(page("Old chat")).mockResolvedValueOnce(page("Current chat"))
  mocks.attach.mockImplementationOnce(() => old.promise)
  const panel = mount(() => <NativeChats onSelect={select} />)
  await vi.waitFor(() => expect(panel.button("native.chats.attach")?.disabled).toBe(false))
  panel.button("native.chats.attach")!.click()
  expect(mocks.attach).toHaveBeenCalledWith({ threadID: "Old chat", scope: "Old chat" }, { throwOnError: true })
  change("/second")
  await vi.waitFor(() => expect(panel.host.textContent).toContain("Current chat"))
  old.resolve({ data: { id: "old-session" } })
  await old.promise
  await Promise.resolve()
  expect(select).not.toHaveBeenCalled()
  expect(mocks.close).not.toHaveBeenCalled()
})

test("compaction keeps the same operation UUID after a lost response and dialog reopening", async () => {
  const complete = vi.fn()
  mocks.compact
    .mockRejectedValueOnce(new Error("response lost"))
    .mockImplementationOnce(async (input: { sessionID: string; id: string }) => ({
      data: { ...input, threadID: "native-thread", state: "complete", updated: 1000 },
    }))
  const first = mount(() => <NativeCompact sessionID="session" onComplete={complete} />)
  await vi.waitFor(() => expect(first.button("native.compact.start")?.disabled).toBe(false))
  first.button("native.compact.start")!.click()
  await vi.waitFor(() => expect(first.button("native.compact.retry")?.disabled).toBe(false))
  const id = (mocks.compact.mock.calls[0][0] as { id: string }).id
  expect(id).toMatch(/^[a-f0-9-]{36}$/)
  first.dispose()
  const second = mount(() => <NativeCompact sessionID="session" onComplete={complete} />)
  await vi.waitFor(() => expect(second.button("native.compact.retry")?.disabled).toBe(false))
  second.button("native.compact.retry")!.click()
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
  expect(mocks.compact).toHaveBeenCalledTimes(2)
  expect(mocks.compact.mock.calls.map(([input]) => (input as { id: string }).id)).toEqual([id, id])
  expect(mocks.status.mock.calls.some(([input]) => (input as { operationId?: string }).operationId === id)).toBe(true)
})

test("late compaction status cannot update another project's panel", async () => {
  const change = scope()
  const old = Promise.withResolvers<{
    data: { sessionID: string; id: string; threadID: string; state: string; updated: number }
  }>()
  const complete = vi.fn()
  mocks.status.mockImplementationOnce(() => old.promise)
  const panel = mount(() => <NativeCompact sessionID="session" onComplete={complete} />)
  await vi.waitFor(() => expect(mocks.status).toHaveBeenCalledOnce())
  change("/second")
  await vi.waitFor(() => expect(panel.button("native.compact.start")?.disabled).toBe(false))
  old.resolve({ data: { sessionID: "session", id: "old", threadID: "old-thread", state: "complete", updated: 1000 } })
  await old.promise
  await Promise.resolve()
  expect(complete).not.toHaveBeenCalled()
  expect(panel.host.textContent).not.toContain("native.compact.complete")
})

test("child task lists ignore late results from another project", async () => {
  const change = scope()
  const old = Promise.withResolvers<{ data: ReturnType<typeof task>[] }>()
  mocks.tasks.mockImplementationOnce(() => old.promise).mockResolvedValueOnce({ data: [task("Current task")] })
  const panel = mount(() => <NativeTasks sessionID="session" onSelect={() => undefined} />)
  await vi.waitFor(() => expect(mocks.tasks).toHaveBeenCalledOnce())
  change("/second")
  await vi.waitFor(() => expect(panel.host.textContent).toContain("Current task"))
  old.resolve({ data: [task("Old task")] })
  await old.promise
  await Promise.resolve()
  expect(panel.host.textContent).not.toContain("Old task")
})

test("opening a child task cannot navigate after project navigation", async () => {
  const change = scope()
  const old = Promise.withResolvers<{ data: { id: string } }>()
  const select = vi.fn()
  mocks.tasks.mockResolvedValueOnce({ data: [task("Old task")] })
  mocks.open.mockImplementationOnce(() => old.promise)
  const panel = mount(() => <NativeTasks sessionID="session" onSelect={select} />)
  await vi.waitFor(() => expect(panel.button("native.tasks.open")?.disabled).toBe(false))
  panel.button("native.tasks.open")!.click()
  change("/second")
  await vi.waitFor(() => expect(mocks.tasks).toHaveBeenCalledTimes(2))
  old.resolve({ data: { id: "old-child-session" } })
  await old.promise
  await Promise.resolve()
  expect(select).not.toHaveBeenCalled()
})

test.each([false, true])(
  "child question %s routes answers or skipping to the child endpoint with raw identities",
  async (skip) => {
    const value = question()
    const answered: NativeQuestion = {
      ...value,
      state: "answered",
      ...(skip ? { skipped: true } : { answers: ["Method B"] }),
    }
    let current = value
    mocks.tasks.mockImplementation(async () => ({ data: [task("child-thread", [current])] }))
    mocks.answer.mockImplementation(async () => {
      current = answered
      return { data: answered }
    })
    const badge = mount(() => <NativeTaskButton sessionID="root-session" onOpen={() => undefined} />)
    const panel = mount(() => <NativeTasks sessionID="root-session" onSelect={() => undefined} />)
    await vi.waitFor(() => expect(panel.button("Method B")).toBeDefined())
    await vi.waitFor(() => expect(badge.host.textContent).toContain("native.tasks.pending"))
    if (!skip) panel.button("Method B")!.click()
    panel.button(skip ? "native.question.skip" : "native.question.submit")!.click()
    await vi.waitFor(() => expect(mocks.answer).toHaveBeenCalledOnce())
    expect(mocks.answer).toHaveBeenCalledWith(
      {
        sessionID: "root-session",
        threadID: "child-thread",
        itemID: "raw-child-item",
        answers: skip ? undefined : ["Method B"],
      },
      { throwOnError: true },
    )
    expect(mocks.reply).not.toHaveBeenCalled()
    expect(mocks.skip).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(badge.host.textContent).not.toContain("native.tasks.pending"))
    await vi.waitFor(() =>
      expect(panel.host.querySelector('[data-component="native-question"]')?.getAttribute("data-state")).toBe(
        skip ? "skipped" : "answered",
      ),
    )
  },
)

test("a completed child answer from an old project cannot refresh another project's task badge", async () => {
  const change = scope()
  const value = question()
  const old = Promise.withResolvers<{ data: NativeQuestion }>()
  mocks.tasks.mockResolvedValue({ data: [task("child-thread", [value])] })
  mocks.answer.mockImplementation(() => old.promise)
  const badge = mount(() => <NativeTaskButton sessionID="root-session" onOpen={() => undefined} />)
  const panel = mount(() => <NativeTasks sessionID="root-session" onSelect={() => undefined} />)
  await vi.waitFor(() => expect(panel.button("native.question.skip")).toBeDefined())
  panel.button("native.question.skip")!.click()
  await vi.waitFor(() => expect(mocks.answer).toHaveBeenCalledOnce())
  change("/second")
  await vi.waitFor(() => expect(mocks.tasks).toHaveBeenCalledTimes(4))
  await vi.waitFor(() => expect(badge.host.textContent).toContain("native.tasks.pending"))
  old.resolve({ data: { ...value, state: "answered", skipped: true } })
  await old.promise
  await Promise.resolve()
  await Promise.resolve()
  expect(mocks.tasks).toHaveBeenCalledTimes(4)
  expect(badge.host.textContent).toContain("native.tasks.pending")
})

test.each([false, true])(
  "idle child submission %s refreshes its parent badge while continuation is still sending",
  async (skip) => {
    const value = question()
    const sending: NativeQuestion = {
      ...value,
      state: "sending",
      ...(skip ? { skipped: true } : { answers: ["Method B"] }),
    }
    let current = value
    mocks.tasks.mockImplementation(async () => ({ data: [task("child-thread", [current])] }))
    mocks.answer.mockImplementation(async () => {
      current = sending
      return { data: sending }
    })
    const badge = mount(() => <NativeTaskButton sessionID="root-session" onOpen={() => undefined} />)
    const panel = mount(() => <NativeTasks sessionID="root-session" onSelect={() => undefined} />)
    await vi.waitFor(() => expect(panel.button("Method B")).toBeDefined())
    await vi.waitFor(() => expect(badge.host.textContent).toContain("native.tasks.pending"))
    if (!skip) panel.button("Method B")!.click()
    panel.button(skip ? "native.question.skip" : "native.question.submit")!.click()
    await vi.waitFor(() => expect(badge.host.textContent).not.toContain("native.tasks.pending"))
    expect(panel.host.querySelector('[data-component="native-question"]')?.getAttribute("data-state")).toBe("sending")
  },
)
