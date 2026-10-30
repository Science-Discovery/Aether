import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { redo, undo, undoDepth } from "@codemirror/commands"
import { foldCode, foldedRanges } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { CodeEditor } from "./code-editor"
import type { WritingStyle } from "./code-editor-latex-theme"
import { assistance } from "./code-editor-latex-decorations"

let host: HTMLDivElement
let dispose: VoidFunction | undefined

function mount(filename = "draft.tex", content = "\\begin{equation}\nx = y + z\n\\end{equation}\n\n中文正文。") {
  const [state, set] = createStore({
    content,
    appearance: { dark: true, size: 14, spacing: "normal", font: '"Fira Code", monospace' } as WritingStyle,
  })
  const changes: string[] = []
  dispose = render(
    () => (
      <CodeEditor
        filename={filename}
        content={state.content}
        appearance={state.appearance}
        onChange={(value) => {
          changes.push(value)
          set("content", value)
        }}
      />
    ),
    host,
  )
  const dom = host.querySelector<HTMLElement>(".cm-editor")!
  const view = EditorView.findFromDOM(dom)!
  return { view, dom, state, set, changes }
}

function styles(view: EditorView) {
  return view.state
    .facet(EditorView.styleModule)
    .map((module) => module.getRules())
    .join("\n")
}

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement("div")
  document.body.append(host)
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  host.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
})

test.each(["tex", "ltx", "sty", "cls", "bib", "bst"])("enables the writing appearance for .%s files", (ext) => {
  const editor = mount(`draft.${ext.toUpperCase()}`)
  expect(host.querySelector('[data-component="code-editor"]')?.getAttribute("data-latex")).toBe("true")
  expect(editor.view.state.facet(EditorView.darkTheme)).toBe(true)
  expect(styles(editor.view)).toContain("--latex-command:")
  expect(editor.view.dom.querySelector(".cm-selectionLayer")).not.toBeNull()
  expect(editor.view.dom.querySelector(".cm-cursorLayer")).not.toBeNull()
})

test("appearance changes preserve the editor, document, selection, folds, and undo history", () => {
  const editor = mount()
  const original = editor.state.content
  expect(foldCode(editor.view)).toBe(true)
  const end = editor.view.state.doc.length
  editor.view.dispatch({
    changes: { from: end, insert: "\n新增中文说明。" },
    selection: { anchor: end + 1, head: end + 7 },
    userEvent: "input.type",
  })
  const doc = editor.view.state.doc
  const selection = editor.view.state.selection
  const folds = foldedRanges(editor.view.state)
  expect(folds.size).toBe(1)
  expect(undoDepth(editor.view.state)).toBe(1)
  expect(editor.changes).toEqual([doc.toString()])

  editor.set("appearance", {
    preset: "vscode",
    dark: false,
    size: 18,
    spacing: "wide",
    font: '"JetBrains Mono", monospace',
  })

  expect(editor.view.state.facet(assistance)).toEqual({ guides: true, brackets: true })
  editor.set("appearance", { guides: false, brackets: false })
  expect(editor.view.state.facet(assistance)).toEqual({ guides: false, brackets: false })
  editor.set("appearance", { preset: "paper" })

  expect(host.querySelector(".cm-editor")).toBe(editor.dom)
  expect(EditorView.findFromDOM(editor.dom)).toBe(editor.view)
  expect(editor.view.state.doc).toBe(doc)
  expect(editor.view.state.selection.eq(selection)).toBe(true)
  expect(foldedRanges(editor.view.state)).toBe(folds)
  expect(editor.view.dom.querySelectorAll(".cm-foldPlaceholder")).toHaveLength(1)
  expect(undoDepth(editor.view.state)).toBe(1)
  expect(editor.changes).toEqual([doc.toString()])
  expect(editor.view.state.facet(EditorView.darkTheme)).toBe(false)
  expect(undo(editor.view)).toBe(true)
  expect(editor.view.state.doc.toString()).toBe(original)
  expect(redo(editor.view)).toBe(true)
  expect(editor.view.state.doc.toString()).toBe(doc.toString())
})

test("updates font size, spacing, palette, and CJK fallbacks on the current editor", () => {
  const editor = mount()
  expect(styles(editor.view)).toContain("font-size: 14px;")
  expect(styles(editor.view)).toContain("line-height: 1.7;")
  expect(styles(editor.view)).toContain("color-scheme: dark;")

  editor.set("appearance", {
    dark: false,
    size: 18,
    spacing: "wide",
    font: 'ui-monospace, "JetBrains Mono", monospace',
  })
  expect(styles(editor.view)).toContain("font-size: 18px;")
  expect(styles(editor.view)).toContain("line-height: 1.9;")
  expect(styles(editor.view)).toContain("color-scheme: light;")
  expect(styles(editor.view)).toContain(
    'font-family: "JetBrains Mono", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace;',
  )

  editor.set("appearance", { dark: true, size: 12, spacing: "compact" })
  expect(styles(editor.view)).toContain("font-size: 12px;")
  expect(styles(editor.view)).toContain("line-height: 1.5;")
  expect(styles(editor.view)).toContain("color-scheme: dark;")
  expect(styles(editor.view)).not.toContain("font-size: 18px;")
  expect(editor.view.state.facet(EditorView.darkTheme)).toBe(true)
  expect(EditorView.findFromDOM(editor.dom)).toBe(editor.view)
})

