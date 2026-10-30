import { expect, test } from "bun:test"
import { EditorState } from "@codemirror/state"
import { ensureSyntaxTree } from "@codemirror/language"
import { highlightTree, tagHighlighter } from "@lezer/highlight"
import { latex } from "./code-editor-latex"
import { modern, tokens } from "./code-editor-latex-modern"

const highlighter = tagHighlighter(Object.entries(tokens).map(([name, tag]) => ({ tag, class: name })))

function create(doc: string) {
  return EditorState.create({ doc, extensions: [modern] })
}

function ranges(state: EditorState) {
  const tree = ensureSyntaxTree(state, state.doc.length, 1000)
  expect(tree?.length).toBe(state.doc.length)
  const result: { from: number; to: number; name: string }[] = []
  highlightTree(tree!, highlighter, (from, to, name) => result.push({ from, to, name }))
  return result
}

function color(state: EditorState, text: string, offset = 0) {
  const from = state.doc.toString().indexOf(text) + offset
  expect(from).toBeGreaterThanOrEqual(offset)
  return ranges(state).find((span) => span.from <= from && span.to > from)?.name ?? null
}

test("modern TeX separates preamble, argument, ordinary commands and text styles", () => {
  const state = create(`\\documentclass[11pt]{article}
\\usepackage % keep the pending argument across comments
 [a4paper]{amsmath,graphicx}
\\begin{document}
\\section{普通标题}
正文 \\textbf{粗体 \\emph{嵌套强调} 恢复粗体} 正文之后
{\\bfseries 声明粗体} 作用域之外
\\begin{center}\\bfseries 环境粗体

环境第二段\\end{center} 环境之外
\\textit{斜体} \\cite{reference} \\ref{label}
\\end{document}`)
  expect(color(state, "\\documentclass")).toBe("preamble")
  expect(color(state, "article")).toBe("type")
  expect(color(state, "11pt")).toBe("number")
  expect(color(state, "amsmath")).toBe("type")
  expect(color(state, "graphicx")).toBe("type")
  expect(color(state, "document}")).toBe("type")
  expect(color(state, "\\section")).toBe("command")
  expect(color(state, "普通标题")).toBeNull()
  expect(color(state, "粗体")).toBe("strong")
  expect(color(state, "嵌套强调")).toBe("emphasis")
  expect(color(state, "恢复粗体")).toBe("strong")
  expect(color(state, "正文之后")).toBeNull()
  expect(color(state, "声明粗体")).toBe("strong")
  expect(color(state, "作用域之外")).toBeNull()
  expect(color(state, "环境粗体")).toBe("strong")
  expect(color(state, "环境第二段")).toBe("strong")
  expect(color(state, "环境之外")).toBeNull()
  expect(color(state, "斜体")).toBe("emphasis")
  expect(color(state, "\\cite")).toBe("preamble")
  expect(color(state, "\\ref")).toBe("preamble")
  expect(color(state, "reference}")).toBeNull()
  expect(color(state, "label}")).toBeNull()
})

test("modern math colors body, operators, nested environments, numbers and symbols", () => {
  const state = create(`$x+2=\\frac{a}{b}+\\alpha$ 正文
$$u-3$$ 外面
\\(v+4\\) 普通
\\[w+5\\] afterdisplay
\\begin{align*}
  q &= \\sqrt{r} + \\int_0^1 s \\\\
  \\begin{aligned} t &= \\mathrm{d} + \\text{plain words} \\end{aligned}
  z &= 6
\\end{align*}
结束`)
  for (const text of ["x", "+2", "u-", "v+", "w+", "q", "\\frac", "\\sqrt", "\\mathrm", "z"]) {
    expect(color(state, text)).toBe("math")
  }
  expect(color(state, "2")).toBe("number")
  expect(color(state, "\\alpha")).toBe("symbol")
  expect(color(state, "\\int")).toBe("symbol")
  expect(color(state, "plain words")).toBeNull()
  for (const text of ["正文", "外面", "普通", "afterdisplay", "结束"]) expect(color(state, text)).toBeNull()
})

test("math and text scopes nest inside bold text and display equations", () => {
  const state = create(`\\textbf{before $x+1$ after}
$$z+\\text{plain $y+2$ words}+w$$ outside`)
  expect(color(state, "before")).toBe("strong")
  expect(color(state, "x+1")).toBe("math")
  expect(color(state, "after")).toBe("strong")
  expect(color(state, "plain")).toBeNull()
  expect(color(state, "y+2")).toBe("math")
  expect(color(state, "words")).toBeNull()
  expect(color(state, "+w")).toBe("math")
  expect(color(state, "outside")).toBeNull()
})

test("comments, escaped markers and literal text cannot open math or style scopes", () => {
  const state = create(`\\% \\$ \\{ \\} \\\\ plain
% \\textbf{comment} $fake$
\\verb|\\textbf{verbatim} $x$| normal
\\begin{lstlisting}
\\textbf{literal} $y$
print("\\end{lstlisting}")
\\textbf{still literal}

\\end{lstlisting}
after \\textbf{real}`)
  expect(color(state, "\\%")).toBe("escape")
  expect(color(state, "\\$")).toBe("escape")
  expect(color(state, "plain")).toBeNull()
  expect(color(state, "% \\textbf")).toBe("comment")
  expect(color(state, "verbatim")).toBe("escape")
  expect(color(state, "normal")).toBeNull()
  expect(color(state, "literal")).toBeNull()
  expect(color(state, "$y$")).toBeNull()
  expect(color(state, "still literal")).toBeNull()
  expect(color(state, "after")).toBeNull()
  expect(color(state, "real")).toBe("strong")
})

test("malformed arguments recover at paragraphs and document boundaries", () => {
  const state = create(`\\usepackage{unfinished
\\begin{document}
body
\\textbf{unfinished too

paragraph
$unfinished math
\\section{Boundary}
ordinary
\\usepackage \\unknown{not a package}`)
  for (const text of ["body", "paragraph", "Boundary", "ordinary", "not a package"]) {
    expect(color(state, text)).toBeNull()
  }
})

test("incremental parsing updates styles after edits without mutating cached source states", () => {
  const prefix = Array.from({ length: 150 }, (_, index) => `ordinary line ${index}\n`).join("")
  const state = create(`${prefix}\\textbf{first\nsecond\nthird}\nlast`)
  expect(color(state, "second")).toBe("strong")
  const from = state.doc.toString().indexOf("\\textbf")
  const changed = state.update({ changes: { from, to: from + 7, insert: "\\emph" } }).state
  expect(color(changed, "second")).toBe("emphasis")
  const closed = changed.update({ changes: { from: changed.doc.toString().indexOf("second"), insert: "}" } }).state
  expect(color(closed, "second")).toBeNull()
  expect(color(state, "second")).toBe("strong")
  expect(color(changed, "second")).toBe("emphasis")
  expect(color(closed, "last")).toBeNull()
})

test("the modern grammar is selected only for TeX source in the VS Code preset", () => {
  for (const filename of ["main.tex", "chapter.ltx", "local.sty", "paper.cls"]) {
    expect(latex(filename, "vscode")).toBe(modern)
    expect(latex(filename)).not.toBe(modern)
  }
  expect(latex("references.bib", "vscode")).not.toBe(modern)
  expect(latex("style.bst", "vscode")).toBeUndefined()
  expect(latex("source.ts", "vscode")).toBeUndefined()
})
