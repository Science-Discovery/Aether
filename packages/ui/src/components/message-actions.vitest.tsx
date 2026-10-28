import { afterEach, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { DataProvider, DialogProvider } from "../context"
import { UserMessageDisplay } from "./message-part"

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

test("offers separate native fork and draft editing actions without an in-place revert", async () => {
  const fixture = mount("Original question")
  fixture.host.querySelector<HTMLButtonElement>('[aria-label="Fork to new session"]')?.click()
  await vi.waitFor(() => expect(fixture.fork).toHaveBeenCalledWith({ sessionID: "session", messageID: "user" }))
  fixture.host.querySelector<HTMLButtonElement>('[aria-label="Edit in a new session"]')?.click()
  await vi.waitFor(() => expect(fixture.edit).toHaveBeenCalledWith({ sessionID: "session", messageID: "user" }))
  expect(fixture.host.querySelector('[aria-label="Revert to this message"]')).toBeNull()
})

test("does not offer draft editing for internal async answer payloads", () => {
  const text = `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: JSON.stringify(["request_user_input_async", "item", 0]), question: "Which method?", answer: "A" }])}</send_user_message_question_reply>`
  const fixture = mount(text)
  expect(fixture.host.querySelector('[aria-label="Edit in a new session"]')).toBeNull()
  expect(fixture.host.textContent).toContain("Which method?: A")
  expect(fixture.host.textContent).not.toContain("send_user_message_question_reply")
})
