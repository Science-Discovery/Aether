import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import type { ComponentProps } from "solid-js"
import { render } from "solid-js/web"
import { redo, undo, undoDepth } from "@codemirror/commands"
import { foldCode, foldedRanges, language, syntaxTree } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { CodeEditor } from "./code-editor"
import type { WritingStyle } from "./code-editor-latex-theme"
import { assistance } from "./code-editor-latex-decorations"
import { modern } from "./code-editor-latex-modern"

let host: HTMLDivElement
let dispose: VoidFunction | undefined

function mount(
  filename = "draft.tex",
  content = "\\begin{equation}\nx = y + z\n\\end{equation}\n\n中文正文。",
  opts: Pick<ComponentProps<typeof CodeEditor>, "onCursor" | "onLocate"> = {},
) {
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
        onCursor={opts.onCursor}
        onLocate={opts.onLocate}
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

function keyboard(opts: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...opts })
  const modifier = event.getModifierState.bind(event)
  // Happy DOM aliases AltGraph to Alt, unlike real browser keyboard events.
  vi.spyOn(event, "getModifierState").mockImplementation((key) =>
    key === "AltGraph" ? !!opts.modifierAltGraph : modifier(key),
  )
  return event
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
  expect(editor.view.state.facet(language)).toBe(modern)
  expect(foldedRanges(editor.view.state)).toBe(folds)
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
    typeface: "aether",
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
  editor.set("appearance", { size: 17, spacing: "wide", preset, dark, typeface: "aether" })
  const css = styles(editor.view)
  expect(css).toContain(`background-color: ${background};`)
  expect(css).toContain("font-size: 17px;")
  expect(css).toContain("line-height: 1.9;")
  expect(css).toContain('font-family: "Fira Code", "Microsoft YaHei"')
  expect(editor.changes).toEqual([])
})

test("classic monospace works in both styles and font changes retain the syntax tree", () => {
  const editor = mount()
  expect(styles(editor.view)).toContain('font-family: Consolas, Menlo, Monaco, "Liberation Mono"')
  editor.set("appearance", { preset: "vscode" })
  const tree = syntaxTree(editor.view.state)
  const doc = editor.view.state.doc
  expect(styles(editor.view)).toContain('font-family: Consolas, Menlo, Monaco, "Liberation Mono"')
  expect(styles(editor.view)).toContain("font-size: 14px;")
  expect(styles(editor.view)).toContain("line-height: 1.7;")
  expect(editor.view.state.facet(language)).toBe(modern)

  editor.set("appearance", { typeface: "aether", dark: false, size: 18, spacing: "wide" })
  expect(styles(editor.view)).toContain('font-family: "Fira Code", "Microsoft YaHei"')
  expect(syntaxTree(editor.view.state)).toBe(tree)
  editor.set("appearance", { typeface: "vscode", guides: false, brackets: false })
  expect(syntaxTree(editor.view.state)).toBe(tree)
  editor.set("appearance", { preset: "paper" })
  expect(styles(editor.view)).toContain('font-family: Consolas, Menlo, Monaco, "Liberation Mono"')
  const paper = syntaxTree(editor.view.state)
  editor.set("appearance", { typeface: "aether" })
  expect(styles(editor.view)).toContain('font-family: "Fira Code", "Microsoft YaHei"')
  expect(syntaxTree(editor.view.state)).toBe(paper)
  expect(editor.view.state.facet(language)).not.toBe(modern)
  expect(editor.view.state.doc).toBe(doc)
  expect(editor.changes).toEqual([])
})

