import { afterEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import type { Message, Part as PartType } from "@opencode-ai/sdk/v2"
import { DataProvider } from "../context"
import { Part } from "./message-part"

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
