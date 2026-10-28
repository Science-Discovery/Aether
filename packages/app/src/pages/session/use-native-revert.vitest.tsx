import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createRoot, createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2"
import type { Prompt } from "@/context/prompt"
import { sanitizePromptState } from "@/context/prompt-persist"
import { extractPromptFromParts } from "@/utils/prompt"
import { base64Encode } from "@opencode-ai/util/encode"
import { NativeRevertNotice, useNativeRevert } from "./use-native-revert"

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  revert: vi.fn(),
  status: vi.fn(),
  set: vi.fn(),
  show: vi.fn(),
  close: vi.fn(),
  toast: vi.fn(),
  invalidate: vi.fn(),
  sync: vi.fn(),
}))
let id = () => "source"
let drafts: Record<string, Prompt> = {}
let context: { key: string }[] = []
let sessions: Session[] = []
let parts: Part[] = []
let messages: Message[] = []
const prepared = {
  id: "operation",
  sessionID: "source",
  threadID: "thread",
  messageID: "user",
  turnID: "turn",
  turns: 2,
}
const applied = { ...prepared, state: "applied" as const }
const cleanups: VoidFunction[] = []
const text = (content: string): Prompt => [{ type: "text", content, start: 0, end: content.length }]
vi.mock("@solidjs/router", () => ({
  useParams: () => ({
    get id() {
      return id()
    },
  }),
}))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    url: "local",
    directory: "/project",
    client: {
      native: {
        prepareRevert: mocks.prepare,
        revert: mocks.revert,
        revertStatus: mocks.status,
      },
    },
  }),
}))
vi.mock("@/context/sync", () => ({
  useSync: () => ({
    data: {
      get session() {
        return sessions
      },
      get part() {
        return { user: parts }
      },
      get message() {
        return { source: messages }
      },
    },
    session: { invalidate: mocks.invalidate, sync: mocks.sync },
  }),
}))
vi.mock("@/context/prompt", () => ({
  usePrompt: () => ({
    ready: () => true,
    dirty: () => !!drafts[id()]?.some((part) => part.type !== "text" || !!part.content.trim()),
    context: { items: () => context },
    set: mocks.set,
  }),
}))
vi.mock("@/context/conversation-quote", () => ({ useMaybeConversationQuote: () => undefined }))
vi.mock("@/context/file-quote", () => ({ useMaybeFileQuote: () => undefined }))
vi.mock("@/context/quick-reading-mode", () => ({ useMaybeQuickReadingMode: () => undefined }))
vi.mock("@/context/reading-mode", () => ({ useMaybeReadingMode: () => undefined }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: mocks.toast }))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: mocks.show, close: mocks.close }) }))
vi.mock("@opencode-ai/ui/dialog", () => ({ Dialog: (props: { children: JSX.Element }) => <div>{props.children}</div> }))
vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}))

beforeEach(() => {
  vi.clearAllMocks()
  drafts = {}
  context = []
  sessions = ["source", "other"].map(
    (id): Session => ({
      id,
      directory: "/project",
      slug: id,
      projectID: "project",
      title: id,
      version: "1",
      time: { created: 1, updated: 1 },
      engine: { type: "codex", thread: "thread" },
    }),
  )
  messages = [
    {
      id: "user",
      sessionID: "source",
      role: "user",
      time: { created: 1 },
      agent: "codex",
      model: { providerID: "codex-native", modelID: "model" },
    },
  ]
  parts = [{ id: "part", sessionID: "source", messageID: "user", type: "text", text: "Original question" }]
  mocks.status.mockResolvedValue({ data: null })
  mocks.prepare.mockResolvedValue({ data: prepared })
  mocks.revert.mockResolvedValue({ data: { state: "applied", session: sessions[0] } })
  mocks.sync.mockResolvedValue(undefined)
  mocks.set.mockImplementation((value: Prompt, _: unknown, scope: { id: string }) => {
    drafts[scope.id] = value
  })
})
afterEach(() => cleanups.splice(0).forEach((off) => off()))
function mount() {
  const [value, set] = createSignal("source")
  id = value
  const result = createRoot((dispose) => {
    cleanups.push(dispose)
    return useNativeRevert()
  })
  return { result, set }
}
function notice(result: ReturnType<typeof useNativeRevert>) {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <NativeRevertNotice revert={result} />, host)
  cleanups.push(() => {
    off()
    host.remove()
  })
  return host
}
function confirm() {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(mocks.show.mock.calls.at(-1)![0], host)
  cleanups.push(() => {
    off()
    host.remove()
  })
  return [...host.querySelectorAll("button")].find((item) => item.textContent === "native.revert.confirm")!
}
const input = { sessionID: "source", messageID: "user" }
const ready = (result: ReturnType<typeof useNativeRevert>) => vi.waitFor(() => expect(result.blocked()).toBe(false))

test("requires confirmation and preserves the question before reverting within the same session", async () => {
  const { result } = mount()
  await ready(result)
  await result.edit(input)
  expect(mocks.prepare).toHaveBeenCalledWith(input, { throwOnError: true })
  expect(mocks.revert).not.toHaveBeenCalled()
  expect(mocks.set).not.toHaveBeenCalled()
  const pending = Promise.withResolvers<{ data: { state: "applied"; session: Session } }>()
  mocks.revert.mockImplementation(() => {
    expect(drafts.source).toEqual(text("Original question"))
    return pending.promise
  })
  confirm().click()
  expect(result.blocked()).toBe(true)
  expect(mocks.set).toHaveBeenCalledWith(text("Original question"), undefined, {
    dir: base64Encode("/project"),
    id: "source",
  })
  mocks.status.mockResolvedValue({ data: applied })
  pending.resolve({ data: { state: "applied", session: sessions[0] } })
  await ready(result)
  expect(mocks.revert).toHaveBeenCalledExactlyOnceWith({ sessionID: "source", id: "operation" }, { throwOnError: true })
  expect(mocks.invalidate).toHaveBeenCalledWith("source")
  expect(mocks.sync).toHaveBeenCalledWith("source", { force: true })
  expect(result.notice()).toBe(false)
})

