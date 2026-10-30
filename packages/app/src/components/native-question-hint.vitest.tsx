import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot, createSignal } from "solid-js"
import type { Event } from "@opencode-ai/sdk/v2"
import type { AsyncStorage } from "@solid-primitives/storage"
import { render } from "solid-js/web"
import { createNativeQuestions, NativeQuestionHint, type PendingQuestion } from "./native-question-hint"
import { submittedNativeQuestion } from "./native-question-events"

const mocks = vi.hoisted(() => ({ questions: vi.fn(), storage: undefined as AsyncStorage | undefined }))
const listeners = new Set<(event: { details: Event }) => void>()
let backend = () => ({ url: "local", directory: "/project" })
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    get url() {
      return backend().url
    },
    get directory() {
      return backend().directory
    },
    client: { native: { questions: mocks.questions } },
    event: {
      listen: (fn: (event: { details: Event }) => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
  }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/platform", () => ({
  usePlatform: () => ({ platform: mocks.storage ? "desktop" : "web", storage: () => mocks.storage }),
}))

const item = (): PendingQuestion => ({
  messageID: "assistant",
  parentID: "old-user",
  partID: "old-part",
  question: {
    thread: "thread",
    turn: "turn",
    item: "question",
    state: "pending",
    questions: [{ title: "Which method?" }],
  },
})
const cleanups: VoidFunction[] = []
function mount() {
  const [session, set] = createSignal<string | undefined>("session")
  const items = createRoot((dispose) => {
    cleanups.push(dispose)
    return createNativeQuestions(session)
  })
  return { items, set }
}
beforeEach(() => {
  mocks.questions.mockReset()
  mocks.questions.mockResolvedValue({ data: [item()] })
  mocks.storage = undefined
  backend = () => ({ url: "local", directory: "/project" })
})
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  vi.useRealTimers()
})

