import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot, createSignal } from "solid-js"
import type { Part, Session, TextPart } from "@opencode-ai/sdk/v2"
import { base64Encode } from "@opencode-ai/util/encode"
import { useSessionFork } from "./use-session-fork"

const mocks = vi.hoisted(() => ({ fork: vi.fn(), prompt: vi.fn(), navigate: vi.fn(), toast: vi.fn() }))
let id = () => "source"
let sessions: Session[] = []
const text: TextPart = {
  id: "text",
  sessionID: "source",
  messageID: "user",
  type: "text",
  text: "Please revise the proof",
}
const parts: Part[] = [text]
vi.mock("@solidjs/router", () => ({
  useParams: () => ({
    get id() {
      return id()
    },
  }),
  useNavigate: () => mocks.navigate,
}))
vi.mock("@/context/sdk", () => ({
  useSDK: () => ({ url: "local", directory: "/project", client: { session: { fork: mocks.fork } } }),
}))
vi.mock("@/context/sync", () => ({
  useSync: () => ({
    data: {
      get session() {
        return sessions
      },
      part: { user: parts },
    },
    set: (_: string, update: (items: Session[]) => Session[]) => {
      sessions = update(sessions)
    },
  }),
}))
vi.mock("@/context/prompt", () => ({ usePrompt: () => ({ set: mocks.prompt }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: mocks.toast }))

const session = (id: string): Session => ({
  id,
  directory: "/project",
  projectID: "project",
  slug: id,
  title: id,
  version: "1",
  time: { created: 1, updated: 1 },
  engine: { type: "codex", model: "model", effort: "high", mode: "plan", permission: "auto", thread: id },
})
const cleanups: VoidFunction[] = []
function mount() {
  const [value, set] = createSignal("source")
  id = value
  const fork = createRoot((dispose) => {
    cleanups.push(dispose)
    return useSessionFork()
  })
  return { fork, set }
}
beforeEach(() => {
  vi.clearAllMocks()
  sessions = [session("source")]
  text.text = "Please revise the proof"
  parts.splice(0, parts.length, text)
  mocks.fork.mockResolvedValue({ data: session("child") })
})
afterEach(() => cleanups.splice(0).forEach((dispose) => dispose()))

describe("native fork actions", () => {
  test("forks after the selected turn without resending or restoring its question", async () => {
    await mount().fork({ sessionID: "source", messageID: "user" }, "fork")
    expect(mocks.fork).toHaveBeenCalledExactlyOnceWith(
      { sessionID: "source", messageID: "user", after: true },
      { throwOnError: true },
    )
    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(sessions.find((item) => item.id === "child")?.engine).toEqual(session("child").engine)
    expect(mocks.navigate).toHaveBeenCalledWith(`/${base64Encode("/project")}/session/child`)
  })

  test("edits before the selected turn into a scoped draft in the new session", async () => {
    await mount().fork({ sessionID: "source", messageID: "user" }, "edit")
    expect(mocks.fork.mock.calls[0][0].after).toBe(false)
    expect(mocks.prompt).toHaveBeenCalledExactlyOnceWith(
      [{ type: "text", content: "Please revise the proof", start: 0, end: 23 }],
      undefined,
      { dir: base64Encode("/project"), id: "child" },
    )
    expect(sessions.find((item) => item.id === "source")?.engine?.thread).toBe("source")
  })

  test("keeps the existing Aether fork draft behavior", async () => {
    sessions = [{ ...session("source"), engine: undefined }]
    await mount().fork({ sessionID: "source", messageID: "user" }, "fork")
    expect(mocks.fork.mock.calls[0][0]).toEqual({ sessionID: "source", messageID: "user" })
    expect(mocks.prompt).toHaveBeenCalledTimes(1)
  })

  test("navigates and scopes the draft to the returned source directory", async () => {
    sessions = [{ ...session("source"), directory: "/other" }]
    mocks.fork.mockResolvedValue({ data: { ...session("child"), directory: "/other" } })
    await mount().fork({ sessionID: "source", messageID: "user" }, "edit")
    expect(mocks.navigate).toHaveBeenCalledWith(`/${base64Encode("/other")}/session/child`)
    expect(mocks.prompt.mock.calls[0][2]).toEqual({ dir: base64Encode("/other"), id: "child" })
    expect(sessions.some((item) => item.id === "child")).toBe(false)
  })

  test("never restores an internal question answer marker as an editable draft", async () => {
    text.text = "<send_user_message_question_reply>internal answer</send_user_message_question_reply>"
    await mount().fork({ sessionID: "source", messageID: "user" }, "edit")
    expect(mocks.fork).not.toHaveBeenCalled()
    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(mocks.toast.mock.calls[0][0].title).toBe("native.fork.questionReply")
  })

  test("deduplicates clicks and ignores a response after switching away and back", async () => {
    const response = Promise.withResolvers<{ data: Session }>()
    mocks.fork.mockReturnValue(response.promise)
    const fixture = mount()
    const first = fixture.fork({ sessionID: "source", messageID: "user" }, "edit")
    await fixture.fork({ sessionID: "source", messageID: "user" }, "edit")
    fixture.set("another")
    fixture.set("source")
    response.resolve({ data: session("child") })
    await first
    expect(mocks.fork).toHaveBeenCalledTimes(1)
    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  test("keeps the original session on a refused boundary and displays the reason", async () => {
    mocks.fork.mockRejectedValue(new Error("This turn is still running"))
    await mount().fork({ sessionID: "source", messageID: "user" }, "edit")
    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.toast.mock.calls[0][0].description).toContain("This turn is still running")
  })

  test.each(["image/png", "application/pdf"])(
    "refuses editing an imported %s attachment without dropping it",
    async (mime) => {
      parts.push({
        id: "file",
        sessionID: "source",
        messageID: "user",
        type: "file",
        mime,
        url: "file:///project/attachment",
      })
      const fixture = mount()
      await fixture.fork({ sessionID: "source", messageID: "user" }, "edit")
      expect(mocks.fork).not.toHaveBeenCalled()
      expect(mocks.prompt).not.toHaveBeenCalled()
      expect(mocks.toast.mock.calls[0][0].title).toBe("native.fork.unsupportedDraft")
      await fixture.fork({ sessionID: "source", messageID: "user" }, "fork")
      expect(mocks.fork.mock.calls[0][0].after).toBe(true)
    },
  )

  test("refuses research questions whose ignored question and synthetic context cannot be restored", async () => {
    parts.splice(
      0,
      parts.length,
      { ...text, ignored: true },
      { ...text, id: "context", synthetic: true, text: "PDF selected text and the research question" },
    )
    await mount().fork({ sessionID: "source", messageID: "user" }, "edit")
    expect(mocks.fork).not.toHaveBeenCalled()
    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(mocks.toast.mock.calls[0][0].title).toBe("native.fork.unsupportedDraft")
  })

  test("preserves data images and ignores empty internal metadata while editing", async () => {
    parts.push(
      { ...text, id: "receipt", text: "", synthetic: true, ignored: true, metadata: { native: { turn: "turn" } } },
      {
        id: "image",
        sessionID: "source",
        messageID: "user",
        type: "file",
        mime: "image/png",
        filename: "plot.png",
        url: "data:image/png;base64,AQ==",
      },
    )
    await mount().fork({ sessionID: "source", messageID: "user" }, "edit")
    expect(mocks.fork.mock.calls[0][0].after).toBe(false)
    expect(mocks.prompt.mock.calls[0][0]).toEqual([
      { type: "text", content: "Please revise the proof", start: 0, end: 23 },
      { type: "image", id: "image", filename: "plot.png", mime: "image/png", dataUrl: "data:image/png;base64,AQ==" },
    ])
  })

  test("refuses malformed inline references and multiple text blocks that extraction would omit", async () => {
    parts.push({
      id: "file",
      sessionID: "source",
      messageID: "user",
      type: "file",
      mime: "text/plain",
      url: "file:///project/proof.txt",
      source: { type: "file", path: "/project/proof.txt", text: { value: "@proof.txt", start: 0, end: 10 } },
    })
    const fixture = mount()
    await fixture.fork({ sessionID: "source", messageID: "user" }, "edit")
    expect(mocks.fork).not.toHaveBeenCalled()
    parts.splice(1, 1, { ...text, id: "more", text: "Also preserve this second instruction" })
    await fixture.fork({ sessionID: "source", messageID: "user" }, "edit")
    expect(mocks.fork).not.toHaveBeenCalled()
    expect(mocks.prompt).not.toHaveBeenCalled()
  })
})
