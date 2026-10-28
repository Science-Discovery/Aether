import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { AssistantMessage, NativeQuestion } from "@opencode-ai/sdk/v2"
import { NativeQuestionCard } from "./native-question"
import { nativeQuestionAnchor } from "./native-question-events"

type Reply = { sessionID: string; itemID: string; threadID: string; answers: string[] }
const mocks = vi.hoisted(() => ({ reply: vi.fn<(input: Reply) => Promise<{ data: NativeQuestion }>>() }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({ url: "local", directory: "/project", client: { native: { replyQuestion: mocks.reply } } }),
}))

const question = (): NativeQuestion => ({
  thread: "thread",
  turn: "turn",
  item: "question",
  state: "pending",
  questions: [{ title: "Which method?", options: ["A", "B"] }, { title: "What should change?" }],
})
const message = (): AssistantMessage => ({
  id: "assistant",
  sessionID: "session",
  role: "assistant",
  time: { created: 1 },
  parentID: "user",
  modelID: "model",
  providerID: "codex-native",
  mode: "build",
  agent: "codex",
  path: { cwd: "/project", root: "/project" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const cleanups: VoidFunction[] = []

function mount(value = question()) {
  const [data, set] = createSignal(value)
  const [part, setPart] = createSignal("part")
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <NativeQuestionCard
        part={{
          id: part(),
          sessionID: "session",
          messageID: "assistant",
          type: "text",
          text: "",
          nativeQuestion: data(),
        }}
        message={message()}
      />
    ),
    host,
  )
  cleanups.push(() => {
    off()
    host.remove()
  })
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!
  const fill = (index: number, text: string) => {
    const input = host.querySelectorAll<HTMLTextAreaElement>("textarea")[index]!
    input.value = text
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }
  return { host, set, button, fill, setPart }
}

beforeEach(() => {
  mocks.reply.mockReset()
  mocks.reply.mockImplementation(async (input) => ({
    data: { ...question(), answers: input.answers, state: "answered" },
  }))
})
afterEach(() => cleanups.splice(0).forEach((off) => off()))

describe("native async questions", () => {
  test("requires every answer, supports options and custom text, and submits once", async () => {
    const fixture = mount()
    const submit = fixture.button("native.question.submit")
    expect(submit.disabled).toBe(true)
    fixture.fill(1, "Keep the citations")
    expect(submit.disabled).toBe(true)
    fixture.button("B").click()
    expect(submit.disabled).toBe(false)
    submit.click()
    submit.click()
    await vi.waitFor(() => expect(fixture.host.querySelector("section")?.dataset.state).toBe("answered"))
    expect(mocks.reply).toHaveBeenCalledExactlyOnceWith(
      { sessionID: "session", itemID: "question", threadID: "thread", answers: ["B", "Keep the citations"] },
      { throwOnError: true },
    )
    expect(fixture.host.querySelector("textarea")).toBeNull()
    expect(fixture.host.textContent).toContain("Keep the citations")
  })

  test("restores an answered card without another submission", () => {
    const fixture = mount({ ...question(), state: "answered", answers: ["A", "Saved answer"] })
    expect(fixture.host.textContent).toContain("Saved answer")
    expect(fixture.host.querySelector("button")).toBeNull()
    expect(mocks.reply).not.toHaveBeenCalled()
  })

  test("preserves a draft across updates to the same question", () => {
    const fixture = mount()
    fixture.fill(0, "A custom approach")
    const input = fixture.host.querySelector<HTMLTextAreaElement>("textarea")!
    input.focus()
    fixture.set({ ...question() })
    expect(fixture.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("A custom approach")
    expect(document.activeElement).toBe(input)
    expect(mocks.reply).not.toHaveBeenCalled()
  })

  test("keeps the same question anchor when synchronization replaces its part ID", () => {
    const value = { ...question(), thread: "thread/α", item: "question?#" }
    const fixture = mount(value)
    const anchor = nativeQuestionAnchor("session", value)
    const card = document.getElementById(anchor)
    expect(card).toBe(fixture.host.querySelector("section"))
    fixture.fill(0, "Keep this draft")
    fixture.setPart("projected-part")
    fixture.set({ ...value })
    const projected = document.getElementById(anchor)
    expect(projected).toBe(card)
    projected?.focus()
    expect(document.activeElement).toBe(projected)
    expect(fixture.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Keep this draft")
    expect(nativeQuestionAnchor("another-session", value)).not.toBe(anchor)
    expect(mocks.reply).not.toHaveBeenCalled()
  })

  test("keeps an answered SSE state when an older sending response arrives", async () => {
    const pending = Promise.withResolvers<{ data: NativeQuestion }>()
    mocks.reply.mockReturnValue(pending.promise)
    const fixture = mount()
    fixture.button("A").click()
    fixture.fill(1, "Saved")
    fixture.button("native.question.submit").click()
    fixture.set({ ...question(), state: "answered", answers: ["A", "Saved"] })
    pending.resolve({ data: { ...question(), state: "sending", answers: ["A", "Saved"] } })
    await vi.waitFor(() => expect(fixture.host.querySelector("section")?.getAttribute("aria-busy")).toBe("false"))
    expect(fixture.host.querySelector("section")?.dataset.state).toBe("answered")
    expect(fixture.host.querySelector("button")).toBeNull()
  })

  test.each(["failed", "uncertain"] as const)(
    "preserves a newer %s SSE state over a delayed sending response",
    async (state) => {
      const pending = Promise.withResolvers<{ data: NativeQuestion }>()
      mocks.reply.mockReturnValue(pending.promise)
      const fixture = mount()
      fixture.button("A").click()
      fixture.fill(1, "Saved")
      fixture.button("native.question.submit").click()
      fixture.set({ ...question(), state, answers: ["A", "Saved"], error: "Authoritative result" })
      pending.resolve({ data: { ...question(), state: "sending", answers: ["A", "Saved"] } })
      await vi.waitFor(() => expect(fixture.host.querySelector("section")?.getAttribute("aria-busy")).toBe("false"))
      expect(fixture.host.querySelector("section")?.dataset.state).toBe(state)
      expect(fixture.host.querySelector('[role="alert"]')?.textContent).toBe("Authoritative result")
      if (state !== "failed") return
      mocks.reply.mockResolvedValueOnce({ data: { ...question(), state: "sending", answers: ["A", "Saved"] } })
      fixture.button("native.question.retry").click()
      await vi.waitFor(() => expect(fixture.host.querySelector("section")?.dataset.state).toBe("sending"))
      expect(fixture.host.querySelector('[role="alert"]')).toBeNull()
    },
  )

  test("checks uncertain delivery using the same saved identity and answers", async () => {
    mocks.reply.mockRejectedValueOnce({ error: "connection closed" })
    const fixture = mount()
    fixture.button("B").click()
    fixture.fill(1, "Unchanged")
    fixture.button("native.question.submit").click()
    await vi.waitFor(() => expect(fixture.host.querySelector("section")?.dataset.state).toBe("uncertain"))
    expect(fixture.host.querySelector('[role="alert"]')?.textContent).toBe("connection closed")
    expect(fixture.host.querySelector("textarea")).toBeNull()
    expect(mocks.reply).toHaveBeenCalledTimes(1)
    fixture.button("native.question.check").click()
    await vi.waitFor(() => expect(fixture.host.querySelector("section")?.dataset.state).toBe("answered"))
    expect(mocks.reply.mock.calls[1][0]).toEqual(mocks.reply.mock.calls[0][0])
  })

  test("does not show a late request failure after the answer was confirmed by SSE", async () => {
    const pending = Promise.withResolvers<{ data: NativeQuestion }>()
    mocks.reply.mockReturnValue(pending.promise)
    const fixture = mount()
    fixture.button("A").click()
    fixture.fill(1, "Saved")
    fixture.button("native.question.submit").click()
    fixture.set({ ...question(), state: "answered", answers: ["A", "Saved"] })
    pending.reject(new Error("connection closed"))
    await vi.waitFor(() => expect(fixture.host.querySelector("section")?.getAttribute("aria-busy")).toBe("false"))
    expect(fixture.host.querySelector("section")?.dataset.state).toBe("answered")
    expect(fixture.host.querySelector('[role="alert"]')).toBeNull()
  })

  test("offers only receipt checks for restored uncertainty and safe retries for failed answers", async () => {
    const fixture = mount({ ...question(), state: "uncertain", answers: ["A", "Saved"] })
    expect(fixture.button("native.question.check")).toBeDefined()
    expect(mocks.reply).not.toHaveBeenCalled()
    fixture.set({ ...question(), state: "failed", answers: ["A", "Saved"] })
    fixture.button("native.question.retry").click()
    await vi.waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(1))
    expect(mocks.reply.mock.calls[0][0].answers).toEqual(["A", "Saved"])
  })

  test("ignores a submission result after switching to another question", async () => {
    const pending = Promise.withResolvers<{ data: NativeQuestion }>()
    mocks.reply.mockReturnValue(pending.promise)
    const fixture = mount()
    fixture.button("A").click()
    fixture.fill(1, "Old answer")
    fixture.button("native.question.submit").click()
    fixture.set({ ...question(), item: "other" })
    pending.resolve({ data: { ...question(), state: "answered", answers: ["A", "Old answer"] } })
    await Promise.resolve()
    expect(fixture.host.querySelector("section")?.dataset.state).toBe("pending")
    expect(fixture.host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("")
  })
})
