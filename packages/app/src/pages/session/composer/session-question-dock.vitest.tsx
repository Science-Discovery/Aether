import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { SessionQuestionDock } from "./session-question-dock"

const mocks = vi.hoisted(() => ({ reply: vi.fn().mockResolvedValue({ data: true }) }))

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/context/sdk", () => ({ useSDK: () => ({ client: { question: { reply: mocks.reply } } }) }))

let dispose: VoidFunction

beforeEach(() => {
  mocks.reply.mockClear()
})
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

function mount(custom?: boolean) {
  const client = new QueryClient()
  const host = document.createElement("div")
  document.body.append(host)
  const id = crypto.randomUUID()
  const off = render(
    () => (
      <QueryClientProvider client={client}>
        <SessionQuestionDock
          request={{
            id,
            sessionID: "native",
            questions: [
              {
                header: "Codex approval",
                question: "Review the proposed change.\n-Old result\n+Verified result",
                custom,
                options: [
                  { label: "Allow once", description: "Allow this action" },
                  { label: "Decline", description: "Reject this action" },
                ],
              },
            ],
          }}
          onSubmit={() => undefined}
          collapseLabel="Collapse"
          expandLabel="Expand"
        />
      </QueryClientProvider>
    ),
    host,
  )
  dispose = () => {
    off()
    client.clear()
  }
  return { host, id }
}

describe("question custom answers", () => {
  test("honors native decisions that disable custom answers", async () => {
    const { host, id } = mount(false)
    expect(host.querySelector('[data-custom="true"]')).toBeNull()
    expect(host.querySelector('[data-slot="question-text"]')?.textContent).toContain("-Old result\n+Verified result")
    host.querySelectorAll<HTMLButtonElement>('[data-slot="question-option"]')[1]!.click()
    host.querySelector<HTMLButtonElement>('[data-slot="question-footer-actions"] button')!.click()
    await vi.waitFor(() => expect(mocks.reply).toHaveBeenCalledWith({ requestID: id, answers: [["Decline"]] }))
  })

  test("keeps custom answers enabled by default for existing questions", async () => {
    const { host, id } = mount()
    host.querySelector<HTMLButtonElement>('[data-custom="true"]')!.click()
    const input = host.querySelector<HTMLTextAreaElement>('[data-slot="question-custom-input"]')!
    input.value = "Use another source"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    host.querySelector<HTMLButtonElement>('[data-slot="question-footer-actions"] button')!.click()
    await vi.waitFor(() =>
      expect(mocks.reply).toHaveBeenCalledWith({ requestID: id, answers: [["Use another source"]] }),
    )
  })
})
