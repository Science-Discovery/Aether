import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { codeFolding, foldCode, indentUnit, unfoldCode } from "@codemirror/language"
import { Compartment, EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { assistance, extensions } from "./code-editor-latex-decorations"
import { structure } from "./code-editor-latex-structure"

let view: EditorView
let host: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement("div")
  document.body.append(host)
})

afterEach(() => {
  view?.destroy()
  host.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
})

test("guides decorate only existing leading whitespace and skip blank lines and prose", () => {
  const doc = "  first\n\tsecond\n \t mixed\n    \nno indentation\n  a long line of 中文正文 and words that may wrap"
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        extensions("main.tex"),
        assistance.of({ guides: true, brackets: true }),
        EditorState.tabSize.of(4),
        indentUnit.of("  "),
        EditorView.lineWrapping,
      ],
    }),
  })
  const marks = Array.from(host.querySelectorAll<HTMLElement>(".cm-latex-indent"))
  expect(marks).toHaveLength(4)
  marks.forEach((mark) => {
    expect(mark.textContent).toMatch(/^\s+$/)
    expect(mark.style.backgroundSize).toBe("2ch 100%")
    expect(mark.style.backgroundImage).toContain("var(--latex-guide)")
  })
  expect(host.querySelector(".cm-lineWrapping")).not.toBeNull()
  expect(view.state.doc.toString()).toBe(doc)
})

test("mixed tab indentation follows the editor tab size without changing the source", () => {
  const config = new Compartment()
  const doc = "  spaces\n\ttab\n \t mixed\n        spaces"
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        extensions("main.tex"),
        assistance.of({ guides: true, brackets: false }),
        config.of(EditorState.tabSize.of(4)),
        indentUnit.of("\t"),
      ],
    }),
  })
  expect(host.querySelectorAll(".cm-latex-indent")).toHaveLength(3)
  expect(host.querySelector<HTMLElement>(".cm-latex-indent")!.style.backgroundSize).toBe("4ch 100%")
  view.dispatch({ effects: config.reconfigure(EditorState.tabSize.of(8)) })
  expect(host.querySelectorAll(".cm-latex-indent")).toHaveLength(3)
  expect(host.querySelector<HTMLElement>(".cm-latex-indent")!.style.backgroundSize).toBe("8ch 100%")
  expect(view.state.doc.toString()).toBe(doc)
})

test("folded content has no displayed guides and reappears when unfolded", () => {
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: "\\section{First}\n  {hidden}\n\\section{Next}\n  {shown}",
      extensions: [
        extensions("main.tex"),
        assistance.of({ guides: true, brackets: true }),
        structure("main.tex"),
        codeFolding(),
      ],
    }),
  })
  expect(host.querySelectorAll(".cm-latex-indent")).toHaveLength(2)
  expect(foldCode(view)).toBe(true)
  expect(host.querySelectorAll(".cm-latex-indent")).toHaveLength(1)
  expect(host.querySelector(".cm-foldPlaceholder")).not.toBeNull()
  expect(host.textContent).not.toContain("hidden")
  expect(host.textContent).toContain("shown")
  expect(unfoldCode(view)).toBe(true)
  expect(host.querySelectorAll(".cm-latex-indent")).toHaveLength(2)
  expect(host.textContent).toContain("hidden")
})
