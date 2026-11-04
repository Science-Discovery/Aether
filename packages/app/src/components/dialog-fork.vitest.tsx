import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { For, type JSX } from "solid-js"
import type { AssistantMessage, Message, Part, Session, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { DialogFork } from "./dialog-fork"

const mocks = vi.hoisted(() => ({ fork: vi.fn(), close: vi.fn() }))
const data: {
  session: Session[]
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  session_status: Record<string, SessionStatus>
} = {
  session: [],
  message: {},
  part: {},
  session_status: {},
}
vi.mock("@solidjs/router", () => ({
  useParams: () => ({ id: "session" }),
  useLocation: () => ({ pathname: "/project/session/session" }),
}))
vi.mock("@/context/sync", () => ({ useSync: () => ({ data }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/pages/session/use-session-fork", () => ({ useSessionFork: () => mocks.fork }))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ close: mocks.close }) }))
vi.mock("@opencode-ai/ui/dialog", () => ({ Dialog: (props: { children: JSX.Element }) => <div>{props.children}</div> }))
vi.mock("@opencode-ai/ui/list", () => ({
  List: (props: {
    items: () => { id: string; text: string; time: string }[]
    onSelect: (item: { id: string; text: string; time: string }) => void
  }) => (
    <For each={props.items()}>
      {(item) => (
        <button data-message={item.id} onClick={() => props.onSelect(item)}>
          {item.text}
        </button>
      )}
    </For>
  ),
}))

const user = (id: string): UserMessage => ({
  id,
  sessionID: "session",
  role: "user",
  time: { created: 1 },
  agent: "codex",
  model: { providerID: "codex-native", modelID: "model" },
})
const answer = (id: string, parentID: string): AssistantMessage => ({
  id,
  parentID,
  sessionID: "session",
  role: "assistant",
  time: { created: 2, completed: 3 },
  providerID: "codex-native",
  modelID: "model",
  mode: "default",
  agent: "codex",
  path: { cwd: "/project", root: "/project" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const cleanups: VoidFunction[] = []
beforeEach(() => {
  vi.clearAllMocks()
  data.session = [
    {
      id: "session",
      directory: "/project",
      slug: "session",
      projectID: "project",
      title: "title",
      version: "1",
      time: { created: 1, updated: 1 },
      engine: { type: "codex" },
    },
  ]
  data.message = { session: [user("user"), answer("before-steer", "user"), user("steer"), answer("final", "steer")] }
  data.part = Object.fromEntries(
    data.message.session.map((message) => [
      message.id,
      [
        {
          id: `${message.id}-text`,
          messageID: message.id,
          sessionID: "session",
          type: "text",
          text: message.id,
          metadata: { native: { turn: "turn" } },
        },
      ],
    ]),
  )
  data.session_status = {}
})
afterEach(() => cleanups.splice(0).forEach((off) => off()))
function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(() => <DialogFork />, host)
  cleanups.push(() => {
    off()
    host.remove()
  })
  return host
}
test("native dialog selects the final AI response of a complete turn", () => {
  const host = mount()
  expect([...host.querySelectorAll("[data-message]")].map((item) => item.getAttribute("data-message"))).toEqual([
    "final",
  ])
  host.querySelector<HTMLButtonElement>("[data-message]")!.click()
  expect(mocks.fork).toHaveBeenCalledWith({ sessionID: "session", messageID: "final" }, "fork", expect.any(Function))
})
test("native dialog offers no boundaries while busy and Aether keeps question-based forks", () => {
  data.session_status.session = { type: "busy" }
  expect(mount().querySelectorAll("[data-message]")).toHaveLength(0)
  data.session[0].engine = undefined
  expect([...mount().querySelectorAll("[data-message]")].map((item) => item.getAttribute("data-message"))).toEqual([
    "steer",
    "user",
  ])
})
