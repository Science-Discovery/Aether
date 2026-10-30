import { expect, test } from "bun:test"
import { foldable } from "@codemirror/language"
import { EditorState, StateField, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { structure } from "./code-editor-latex-structure"

function state(doc: string, filename = "main.tex") {
  return EditorState.create({ doc, extensions: structure(filename) })
}

function fold(state: EditorState, number: number) {
  const line = state.doc.line(number)
  return foldable(state, line.from, line.to)
}

test("sections include descendants and stop at the next section of equal or higher rank", () => {
  const doc = state(String.raw`\part{Part}
part text
\chapter{Chapter}
chapter text
\section{Section}
section text
\subsection{Subsection}
subsection text
\subsubsection{Subsubsection}
subsubsection text
\paragraph{Paragraph}
paragraph text
\subparagraph{Subparagraph}
subparagraph text
\chapter{Next}
next text`)
  expect(fold(doc, 1)).toEqual({ from: doc.doc.line(1).to, to: doc.doc.length })
  ;[3, 5, 7, 9, 11, 13].forEach((line) => {
    expect(fold(doc, line)).toEqual({ from: doc.doc.line(line).to, to: doc.doc.line(15).from - 1 })
  })
  expect(fold(doc, 15)).toEqual({ from: doc.doc.line(15).to, to: doc.doc.length })
  expect(fold(doc, 2)).toBeNull()
})

test("same-rank sections and starred headings with short and nested titles fold", () => {
  const doc = state(String.raw`\section*[Short {with ]}]{First {nested} \{title\}}
first body
\section{Second
continued title}
second body`)
  expect(fold(doc, 1)).toEqual({ from: doc.doc.line(1).to, to: doc.doc.line(3).from - 1 })
  expect(fold(doc, 3)).toEqual({ from: doc.doc.line(3).to, to: doc.doc.length })
  const decorations = doc.facet(EditorView.decorations)
  expect(decorations).toHaveLength(1)
  const marks = decorations[0]
  expect(typeof marks).not.toBe("function")
  if (typeof marks === "function") throw new Error("Expected cached decorations")
  const ranges: { from: number; to: number; class: string }[] = []
  marks.between(0, doc.doc.length, (from, to, value) => {
    ranges.push({ from, to, class: value.spec.class })
  })
  expect(ranges).toEqual([
    { from: 0, to: doc.doc.line(1).to, class: "cm-latex-heading" },
    { from: doc.doc.line(3).from, to: doc.doc.line(4).to, class: "cm-latex-heading" },
  ])
})

test("nested environments and their headings stop at the enclosing end command", () => {
  const doc = state(String.raw`\begin{document}
\section{Outer}
body
\begin{figure}
\subsection{Inner}
caption
\end{figure}
after
\end{document}
outside`)
  expect(fold(doc, 1)?.to).toBe(doc.doc.line(9).from)
  expect(fold(doc, 2)?.to).toBe(doc.doc.line(9).from - 1)
  expect(fold(doc, 4)?.to).toBe(doc.doc.line(7).from)
  expect(fold(doc, 5)?.to).toBe(doc.doc.line(7).from - 1)
  expect(fold(doc, 9)).toBeNull()
})

test("comments, escaped commands, and inline verbatim cannot create structural boundaries", () => {
  const doc = state(String.raw`\section{Real}
% \section{Comment} \begin{wrong}
\\section{Escaped}
\verb|\section{Inline} \end{document}|
\verb*+\begin{wrong}+
\% visible percent
body
\section% comment between command and title
{Next}
next body`)
  expect(fold(doc, 1)?.to).toBe(doc.doc.line(8).from - 1)
  ;[2, 3, 4, 5, 6].forEach((line) => expect(fold(doc, line)).toBeNull())
  expect(fold(doc, 8)?.to).toBe(doc.doc.length)
})

test("raw environments fold without interpreting their example commands", () => {
  ;["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment"].forEach((name) => {
    const doc = state(
      `\\section{Real}\n\\begin{${name}}\n\\section{Fake}\n\\begin{wrong}\n\\end{other}\n\\end{${name}}\nbody\n\\section{Next}\nnext`,
    )
    expect(fold(doc, 1)?.to).toBe(doc.doc.line(8).from - 1)
    expect(fold(doc, 2)?.to).toBe(doc.doc.line(6).from)
    ;[3, 4, 5].forEach((line) => expect(fold(doc, line)).toBeNull())
  })
})

test("macro arguments and explicit groups do not expose their example structures", () => {
  const doc = state(String.raw`\section{Real}
\newcommand{\demo}[1]{\section{Fake}
\begin{wrong}#1}
\title[\section{Short}]{\section{Title}}
{\section{Grouped}}
\Verb|\section{Inline}|
body
\section{Next}
next`)
  expect(fold(doc, 1)?.to).toBe(doc.doc.line(8).from - 1)
  ;[2, 3, 4, 5, 6].forEach((line) => expect(fold(doc, line)).toBeNull())
  expect(fold(doc, 8)?.to).toBe(doc.doc.length)
})

test("an environment and heading on one line publish a single enclosing fold", () => {
  const doc = state(String.raw`\begin{document}\section{First}
body
\section{Second}
body
\end{document}
outside`)
  expect(fold(doc, 1)).toEqual({ from: doc.doc.line(1).to, to: doc.doc.line(5).from })
  expect(fold(doc, 3)).toEqual({ from: doc.doc.line(3).to, to: doc.doc.line(5).from - 1 })
})

test("headings across environment boundaries do not expose partially overlapping folds", () => {
  const doc = state(String.raw`\section{First}
\begin{box}
body
\section{Second}
body
\end{box}`)
  expect(fold(doc, 1)?.to).toBe(doc.doc.line(4).from - 1)
  expect(fold(doc, 2)).toBeNull()
  expect(fold(doc, 4)?.to).toBe(doc.doc.line(6).from - 1)
})

test("incomplete and mismatched environments and titles are not folded", () => {
  ;[
    String.raw`\begin{outer}
\begin{inner}
body
\end{outer}
\end{inner}`,
    String.raw`\begin{outer}
\begin{inner}
body
\end{inner}`,
    String.raw`\begin{outer}
\section{Inside}
body`,
    String.raw`\section{Incomplete
body`,
    String.raw`\begin{verbatim}
\section{Fake}
body`,
  ].forEach((source) => {
    const doc = state(source)
    Array.from({ length: doc.doc.lines }, (_, line) => expect(fold(doc, line + 1)).toBeNull())
  })
  expect(fold(state(String.raw`\begin{itemize}\end{itemize}`), 1)).toBeNull()
})

test("BibTeX entries honor parentheses, nested braces, quoted delimiters, and comments", () => {
  const doc = state(
    String.raw`% @article{comment,
@article{first,
 title = {Nested {TeX} and a literal "quote"},
 note = "Quoted } and ) with {nested "quote"} and \"escape\""
}
@book(second,
 title = "Parenthesis ) in a value",
 note = {Braces with ) and % literal text},
 % fake ) close
 year = 2026
)
@string{macro = "one line"}`,
    "refs.bib",
  )
  expect(fold(doc, 1)).toBeNull()
  expect(fold(doc, 2)).toEqual({ from: doc.doc.line(2).to, to: doc.doc.line(5).from })
  expect(fold(doc, 6)).toEqual({ from: doc.doc.line(6).to, to: doc.doc.line(11).from })
  expect(fold(doc, 12)).toBeNull()
})

test("unfinished and mismatched BibTeX entries have no fold", () => {
  ;[
    '@article{key,\n title = "unfinished\n}',
    "@article(key,\n title = {nested}\n}",
    "@article{key,\n title = {unfinished\n}",
  ].forEach((source) => expect(fold(state(source, "refs.bib"), 1)).toBeNull())
})

test("selection-only updates reuse the structure index while document changes rebuild it", () => {
  const extension = structure("main.tex")
  const field = (extension as readonly Extension[]).find(
    (item): item is StateField<unknown> => item instanceof StateField,
  )!
  const doc = EditorState.create({ doc: "\\section{One}\nbody\n\\section{Two}\nbody", extensions: extension })
  const selected = doc.update({ selection: { anchor: 3 } }).state
  expect(selected.field(field)).toBe(doc.field(field))
  expect(fold(selected, 1)).toBe(fold(doc, 1))
  expect(selected.facet(EditorView.decorations)[0]).toBe(doc.facet(EditorView.decorations)[0])
  const changed = selected.update({ changes: { from: selected.doc.length, insert: "\nmore" } }).state
  expect(changed.field(field)).not.toBe(selected.field(field))
  expect(fold(changed, 3)?.to).toBe(changed.doc.length)
})

test("structure activates for TeX variants and BibTeX while bst and unrelated files stay untouched", () => {
  ;["main.tex", "main.LTX", "layout.sty", "article.cls"].forEach((filename) => {
    expect(fold(state("\\section{Title}\nbody", filename), 1)).not.toBeNull()
  })
  ;["plain.txt", "style.bst", "tex", "file.tex.bak"].forEach((filename) => {
    expect(structure(filename)).toEqual([])
    expect(fold(state("\\section{Title}\nbody", filename), 1)).toBeNull()
  })
})