test("rejects an existing draft or selected context before preparing a destructive operation", async () => {
  const { result } = mount()
  await ready(result)
  drafts.source = text("Keep this draft")
  await result.edit(input)
  drafts.source = []
  context = [{ key: "selection" }]
  await result.edit(input)
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(mocks.set).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenCalledTimes(2)
})

test("rejects nonrecoverable attachments and internal question answers before preparation", async () => {
  const { result } = mount()
  await ready(result)
  parts.push({
    id: "image",
    messageID: "user",
    sessionID: "source",
    type: "file",
    mime: "image/png",
    url: "file:///private.png",
  })
  await result.edit(input)
  parts = [
    {
      id: "reply",
      messageID: "user",
      sessionID: "source",
      type: "text",
      text: "<send_user_message_question_reply>[]</send_user_message_question_reply>",
    },
  ]
  await result.edit(input)
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(mocks.revert).not.toHaveBeenCalled()
})

test("rejects extracted images that would be lost when the real draft persistence reloads", async () => {
  const { result } = mount()
  await ready(result)
  parts.push({
    id: "image",
    messageID: "user",
    sessionID: "source",
    type: "file",
    mime: "image/png",
    url: "data:image/png;base64,aW1hZ2U=",
  })
  const value = extractPromptFromParts(parts, { directory: "/project" })
  expect(value.some((part) => part.type === "image")).toBe(true)
  expect(sanitizePromptState({ prompt: value }).prompt).toEqual(text("Original question"))
  await result.edit(input)
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(mocks.revert).not.toHaveBeenCalled()
  expect(mocks.set).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenCalledWith({ title: "native.revert.unsupported" })
})

test("does not overwrite a draft written while confirmation is open", async () => {
  const { result } = mount()
  await ready(result)
  await result.edit(input)
  drafts.source = text("New draft")
  confirm().click()
  expect(mocks.revert).not.toHaveBeenCalled()
  expect(drafts.source).toEqual(text("New draft"))
})

test("does not open an old confirmation after switching sessions", async () => {
  const { result, set } = mount()
  await ready(result)
  const pending = Promise.withResolvers<{ data: typeof prepared }>()
  mocks.prepare.mockReturnValue(pending.promise)
  const task = result.edit(input)
  set("other")
  pending.resolve({ data: prepared })
  await task
  expect(mocks.show).not.toHaveBeenCalled()
  expect(mocks.set).not.toHaveBeenCalled()
})

test("keeps the scoped original draft and leaves a later session untouched after dispatch", async () => {
  const { result, set } = mount()
  await ready(result)
  await result.edit(input)
  const pending = Promise.withResolvers<{ data: { state: "applied"; session: Session } }>()
  mocks.revert.mockReturnValue(pending.promise)
  confirm().click()
  drafts.other = text("Other draft")
  set("other")
  pending.resolve({ data: { state: "applied", session: sessions[0] } })
  await ready(result)
  expect(drafts.source).toEqual(text("Original question"))
  expect(drafts.other).toEqual(text("Other draft"))
  expect(mocks.set).toHaveBeenCalledTimes(1)
  expect(mocks.sync).not.toHaveBeenCalled()
})

test("recovers a pending revert after reload using the same operation id without replacing the draft", async () => {
  drafts.source = text("Restored draft")
  mocks.status.mockResolvedValue({ data: { ...prepared, state: "uncertain", error: "Connection lost" } })
  const { result } = mount()
  const host = notice(result)
  await vi.waitFor(() => expect(result.notice()).toBe(true))
  expect(result.blocked()).toBe(true)
  expect(host.textContent).toContain("native.revert.check")
  mocks.status.mockResolvedValue({ data: applied })
  host.querySelector("button")!.click()
  await ready(result)
  expect(mocks.revert).toHaveBeenCalledWith({ sessionID: "source", id: "operation" }, { throwOnError: true })
  expect(mocks.prepare).not.toHaveBeenCalled()
  expect(mocks.set).not.toHaveBeenCalled()
  expect(drafts.source).toEqual(text("Restored draft"))
})

test("keeps the draft on a definite rejection and unlocks when the server confirms no pending revert", async () => {
  const { result } = mount()
  await ready(result)
  await result.edit(input)
  mocks.revert.mockRejectedValue(new Error("Conversation changed"))
  confirm().click()
  await ready(result)
  expect(drafts.source).toEqual(text("Original question"))
  expect(mocks.toast).toHaveBeenCalled()
  expect(mocks.sync).not.toHaveBeenCalled()
})

test("does not unlock sending if the status response is missing or cannot be read", async () => {
  mocks.status.mockResolvedValue({})
  const { result } = mount()
  await vi.waitFor(() => expect(result.notice()).toBe(true))
  expect(result.blocked()).toBe(true)
  mocks.status.mockResolvedValue({ data: null })
  await result.check()
  await ready(result)
})
