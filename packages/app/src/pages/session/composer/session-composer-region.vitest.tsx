import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"
import { updateReference, type Reference } from "@/utils/ask-reference"
import { SessionComposerRegion } from "./session-composer-region"

const state = vi.hoisted(() => ({ model: undefined as ReturnType<typeof model> | undefined }))

vi.mock("@/context/prompt", () => ({ usePrompt: () => state.model!.prompt }))
vi.mock("@/context/file-quote", () => ({ useMaybeFileQuote: () => undefined }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string, values?: { number: number }) => (values ? `${key} ${values.number}` : key) }),
}))
vi.mock("@/pages/session/session-layout", () => ({
  useSessionKey: () => ({ params: state.model!.route, sessionKey: () => state.model!.route.id }),
}))
vi.mock("@/pages/session/handoff", () => ({ getSessionHandoff: () => undefined, setSessionHandoff: () => {} }))
vi.mock("@opencode-ai/ui/motion-spring", () => ({ useSpring: () => () => 0 }))
vi.mock("@opencode-ai/ui/icon", () => ({ Icon: () => null }))
vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}))
vi.mock("@/components/prompt-input", () => ({ PromptInput: () => <div data-component="prompt-input" /> }))
vi.mock("@/pages/session/composer/session-followup-dock", () => ({ SessionFollowupDock: () => null }))
vi.mock("@/pages/session/composer/session-permission-dock", () => ({ SessionPermissionDock: () => null }))
vi.mock("@/pages/session/composer/session-question-dock", () => ({ SessionQuestionDock: () => null }))
vi.mock("@/pages/session/composer/session-revert-dock", () => ({ SessionRevertDock: () => null }))
vi.mock("@/pages/session/composer/session-todo-dock", () => ({ SessionTodoDock: () => null }))

const cleanups: Array<() => void> = []

function model() {
  const [route, session] = createStore({ id: "first" })
  const [draft, set] = createStore<{ references: Reference[] }>({ references: [] })
  return {
    route,
    session,
    draft,
    set,
    prompt: {
      ready: () => true,
      current: () => [],
      references: {
        items: () => draft.references.map((ref) => ({ ...ref })),
        update: (id: string, question: string) => set("references", (refs) => updateReference(refs, id, question)),
        remove: (id: string) => set("references", (refs) => refs.filter((ref) => ref.id !== id)),
      },
    },
  }
}

function conversation(id: string): Reference {
  return {
    id,
    version: 1,
    kind: "conversation",
    messageID: "message",
    start: 0,
    end: 8,
    summary: `Summary ${id}`,
    text: `Full text ${id}`,
    question: `Question ${id}`,
  }
}

function pdf(id: string): Reference {
  return {
    id,
    version: 1,
    kind: "pdf",
    path: "paper.pdf",
    filename: "paper.pdf",
    mode: "quick",
    startPage: 2,
    endPage: 3,
    selection: "region",
    content: "image",
    summary: "Captured region",
    text: "Image text",
    question: "What does the chart show?",
    settings: { questionPrompt: "" },
  }
}

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <SessionComposerRegion
        ready
        centered={false}
        inputRef={() => {}}
        newSessionWorktree=""
        onNewSessionWorktreeReset={() => {}}
        onSubmit={() => {}}
        onResponseSubmit={() => {}}
        setPromptDockRef={() => {}}
        state={{
          blocked: () => false,
          questionRequest: () => undefined,
          permissionRequest: () => undefined,
          permissionResponding: () => false,
          decide: () => {},
          todos: () => [],
          dock: () => false,
          closing: () => false,
          opening: () => false,
        }}
      />
    ),
    host,
  )
  cleanups.push(() => {
    off()
    host.remove()
  })
  return host
}

function click(host: ParentNode, label: string) {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.getAttribute("aria-label") === label || button.textContent === label,
  )
  expect(button, label).toBeTruthy()
  button!.click()
}

beforeEach(() => {
  state.model = model()
})
afterEach(() => {
  cleanups.splice(0).forEach((off) => off())
})

describe("pending Ask references", () => {
  test("keeps mixed insertion order, expands text, flags missing images and renumbers after deletion", () => {
    state.model!.set("references", [conversation("one"), pdf("two"), conversation("three")])
    const host = mount()
    const cards = () => Array.from(host.querySelectorAll<HTMLElement>("[data-reference-id]"))
    expect(cards().map((card) => card.dataset.referenceId)).toEqual(["one", "two", "three"])
    expect(cards()[1].textContent).toContain("ask.reference.title 2")
    expect(cards()[1].textContent).toContain("ask.reference.missingImage")
    expect(host.querySelector("[data-component='ask-reference-list']")?.classList.contains("overflow-y-auto")).toBe(
      true,
    )
    click(cards()[0], "ask.reference.expand")
    expect(cards()[0].textContent).toContain("Full text one")
    click(cards()[0], "common.delete")
    expect(cards().map((card) => card.dataset.referenceId)).toEqual(["two", "three"])
    expect(cards()[0].textContent).toContain("ask.reference.title 1")
    expect(host.querySelector("[data-component='ask-reference-list']")?.classList.contains("overflow-y-auto")).toBe(
      false,
    )
  })

  test("edits in a local draft, cancel preserves the question and save updates only that reference", () => {
    state.model!.set("references", [conversation("one"), pdf("two")])
    const host = mount()
    click(host.querySelector("[data-reference-id='one']")!, "common.edit")
    const input = document.querySelector<HTMLTextAreaElement>("[data-component='ask-editor'] textarea")!
    expect(input.value).toBe("Question one")
    input.value = "Unsaved"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    state.model!.prompt.references.update("two", "Other change")
    expect(document.querySelector("[data-component='ask-editor'] textarea")).toBe(input)
    expect(input.value).toBe("Unsaved")
    click(document.querySelector("[data-component='ask-editor']")!, "common.cancel")
    expect(state.model!.draft.references[0].question).toBe("Question one")
    click(host.querySelector("[data-reference-id='one']")!, "common.edit")
    const next = document.querySelector<HTMLTextAreaElement>("[data-component='ask-editor'] textarea")!
    next.value = "Saved question"
    next.dispatchEvent(new Event("input", { bubbles: true }))
    document
      .querySelector("[data-component='ask-editor']")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(state.model!.draft.references.map((ref) => ref.question)).toEqual(["Saved question", "Other change"])
    expect(document.querySelector("[data-component='ask-editor']")).toBeNull()
  })

  test("closes an unsaved editor when switching sessions", () => {
    state.model!.set("references", [conversation("one")])
    const host = mount()
    click(host.querySelector("[data-reference-id='one']")!, "common.edit")
    state.model!.session("id", "second")
    expect(document.querySelector("[data-component='ask-editor']")).toBeNull()
    expect(state.model!.draft.references[0].question).toBe("Question one")
  })
})
