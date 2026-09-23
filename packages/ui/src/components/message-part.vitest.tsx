import { afterEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import type { AssistantMessage, Message, Part as PartType } from "@opencode-ai/sdk/v2"
import { DataProvider } from "../context"
import { MarkedProvider } from "../context/marked"
import { AssistantParts, Part, groupParts } from "./message-part"

vi.mock("@solidjs/router", () => ({
  useLocation: () => ({ pathname: "/workspace/session/root" }),
}))

type Store = Parameters<typeof DataProvider>[0]["data"]

const store = (): Store => ({
  session: [],
  session_status: {},
  session_diff: {},
  message: {},
  part: {},
})

const message = (): Message => ({
  id: "msg",
  sessionID: "root",
  role: "assistant",
  time: {
    created: 1,
    completed: 2,
  },
  parentID: "user",
  modelID: "model",
  providerID: "provider",
  mode: "build",
  agent: "general",
  path: {
    cwd: "/tmp",
    root: "/tmp",
  },
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
})

const task = (status: "completed" | "error"): PartType => ({
  id: "part",
  sessionID: "root",
  messageID: "msg",
  type: "tool",
  callID: "call",
  tool: "task",
  state:
    status === "completed"
      ? {
          status: "completed",
          input: {
            description: "Deep search topic",
            subagent_type: "general",
          },
          output: "done",
          title: "Deep search topic",
          metadata: {
            sessionId: "child",
          },
          time: {
            start: 1,
            end: 2,
          },
        }
      : {
          status: "error",
          input: {
            description: "Deep search topic",
          },
          error: "Error: task failed",
          metadata: {
            sessionId: "child",
          },
          time: {
            start: 1,
            end: 2,
          },
        },
})

function mount(part: PartType, nav?: (sid: string) => void) {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <DataProvider
        data={store()}
        directory="/tmp"
        onNavigateToSession={nav}
        onSessionHref={(sid) => `/workspace/session/${sid}`}
      >
        <Part part={part} message={message()} />
      </DataProvider>
    ),
    host,
  )
  return { host, off }
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("task session links", () => {
  test("uses app session navigation when available", () => {
    const nav = vi.fn()
    const { host, off } = mount(task("completed"), nav)
    const link = host.querySelector("a.subagent-link")
    expect(link?.getAttribute("href")).toBe("/workspace/session/child")

    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    link?.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(nav).toHaveBeenCalledWith("child")

    off()
  })

  test("keeps the href fallback when app session navigation is absent", () => {
    const { host, off } = mount(task("completed"))
    const link = host.querySelector("a.subagent-link")
    expect(link?.getAttribute("href")).toBe("/workspace/session/child")

    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    link?.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)

    off()
  })

  test("uses app session navigation from error cards", () => {
    const nav = vi.fn()
    const { host, off } = mount(task("error"), nav)
    const link = host.querySelector("a.subagent-link")
    expect(link?.getAttribute("href")).toBe("/workspace/session/child")

    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    link?.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(nav).toHaveBeenCalledWith("child")

    off()
  })
})

const assistant = (id: string, error?: AssistantMessage["error"]): AssistantMessage => ({
  ...message(),
  id,
  error,
})

const textPart = (id: string, messageID: string, value: string): PartType =>
  ({
    id,
    type: "text",
    text: value,
    messageID,
    sessionID: "root",
    time: { start: 1, end: 2 },
  }) as PartType

function mountAssistant(messages: AssistantMessage[], parts: Record<string, PartType[]>) {
  const host = document.createElement("div")
  document.body.append(host)
  const data = store()
  data.part = parts
  const off = render(
    () => (
      <DataProvider data={data} directory="/tmp">
        <MarkedProvider>
          <AssistantParts messages={messages} />
        </MarkedProvider>
      </DataProvider>
    ),
    host,
  )
  return { host, off }
}

function textNode(root: ParentNode, value: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() === value) return node.parentElement!
  }
  return undefined
}

