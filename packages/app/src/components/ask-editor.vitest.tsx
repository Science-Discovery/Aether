import { afterEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { AskEditor } from "./ask-editor"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((off) => off()))

function mount(question = "") {
  const save = vi.fn()
  const cancel = vi.fn()
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <AskEditor
        title="Selection question"
        preview="A selected passage"
        question={question}
        anchor={{ top: 20, left: 30, bottom: 50, right: 100 }}
        onSave={save}
        onCancel={cancel}
      />
    ),
    host,
  )
  cleanups.push(() => {
    off()
    host.remove()
  })
  const form = document.querySelector<HTMLFormElement>('[data-component="ask-editor"]')!
  const input = form.querySelector("textarea")!
  return { form, input, save, cancel }
}

describe("selection question editor", () => {
  test("keeps each draft local and saves only on confirmation", () => {
    const editor = mount("Existing question")
    expect(editor.input.value).toBe("Existing question")
    editor.input.value = "  New question  "
    editor.input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(editor.save).not.toHaveBeenCalled()
    editor.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(editor.save).toHaveBeenCalledWith("New question")
    expect(editor.cancel).not.toHaveBeenCalled()
  })

  test("Escape cancels without saving and IME Enter does not submit", () => {
    const editor = mount()
    editor.input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
    editor.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))
    editor.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(editor.save).not.toHaveBeenCalled()
    expect(editor.cancel).not.toHaveBeenCalled()
    editor.input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
    editor.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(editor.cancel).toHaveBeenCalledOnce()
    expect(editor.save).not.toHaveBeenCalled()
  })

  test("supports Ctrl/Cmd Enter and permits references for an overall question", () => {
    const editor = mount()
    editor.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }))
    expect(editor.save).toHaveBeenCalledWith("")
  })
})
