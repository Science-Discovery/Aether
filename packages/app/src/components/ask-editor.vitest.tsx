import { afterEach, describe, expect, test, vi } from "vitest"
import { render } from "solid-js/web"
import { AskEditor, type AskEditorProps } from "./ask-editor"

vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
const cleanups: Array<() => void> = []
const viewport = { width: window.innerWidth, height: window.innerHeight }
afterEach(() => {
  cleanups.splice(0).forEach((off) => off())
  Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport.width })
  Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport.height })
  vi.restoreAllMocks()
})

function mount(question = "", options: Partial<AskEditorProps> = {}) {
  const save = vi.fn(options.onSave)
  const cancel = vi.fn(options.onCancel)
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <AskEditor
        title="Selection question"
        preview="A selected passage"
        question={question}
        anchor={{ top: 20, left: 30, bottom: 50, right: 100 }}
        {...options}
        onSave={save}
        onCancel={cancel}
      />
    ),
    host,
  )
  const remove = () => {
    off()
    host.remove()
  }
  cleanups.push(remove)
  const form = Array.from(document.querySelectorAll<HTMLFormElement>('[data-component="ask-editor"]')).at(-1)!
  const input = form.querySelector("textarea")!
  return { form, input, save, cancel, remove }
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

  test("shows only a single-line input and accessible icon controls", () => {
    const editor = mount("", { image: "data:image/png;base64,unused", editing: true })
    expect(editor.form.getAttribute("aria-label")).toBe("Selection question")
    expect(editor.form.textContent).not.toContain("Selection question")
    expect(editor.form.textContent).not.toContain("A selected passage")
    expect(editor.form.querySelector("img")).toBeNull()
    expect(Number(editor.input.rows)).toBe(1)
    expect(editor.form.querySelectorAll("button")).toHaveLength(2)
    expect(editor.form.querySelector('[aria-label="ask.editor.update"]')).toBeTruthy()
    expect(editor.form.querySelector('[aria-label="common.cancel"]')).toBeTruthy()
    expect(document.activeElement).toBe(editor.input)
  })

  test("plain Enter remains a newline and close discards the draft without changing the saved question", () => {
    const editor = mount("Saved question")
    editor.input.value = "Draft\nsecond line"
    editor.input.dispatchEvent(new Event("input", { bubbles: true }))
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    editor.input.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(editor.save).not.toHaveBeenCalled()
    editor.form.querySelector<HTMLButtonElement>('[aria-label="common.cancel"]')!.click()
    expect(editor.cancel).toHaveBeenCalledOnce()
    expect(editor.save).not.toHaveBeenCalled()
    expect(document.querySelector('[data-component="ask-editor"]')).toBeNull()
  })

  test("ignores native IME keyboard signals and composition-time submit", () => {
    const editor = mount()
    editor.input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true }),
    )
    editor.input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, keyCode: 229, bubbles: true }),
    )
    editor.input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
    editor.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(editor.save).not.toHaveBeenCalled()
    editor.input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
    editor.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))
    expect(editor.save).toHaveBeenCalledExactlyOnceWith("")
  })

  test("grows up to four lines, scrolls longer drafts, and shrinks again", () => {
    const editor = mount()
    editor.input.style.lineHeight = "20px"
    editor.input.style.paddingTop = "4px"
    editor.input.style.paddingBottom = "4px"
    const content = { height: 28 }
    Object.defineProperty(editor.input, "scrollHeight", { configurable: true, get: () => content.height })
    editor.input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(editor.input.style.height).toBe("28px")
    content.height = 68
    editor.input.value = "one\ntwo\nthree"
    editor.input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(editor.input.style.height).toBe("68px")
    expect(editor.input.style.overflowY).toBe("hidden")
    content.height = 148
    editor.input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(editor.input.style.height).toBe("88px")
    expect(editor.input.style.overflowY).toBe("auto")
    content.height = 28
    editor.input.value = "one"
    editor.input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(editor.input.style.height).toBe("28px")
    expect(editor.input.style.overflowY).toBe("hidden")
    content.height = 128
    editor.input.value = ""
    editor.input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(editor.input.style.height).toBe("28px")
    expect(editor.input.style.overflowY).toBe("hidden")
  })

  test("keeps the bar above lower selections and inside narrow viewport edges", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 })
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 240 })
    const editor = mount("", { anchor: { top: 215, bottom: 235, left: 342, right: 355 } })
    const rect = vi.spyOn(editor.form, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 44))
    window.dispatchEvent(new Event("resize"))
    expect(editor.form.style.top).toBe("163px")
    expect(editor.form.style.left).toBe("32px")
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 220 })
    rect.mockReturnValue(new DOMRect(0, 0, 204, 104))
    window.dispatchEvent(new Event("resize"))
    expect(editor.form.style.top).toBe("103px")
    expect(editor.form.style.left).toBe("8px")
  })

  test("replaces another source's editor by cancelling it and ignores its later cleanup", () => {
    const first = mount("Unsaved PDF question", { title: "PDF selection" })
    const second = mount("Conversation question", { title: "Conversation selection" })
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(first.save).not.toHaveBeenCalled()
    expect(first.form.isConnected).toBe(false)
    expect(document.querySelectorAll('[data-component="ask-editor"]')).toHaveLength(1)
    first.remove()
    first.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(first.save).not.toHaveBeenCalled()
    expect(second.cancel).not.toHaveBeenCalled()
    const third = mount("Editing a saved reference", { title: "Reference list", editing: true })
    expect(second.cancel).toHaveBeenCalledOnce()
    expect(second.save).not.toHaveBeenCalled()
    expect(third.input.value).toBe("Editing a saved reference")
    expect(document.activeElement).toBe(third.input)
    expect(document.querySelectorAll('[data-component="ask-editor"]')).toHaveLength(1)
  })

  test("does not reclaim ownership when the replaced owner's cancel callback opens a newer editor", () => {
    const replacement = { editor: undefined as ReturnType<typeof mount> | undefined }
    const first = mount("First", {
      onCancel: () => {
        replacement.editor = mount("Newest")
      },
    })
    const second = mount("Intermediate")
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(second.cancel).toHaveBeenCalledOnce()
    expect(second.save).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLTextAreaElement>('[data-component="ask-editor"] textarea')?.value).toBe("Newest")
    expect(document.querySelectorAll('[data-component="ask-editor"]')).toHaveLength(1)
    first.remove()
    second.remove()
    const next = mount("Next")
    expect(replacement.editor?.cancel).toHaveBeenCalledOnce()
    expect(next.cancel).not.toHaveBeenCalled()
  })
})
