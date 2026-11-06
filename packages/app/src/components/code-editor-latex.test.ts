import { expect, test } from "bun:test"
import { EditorState } from "@codemirror/state"
import { ensureSyntaxTree } from "@codemirror/language"
import { latex } from "./code-editor-latex"

test("TeX and BibTeX use actual syntax trees, including nested bibliography values", () => {
  for (const [filename, content] of [
    ["main.tex", "\\documentclass{article}\n% comment\n\\begin{document}Hello $x^2$\\end{document}"],
    ["refs.bib", '@article{key, title = {Nested {TeX} value}, year = 2026, author = "A \\"name\\""}\n% comment'],
  ]) {
    const state = EditorState.create({ doc: content, extensions: [latex(filename)!] })
    const tree = ensureSyntaxTree(state, state.doc.length, 100)
    expect(tree).not.toBeNull()
    expect(tree!.length).toBe(content.length)
    expect(tree!.topNode.firstChild).not.toBeNull()
  }
  expect(latex("notes.txt")).toBeUndefined()
})
