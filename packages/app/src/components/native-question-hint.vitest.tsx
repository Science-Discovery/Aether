import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot, createSignal } from "solid-js"
import type { Event } from "@opencode-ai/sdk/v2"
import { render } from "solid-js/web"
import { createNativeQuestions, NativeQuestionHint, type PendingQuestion } from "./native-question-hint"
import { submittedNativeQuestion } from "./native-question-events"

const mocks = vi.hoisted(() => ({ questions: vi.fn() }))
const listeners = new Set<(event: { details: Event }) => void>()
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    url: "local",
    directory: "/project",
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
    const dispose = render(() => <NativeQuestionHint items={fixture.items()} busy={false} onOpen={open} />, host)
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