const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe("assistant error placement", () => {
  test("renders the error card at the errored message, before later recovery content", async () => {
    const parts = {
      m1: [textPart("p1", "m1", "before error")],
      m3: [textPart("p3", "m3", "recovered response")],
    }
    const messages = [
      assistant("m1"),
      assistant("m2", { name: "APIError", data: { message: "unknown certificate verification error" } }),
      assistant("m3"),
    ]
    const { host, off } = mountAssistant(messages, parts)

    await vi.waitFor(() => {
      expect(textNode(host, "before error")).toBeTruthy()
      expect(textNode(host, "recovered response")).toBeTruthy()
    })
    const before = textNode(host, "before error")!
    const after = textNode(host, "recovered response")!
    const card = host.querySelector(".error-card")
    expect(card?.textContent).toContain("unknown certificate verification error")
    expect(follows(before, card!)).toBe(true)
    expect(follows(card!, after)).toBe(true)

    off()
  })

  test("keeps each card at its own position when several errors hit one turn", async () => {
    const parts = {
      m1: [textPart("p1", "m1", "first")],
      m3: [textPart("p3", "m3", "second")],
      m4: [textPart("p4", "m4", "third")],
    }
    const messages = [
      assistant("m1"),
      assistant("m2", { name: "APIError", data: { message: "rate limit hit" } }),
      assistant("m3"),
      assistant("m4", { name: "APIError", data: { message: "connection lost" } }),
      assistant("m5"),
    ]
    const { host, off } = mountAssistant(messages, parts)

    await vi.waitFor(() => {
      expect(textNode(host, "first")).toBeTruthy()
      expect(textNode(host, "second")).toBeTruthy()
      expect(textNode(host, "third")).toBeTruthy()
    })
    const cards = [...host.querySelectorAll(".error-card")]
    expect(cards.length).toBe(2)
    const second = textNode(host, "second")!
    const third = textNode(host, "third")!
    expect(follows(cards[0]!, second)).toBe(true)
    expect(follows(second, cards[1]!)).toBe(true)
    expect(follows(third, cards[1]!)).toBe(true)

    off()
  })

  test("renders no card for aborted messages", async () => {
    const parts = { m1: [textPart("p1", "m1", "before error")] }
    const messages = [
      assistant("m1"),
      assistant("m2", { name: "MessageAbortedError", data: { message: "Interrupted" } }),
    ]
    const { host, off } = mountAssistant(messages, parts)

    await vi.waitFor(() => expect(textNode(host, "before error")).toBeTruthy())
    expect(host.querySelector(".error-card")).toBeNull()

    off()
  })

  test("keeps a card for an errored message without renderable parts", async () => {
    const parts = { m2: [textPart("p2", "m2", "later")] }
    const messages = [
      assistant("m1", { name: "APIError", data: { message: "boom before any output" } }),
      assistant("m2"),
    ]
    const { host, off } = mountAssistant(messages, parts)

    await vi.waitFor(() => expect(textNode(host, "later")).toBeTruthy())
    const card = host.querySelector(".error-card")
    expect(card?.textContent).toContain("boom before any output")
    const later = textNode(host, "later")!
    expect(follows(card!, later)).toBe(true)

    off()
  })
})

describe("groupParts error markers", () => {
  const text = (id: string, messageID: string): PartType =>
    ({ id, type: "text", text: "x", messageID, sessionID: "root" }) as PartType
  const read = (id: string, messageID: string): PartType =>
    ({ id, type: "tool", tool: "read", messageID, sessionID: "root" }) as unknown as PartType

  test("inserts an error group after the errored message parts", () => {
    const groups = groupParts([
      { messageID: "m1", part: text("p1", "m1") },
      { messageID: "m2", part: undefined, error: true },
      { messageID: "m3", part: text("p3", "m3") },
    ])
    expect(groups.map((group) => group.type)).toEqual(["part", "error", "part"])
    expect(groups[1]?.key).toBe("error:m2")
  })

  test("splits a spanning context group at an error marker", () => {
    const groups = groupParts([
      { messageID: "m1", part: read("p1", "m1") },
      { messageID: "m1", part: read("p2", "m1") },
      { messageID: "m2", part: undefined, error: true },
      { messageID: "m3", part: read("p3", "m3") },
    ])
    expect(groups.map((group) => group.type)).toEqual(["context", "error", "context"])
    if (groups[0]?.type !== "context" || groups[2]?.type !== "context") throw new Error("expected context groups")
    expect(groups[0].refs.length).toBe(2)
    expect(groups[2].refs.length).toBe(1)
  })

  test("flushes a trailing context group before a final error marker", () => {
    const groups = groupParts([
      { messageID: "m1", part: read("p1", "m1") },
      { messageID: "m1", part: undefined, error: true },
    ])
    expect(groups.map((group) => group.type)).toEqual(["context", "error"])
  })
})
