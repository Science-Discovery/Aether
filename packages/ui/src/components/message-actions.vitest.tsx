import { afterEach, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { DataProvider, DialogProvider } from "../context"
import { UserMessageDisplay } from "./message-part"
import { SessionTurn } from "./session-turn"
import { MarkedProvider } from "../context/marked"
import { FileComponentProvider } from "../context/file"
import type { AssistantMessage, UserMessage, Part } from "@opencode-ai/sdk/v2"

vi.mock("@solidjs/router", () => ({ useLocation: () => ({ pathname: "/project/session/session" }) }))

const cleanups: VoidFunction[] = []
afterEach(() => cleanups.splice(0).forEach((off) => off()))

function mount(text: string) {
  const fork = vi.fn()
  const edit = vi.fn()
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => (
      <DataProvider
        data={{ session: [], session_status: {}, session_diff: {}, message: {}, part: {} }}
        directory="/project"
      >
        <DialogProvider>
          <UserMessageDisplay
            message={{
              id: "user",
              sessionID: "session",
              role: "user",
              time: { created: 1 },
              agent: "codex",
              model: { providerID: "codex-native", modelID: "model" },
            }}
            parts={[{ id: "part", messageID: "user", sessionID: "session", type: "text", text }]}
            actions={{ fork, edit }}
          />
        </DialogProvider>
      </DataProvider>
    ),
    host,
  )
  cleanups.push(() => {
    dispose()
    host.remove()
  })
  return { host, fork, edit }
}

test("keeps native draft editing under the question without offering fork or in-place revert", async () => {
  const fixture = mount("Original question")
  expect(fixture.host.querySelector('[aria-label="Fork to new session"]')).toBeNull()
  expect(fixture.fork).not.toHaveBeenCalled()
  fixture.host.querySelector<HTMLButtonElement>('[aria-label="Edit in a new session"]')?.click()
  await vi.waitFor(() => expect(fixture.edit).toHaveBeenCalledWith({ sessionID: "session", messageID: "user" }))
  expect(fixture.host.querySelector('[aria-label="Revert to this message"]')).toBeNull()
})

test("offers native fork below the complete AI response and submits the assistant boundary", async () => {
  const fork = vi.fn()
  const user: UserMessage = {
    id: "user",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    agent: "codex",
    model: { providerID: "codex-native", modelID: "model" },
  }
  const assistant: AssistantMessage = {
    id: "assistant",
    sessionID: "session",
    role: "assistant",
    parentID: user.id,
    time: { created: 2, completed: 3 },
    providerID: "codex-native",
    modelID: "model",
    mode: "default",
    agent: "codex",
    path: { cwd: "/project", root: "/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const part = (id: string, text: string): Part => ({
    id: `${id}-text`,
    messageID: id,
    sessionID: "session",
    type: "text",
    text,
    metadata: { native: { turn: "turn" } },
  })
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <DataProvider
        data={{
          session: [],
          session_status: {},
          session_diff: {},
          message: { session: [user, assistant] },
          part: { user: [part("user", "Question")], assistant: [part("assistant", "Complete answer")] },
        }}
        directory="/project"
      >
        <MarkedProvider>
          <DialogProvider>
            <FileComponentProvider component={() => null}>
              <SessionTurn sessionID="session" messageID="user" actions={{ response: fork }} />
            </FileComponentProvider>
          </DialogProvider>
        </MarkedProvider>
      </DataProvider>
    ),
    host,
  )
  cleanups.push(() => {
    off()
    host.remove()
  })
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Fork after this response"]')).not.toBeNull())
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Fork after this response"]')!
  expect(button.closest('[data-slot="text-part-actions"]')).not.toBeNull()
  button.click()
  await vi.waitFor(() => expect(fork).toHaveBeenCalledExactlyOnceWith({ sessionID: "session", messageID: "assistant" }))
  expect(host.querySelector('[aria-label="Fork to new session"]')).toBeNull()
})

test("does not offer draft editing for internal async answer payloads", () => {
  const text = `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "item", 0]), question: "Which method?", answer: "A" }])}</send_user_message_question_reply>`
  const fixture = mount(text)
  expect(fixture.host.querySelector('[aria-label="Edit in a new session"]')).toBeNull()
  expect(fixture.host.textContent).toContain("Which method?: A")
  expect(fixture.host.textContent).not.toContain("send_user_message_question_reply")
})