describe("native pending question hint", () => {
  test("uses the full server index and opens the original card identity", async () => {
    const fixture = mount()
    await vi.waitFor(() => expect(fixture.items()).toHaveLength(1))
    const open = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    const dispose = render(
      () => <NativeQuestionHint session="session" items={fixture.items()} busy={false} onOpen={open} />,
      host,
    )
    cleanups.push(() => {
      dispose()
      host.remove()
    })
    host.querySelector<HTMLButtonElement>("button")?.click()
    expect(open).toHaveBeenCalledWith(item())
    expect(host.querySelector('[role="status"]')).not.toBeNull()
  })

  test("excludes sending, uncertain, answered, and submitted question groups", async () => {
    mocks.questions.mockResolvedValue({
      data: [
        item(),
        ...(["sending", "uncertain", "answered", "failed"] as const).map((state) => ({
          ...item(),
          partID: state,
          question: { ...item().question, item: state, state },
        })),
        { ...item(), partID: "saved", question: { ...item().question, item: "saved", answers: ["A"] } },
      ],
    })
    const fixture = mount()
    await vi.waitFor(() => expect(fixture.items()).toHaveLength(1))
    submittedNativeQuestion({
      url: "local",
      directory: "/project",
      session: "session",
      thread: "thread",
      item: "question",
    })
    expect(fixture.items()).toHaveLength(0)
  })

  test("does not resurrect a question from an older HTTP response after a sending event", async () => {
    const response = Promise.withResolvers<{ data: PendingQuestion[] }>()
    mocks.questions.mockReturnValue(response.promise)
    const fixture = mount()
    listeners.forEach((fn) =>
      fn({
        details: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "text",
              id: "old-part",
              sessionID: "session",
              messageID: "assistant",
              text: "",
              nativeQuestion: { ...item().question, state: "sending", answers: ["A"] },
            },
          },
        },
      }),
    )
    response.resolve({ data: [item()] })
    await response.promise
    await Promise.resolve()
    expect(fixture.items()).toHaveLength(0)
  })

  test.each(["event", "index"])("restores an answered question reverted to pending through a newer %s", async (source) => {
    vi.useFakeTimers()
    const fixture = mount()
    await vi.advanceTimersByTimeAsync(0)
    submittedNativeQuestion({
      url: "local",
      directory: "/project",
      session: "session",
      thread: "thread",
      item: "question",
    })
    listeners.forEach((fn) =>
      fn({
        details: {
          type: "message.part.updated",
          properties: {
            sessionID: "session",
            time: 1,
            part: {
              type: "text",
              id: "old-part",
              sessionID: "session",
              messageID: "assistant",
              text: "",
              nativeQuestion: { ...item().question, state: "answered", answers: ["A"] },
            },
          },
        },
      }),
    )
    mocks.questions.mockResolvedValue({ data: [] })
    await vi.advanceTimersByTimeAsync(400)
    expect(fixture.items()).toHaveLength(0)
    mocks.questions.mockResolvedValue({ data: [item()] })
    if (source === "event")
      listeners.forEach((fn) =>
        fn({
          details: {
            type: "message.part.updated",
            properties: {
              sessionID: "session",
              time: 2,
              part: {
                type: "text",
                id: "old-part",
                sessionID: "session",
                messageID: "assistant",
                text: "",
                nativeQuestion: item().question,
              },
            },
          },
        }),
      )
    if (source === "index") window.dispatchEvent(new window.Event("focus"))
    await vi.advanceTimersByTimeAsync(400)
    expect(fixture.items()).toEqual([item()])
  })

  test("does not revive a newly submitted question from an index request started before submission", async () => {
    vi.useFakeTimers()
    const fixture = mount()
    await vi.advanceTimersByTimeAsync(0)
    const response = Promise.withResolvers<{ data: PendingQuestion[] }>()
    mocks.questions.mockReturnValueOnce(response.promise).mockResolvedValue({ data: [] })
    window.dispatchEvent(new window.Event("focus"))
    submittedNativeQuestion({
      url: "local",
      directory: "/project",
      session: "session",
      thread: "thread",
      item: "question",
    })
    response.resolve({ data: [item()] })
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.items()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(fixture.items()).toHaveLength(0)
  })

  test("ignores another session's events and late index responses", async () => {
    const response = Promise.withResolvers<{ data: PendingQuestion[] }>()
    mocks.questions.mockReturnValueOnce(response.promise).mockResolvedValueOnce({ data: [] })
    const fixture = mount()
    fixture.set("another")
    response.resolve({ data: [item()] })
    await response.promise
    await Promise.resolve()
    expect(fixture.items()).toHaveLength(0)
    expect(mocks.questions.mock.calls[1][0]).toEqual({ sessionID: "another" })
  })

  test.each(["message.removed", "message.part.removed"] as const)(
    "clears pending hints on %s even when history becomes empty",
    async (type) => {
      vi.useFakeTimers()
      const fixture = mount()
      await vi.advanceTimersByTimeAsync(0)
      expect(fixture.items()).toHaveLength(1)
      mocks.questions.mockResolvedValue({ data: [] })
      const properties = { sessionID: "session", messageID: "assistant", partID: "old-part" }
      listeners.forEach((fn) => fn({ details: { type, properties } }))
      expect(fixture.items()).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(400)
      expect(mocks.questions).toHaveBeenCalledTimes(2)
      expect(fixture.items()).toHaveLength(0)
    },
  )

  test.each(["message.removed", "message.part.removed"] as const)(
    "does not resurrect a removed question from an older index response after %s",
    async (type) => {
      vi.useFakeTimers()
      const response = Promise.withResolvers<{ data: PendingQuestion[] }>()
      mocks.questions.mockReturnValueOnce(response.promise).mockResolvedValue({ data: [] })
      const fixture = mount()
      const properties = { sessionID: "session", messageID: "assistant", partID: "old-part" }
      listeners.forEach((fn) => fn({ details: { type, properties } }))
      response.resolve({ data: [item()] })
      await vi.advanceTimersByTimeAsync(0)
      expect(fixture.items()).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(400)
      expect(mocks.questions).toHaveBeenCalledTimes(2)
      expect(fixture.items()).toHaveLength(0)
    },
  )

  test("ignores foreign removals and accepts a question moved to a new display owner", async () => {
    vi.useFakeTimers()
    const fixture = mount()
    await vi.advanceTimersByTimeAsync(0)
    listeners.forEach((fn) =>
      fn({
        details: {
          type: "message.removed",
          properties: { sessionID: "another", messageID: "assistant" },
        },
      }),
    )
    expect(fixture.items()).toHaveLength(1)
    const moved = { ...item(), messageID: "projected", parentID: "projected-user", partID: "projected-part" }
    mocks.questions.mockResolvedValue({ data: [moved] })
    listeners.forEach((fn) =>
      fn({
        details: { type: "message.removed", properties: { sessionID: "session", messageID: "assistant" } },
      }),
    )
    expect(fixture.items()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(fixture.items()).toEqual([moved])
  })

  test("does not keep scanning idle empty history and refreshes on focus", async () => {
    vi.useFakeTimers()
    mocks.questions.mockResolvedValue({ data: [] })
    mount()
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(mocks.questions).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new window.Event("focus"))
    await Promise.resolve()
    expect(mocks.questions).toHaveBeenCalledTimes(2)
  })

  test("clears local submission overrides when changing sessions", async () => {
    const fixture = mount()
    await vi.waitFor(() => expect(fixture.items()).toHaveLength(1))
    submittedNativeQuestion({
      url: "local",
      directory: "/project",
      session: "session",
      thread: "thread",
      item: "question",
    })
    expect(fixture.items()).toHaveLength(0)
    fixture.set("another")
    await vi.waitFor(() => expect(fixture.items()).toHaveLength(1))
  })
})