test("VS Code command scopes replace the old one-color highlighting without changing headings", () => {
  const editor = mount(
    "main.tex",
    String.raw`\documentclass{article}
\usepackage{ctex}
\section{中文}
\textbf{强调}
$x = \alpha + 2$`,
  )
  editor.set("appearance", { preset: "vscode", brackets: false })
  const css = styles(editor.view)
  const spans = Array.from(editor.dom.querySelectorAll(".cm-line span"))
  const token = (text: string) => spans.find((node) => node.textContent === text)?.className
  expect(token("\\documentclass")).toBeTruthy()
  expect(token("\\documentclass")).toBe(token("\\usepackage"))
  expect(token("\\documentclass")).not.toBe(token("\\section"))
  expect(token("article")).toBeTruthy()
  expect(token("article")).toBe(token("ctex"))
  expect(css).toContain("color: var(--latex-strong); font-weight: bold;")
  expect(css).toContain(".cm-latex-heading {font-weight: 400;}")
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

test("reports the initial LaTeX cursor and subsequent selections and edits using one-based positions", () => {
  const cursor = vi.fn()
  const editor = mount("main.tex", "first\n中文正文", { onCursor: cursor })
  expect(cursor).toHaveBeenLastCalledWith({ line: 1, column: 1 })
  editor.view.dispatch({ selection: { anchor: 8 } })
  expect(cursor).toHaveBeenLastCalledWith({ line: 2, column: 3 })
  editor.view.dispatch({ changes: { from: 8, insert: "新" }, selection: { anchor: 9 } })
  expect(cursor).toHaveBeenLastCalledWith({ line: 2, column: 4 })
  const count = cursor.mock.calls.length
  editor.set("appearance", { dark: false, size: 18 })
  expect(cursor).toHaveBeenCalledTimes(count)
  expect(EditorView.findFromDOM(editor.dom)).toBe(editor.view)
})

test("physical Ctrl+Alt+J locates the current LaTeX cursor without changing the document or save shortcut", () => {
  const cursor = vi.fn()
  const locate = vi.fn()
  const editor = mount("main.tex", "中文正文", { onCursor: cursor, onLocate: locate })
  editor.view.focus()
  editor.view.dispatch({ selection: { anchor: 2 } })
  const doc = editor.view.state.doc
  const event = keyboard({ key: "j", ctrlKey: true, altKey: true })
  editor.view.contentDOM.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(locate).toHaveBeenCalledTimes(1)
  expect(cursor).toHaveBeenLastCalledWith({ line: 1, column: 3 })
  expect(editor.view.state.doc).toBe(doc)
  expect(editor.view.state.selection.main.head).toBe(2)

  const option = keyboard({
    key: "∆",
    code: "KeyJ",
    ctrlKey: true,
    altKey: true,
  })
  editor.view.contentDOM.dispatchEvent(option)
  expect(option.defaultPrevented).toBe(true)
  expect(locate).toHaveBeenCalledTimes(2)

  const save = keyboard({ key: "s", ctrlKey: true })
  editor.view.contentDOM.dispatchEvent(save)
  expect(save.defaultPrevented).toBe(false)
  expect(locate).toHaveBeenCalledTimes(2)
})

test("location shortcuts ignore composition, AltGraph and Command+Option", () => {
  const locate = vi.fn()
  const editor = mount("main.tex", "中文正文", { onLocate: locate })
  editor.view.focus()
  for (const opts of [{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { shiftKey: true }]) {
    editor.view.contentDOM.dispatchEvent(keyboard({ key: "j", ctrlKey: true, altKey: true, ...opts }))
  }
  const event = keyboard({ key: "j", ctrlKey: true, altKey: true, modifierAltGraph: true })
  editor.view.contentDOM.dispatchEvent(event)
  expect(locate).not.toHaveBeenCalled()
  expect(event.defaultPrevented).toBe(false)
  expect(editor.changes).toEqual([])
})

test("ordinary code does not report a LaTeX cursor or capture its navigation shortcut", () => {
  const cursor = vi.fn()
  const locate = vi.fn()
  const editor = mount("module.ts", "const n = 1", { onCursor: cursor, onLocate: locate })
  editor.view.focus()
  editor.view.dispatch({ selection: { anchor: 5 } })
  const event = keyboard({ key: "j", ctrlKey: true, altKey: true })
  editor.view.contentDOM.dispatchEvent(event)
  expect(cursor).not.toHaveBeenCalled()
  expect(locate).not.toHaveBeenCalled()
  expect(event.defaultPrevented).toBe(false)
})