test("keeps bracket matching and drawn selections enabled after appearance changes", () => {
  const editor = mount("draft.tex", "{中文}")
  editor.view.dispatch({ selection: { anchor: 1 } })
  expect(Array.from(editor.view.dom.querySelectorAll(".cm-matchingBracket"), (node) => node.textContent)).toEqual([
    "{",
    "}",
  ])

  editor.set("appearance", { dark: false, size: 16 })
  expect(editor.view.dom.querySelectorAll(".cm-matchingBracket")).toHaveLength(2)
  expect(editor.view.dom.querySelector(".cm-selectionLayer")).not.toBeNull()
  expect(editor.view.dom.querySelector(".cm-cursorLayer")).not.toBeNull()
})

test("ordinary source files keep their existing appearance when writing preferences change", () => {
  const editor = mount("module.ts", "const value = 1")
  const state = editor.view.state
  const css = styles(editor.view)
  expect(host.querySelector('[data-component="code-editor"]')?.hasAttribute("data-latex")).toBe(false)
  expect(css).not.toContain("--latex-command:")
  expect(editor.view.dom.querySelector(".cm-selectionLayer")).toBeNull()

  editor.set("appearance", { preset: "vscode", dark: false, size: 20, spacing: "wide", font: "Consolas, monospace" })

  expect(EditorView.findFromDOM(editor.dom)).toBe(editor.view)
  expect(editor.view.state).toBe(state)
  expect(styles(editor.view)).toBe(css)
  expect(editor.changes).toEqual([])
})

test.each([
  ["paper", true, "#20252b"],
  ["paper", false, "#fafbf9"],
  ["vscode", true, "#1f1f1f"],
  ["vscode", false, "#ffffff"],
] as const)("uses the %s palette (dark: %s) without replacing typography", (preset, dark, background) => {
  const editor = mount()
  editor.set("appearance", { size: 17, spacing: "wide", preset, dark })
  const css = styles(editor.view)
  expect(css).toContain(`background-color: ${background};`)
  expect(css).toContain("font-size: 17px;")
  expect(css).toContain("line-height: 1.9;")
  expect(css).toContain('font-family: "Fira Code", "Microsoft YaHei"')
  expect(editor.changes).toEqual([])
})

test("VS Code assists toggle immediately and retain bracket matching", () => {
  const editor = mount("main.tex", "{中文 [x + (y)]}\n    indented")
  const text = editor.view.state.doc
  expect(editor.dom.querySelector(".cm-latex-bracket-0")).toBeNull()
  expect(editor.dom.querySelector(".cm-latex-indent")).toBeNull()
  editor.set("appearance", { preset: "vscode" })
  expect(editor.dom.querySelectorAll(".cm-latex-bracket-0")).toHaveLength(2)
  expect(editor.dom.querySelectorAll(".cm-latex-bracket-1")).toHaveLength(2)
  expect(editor.dom.querySelectorAll(".cm-latex-bracket-2")).toHaveLength(2)
  expect(editor.dom.querySelector(".cm-latex-indent")).not.toBeNull()

  editor.view.dispatch({ selection: { anchor: 1 } })
  expect(editor.dom.querySelectorAll(".cm-matchingBracket")).toHaveLength(2)
  editor.set("appearance", { brackets: false })
  expect(editor.dom.querySelector(".cm-latex-bracket-0")).toBeNull()
  expect(editor.dom.querySelector(".cm-latex-indent")).not.toBeNull()
  expect(editor.dom.querySelectorAll(".cm-matchingBracket")).toHaveLength(2)
  editor.set("appearance", { guides: false })
  expect(editor.dom.querySelector(".cm-latex-indent")).toBeNull()
  editor.set("appearance", { guides: true, brackets: true, preset: "paper" })
  expect(editor.dom.querySelector(".cm-latex-bracket-0")).toBeNull()
  expect(editor.dom.querySelector(".cm-latex-indent")).toBeNull()
  expect(editor.view.state.doc).toBe(text)
  expect(editor.changes).toEqual([])
})

test("BST files receive guides without TeX bracket decorations", () => {
  const editor = mount("plain.bst", '    FUNCTION {test} { "Hello" }')
  editor.set("appearance", { preset: "vscode" })
  expect(editor.dom.querySelector(".cm-latex-indent")).not.toBeNull()
  expect(editor.dom.querySelector(".cm-latex-bracket-0")).toBeNull()
})