function hint(session: string, initial = [item()]) {
  const [id, setSession] = createSignal(session)
  const [items, setItems] = createSignal(initial)
  const [scope, setScope] = createSignal({ url: "local", directory: "/project" })
  backend = scope
  const host = document.createElement("div")
  document.body.append(host)
  const open = vi.fn()
  const dispose = render(() => <NativeQuestionHint session={id()} items={items()} busy={false} onOpen={open} />, host)
  const off = () => {
    dispose()
    host.remove()
  }
  cleanups.push(off)
  const button = (key: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === key)
  return { host, open, setSession, setItems, setScope, off, button }
}

describe("dismissed native question reminders", () => {
  test("dismisses only the current snapshot, without answering or changing the pending source", () => {
    const rows = [item(), { ...item(), question: { ...item().question, item: "second" } }]
    const fixture = hint("dismiss-current", rows)
    fixture.button("native.question.ignore")!.click()
    expect(fixture.host.querySelector('[data-component="native-question-hint"]')).toBeNull()
    expect(rows.every((row) => row.question.state === "pending" && !row.question.answers)).toBe(true)
    expect(mocks.questions).not.toHaveBeenCalled()
    const next = { ...item(), question: { ...item().question, item: "new" } }
    fixture.setItems([...rows, next])
    expect(fixture.button("native.question.open")).toBeDefined()
    fixture.button("native.question.open")!.click()
    expect(fixture.open).toHaveBeenCalledExactlyOnceWith(next)
  })

  test("restores dismissals after remount even if projection changes message and part IDs", () => {
    const fixture = hint("dismiss-remount")
    fixture.button("native.question.ignore")!.click()
    fixture.off()
    const next = hint("dismiss-remount", [
      { ...item(), messageID: "projected", parentID: "projected-user", partID: "projected-part" },
    ])
    expect(next.host.querySelector('[data-component="native-question-hint"]')).toBeNull()
    next.setItems([{ ...item(), question: { ...item().question, thread: "another-thread" } }])
    expect(next.button("native.question.open")).toBeDefined()
  })

  test("isolates server, directory and session scopes while restoring the original dismissal", () => {
    const fixture = hint("dismiss-scope")
    fixture.button("native.question.ignore")!.click()
    fixture.setSession("another-session")
    expect(fixture.button("native.question.open")).toBeDefined()
    fixture.setSession("dismiss-scope")
    expect(fixture.button("native.question.open")).toBeUndefined()
    fixture.setScope({ url: "remote", directory: "/project" })
    expect(fixture.button("native.question.open")).toBeDefined()
    fixture.setScope({ url: "local", directory: "/other" })
    expect(fixture.button("native.question.open")).toBeDefined()
    fixture.setScope({ url: "local", directory: "/project" })
    expect(fixture.button("native.question.open")).toBeUndefined()
  })

  test("waits for desktop hydration before exposing or modifying saved dismissals", async () => {
    const read = Promise.withResolvers<string | null>()
    const writes = new Map<string, string>()
    mocks.storage = {
      getItem: () => read.promise,
      setItem: async (key, value) => {
        writes.set(key, value)
      },
      removeItem: async (key) => {
        writes.delete(key)
      },
    }
    const fixture = hint("dismiss-desktop")
    expect(fixture.host.querySelector("button")).toBeNull()
    const next = { ...item(), question: { ...item().question, item: "during-hydration" } }
    fixture.setItems([item(), next])
    read.resolve(JSON.stringify({ ignored: [JSON.stringify(["thread", "question"])] }))
    await vi.waitFor(() => expect(fixture.button("native.question.open")).toBeDefined())
    fixture.button("native.question.open")!.click()
    expect(fixture.open).toHaveBeenCalledWith(next)
    fixture.button("native.question.ignore")!.click()
    await vi.waitFor(() => expect([...writes.values()].some((value) => value.includes("during-hydration"))).toBe(true))
    expect(JSON.parse([...writes.values()].at(-1)!).ignored).toEqual([
      JSON.stringify(["thread", "question"]),
      JSON.stringify(["thread", "during-hydration"]),
    ])
  })
})
