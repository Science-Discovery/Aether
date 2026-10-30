import { expect, test } from "bun:test"
import { Compartment, EditorState, StateField, type Extension, type RangeSet, type RangeValue } from "@codemirror/state"
import { assistance, extensions } from "./code-editor-latex-decorations"

function state(doc: string, filename = "main.tex") {
  const extension = extensions(filename) as readonly Extension[]
  const index = extension.find((item): item is StateField<RangeSet<RangeValue>> => item instanceof StateField)!
  const config = new Compartment()
  const state = EditorState.create({
    doc,
    extensions: [extension, config.of(assistance.of({ guides: true, brackets: true }))],
  })
  return { state, index, config }
}

function marks(doc: ReturnType<typeof state>) {
  const result: { text: string; pos: number; depth: number }[] = []
  doc.state.field(doc.index).between(0, doc.state.doc.length, (from, to, value) => {
    result.push({
      text: doc.state.doc.sliceString(from, to),
      pos: from,
      depth: (value as RangeValue & { depth: number }).depth,
    })
  })
  return result
}

test("colors paired TeX delimiters by depth, including command arguments and explicit groups", () => {
  const doc = state(String.raw`\section{A {nested} title} [({x})]`)
  expect(
    marks(doc)
      .map((item) => item.text)
      .join(""),
  ).toBe("{{}}[({})]")
  expect(marks(doc).map((item) => item.depth)).toEqual([0, 1, 1, 0, 0, 1, 2, 2, 1, 0])
  expect(marks(state("{[{(x)}]}")).map((item) => item.depth)).toEqual([0, 1, 2, 0, 0, 2, 1, 0])
})

test("ignores comments, escaped delimiters and percent, and inline verbatim", () => {
  const doc = state(String.raw`\{escaped\} \[x\] \(x\)
% {comment} [comment]
\verb|{raw}| \verb*+([raw])+ \Verb!{raw}!
\% {real} \\{after newline command}`)
  expect(
    marks(doc)
      .map((item) => item.text)
      .join(""),
  ).toBe("{}{}")
  expect(marks(doc).every((item) => item.pos >= doc.state.doc.line(4).from)).toBe(true)
})

test("raw environments skip their bodies and resume at the real end delimiter", () => {
  ;[
    "verbatim",
    "verbatim*",
    "Verbatim",
    "BVerbatim",
    "LVerbatim",
    "lstlisting*",
    "minted",
    "comment",
    "filecontents*",
  ].forEach((name) => {
    const doc = state(`\\begin{${name}}\n{fake} [fake] (fake)\n\\end{other}\n\\end{${name}}\n{real}`)
    expect(
      marks(doc)
        .map((item) => item.text)
        .join(""),
    ).toBe("{}{}{}")
    expect(
      marks(doc).some((item) => item.pos >= doc.state.doc.line(2).from && item.pos < doc.state.doc.line(4).from),
    ).toBe(false)
  })
  const doc = state("\\begin{verbatim}\n{not paired} (ignored)")
  expect(
    marks(doc)
      .map((item) => item.text)
      .join(""),
  ).toBe("{}")
})

test("mismatched and unfinished parents do not expose misleading child colors", () => {
  expect(marks(state("{unfinished [complete]"))).toEqual([])
  expect(marks(state("{[wrong}]}"))).toEqual([])
  expect(
    marks(state("{[wrong}]} {valid}"))
      .map((item) => item.text)
      .join(""),
  ).toBe("{}")
  expect(
    marks(state("{valid} {unfinished"))
      .map((item) => item.text)
      .join(""),
  ).toBe("{}")
})

test("many unfinished begin arguments remain conservative without repeated group walks", () => {
  const doc = state("\\begin{unfinished\n".repeat(2000))
  expect(marks(doc)).toEqual([])
})

test("BibTeX pairs entry and value braces without interpreting parentheses in titles", () => {
  const doc = state(
    String.raw`@article(first,
  title = "A ) title {nested} and literal } text",
  note = {Body (literal) and {TeX}},
  year = 2026
)
@book{second,
  title = {A title with "quotes" and )},
  note = "Quoted {nested "text"}"
}`,
    "refs.bib",
  )
  expect(
    marks(doc)
      .map((item) => item.text)
      .join(""),
  ).toBe("({}{{}}){{}{}}")
  expect(
    marks(doc)
      .filter((item) => item.depth === 0)
      .map((item) => item.text)
      .join(""),
  ).toBe("(){}")
})

test("BibTeX ignores top-level comments and escaped braces inside values", () => {
  const doc = state(
    String.raw`% @article{comment,
outside (plain) {plain}
@article{entry,
  title = "Escaped \{text\} and \"quote\"",
  % } fake close
  note = {Percent % here and [literal]}
}`,
    "refs.BIB",
  )
  expect(
    marks(doc)
      .map((item) => item.text)
      .join(""),
  ).toBe("{{}}")
})

test("incomplete quoted values, entries and mismatched entry delimiters have no colors", () => {
  ;[
    '@article{key,\n title = "unfinished\n}',
    "@article(key,\n title = {nested}\n}",
    "@article{key,\n title = {unfinished\n}",
  ].forEach((doc) => expect(marks(state(doc, "refs.bib"))).toEqual([]))
})

test("selection and display changes reuse the cached index; text changes rebuild it", () => {
  const doc = state("{first} [second]")
  const initial = doc.state.field(doc.index)
  const selected = doc.state.update({ selection: { anchor: 2 } }).state
  expect(selected.field(doc.index)).toBe(initial)
  const styled = selected.update({
    effects: doc.config.reconfigure(assistance.of({ guides: false, brackets: true })),
  }).state
  expect(styled.field(doc.index)).toBe(initial)
  const changed = styled.update({ changes: { from: 7, insert: "{new}" } }).state
  expect(changed.field(doc.index)).not.toBe(initial)
  expect(
    marks({ ...doc, state: changed })
      .map((item) => item.text)
      .join(""),
  ).toBe("{}{}[]")
})

test("disabled brackets do not retain stale indexes and enabling them indexes the latest document", () => {
  const doc = state("{original}")
  const disabled = doc.state.update({
    effects: doc.config.reconfigure(assistance.of({ guides: true, brackets: false })),
  }).state
  expect(disabled.field(doc.index).size).toBe(0)
  const changed = disabled.update({ changes: { from: 0, to: disabled.doc.length, insert: "[changed]" } }).state
  expect(changed.field(doc.index)).toBe(disabled.field(doc.index))
  const enabled = changed.update({
    effects: doc.config.reconfigure(assistance.of({ guides: true, brackets: true })),
  }).state
  expect(
    marks({ ...doc, state: enabled })
      .map((item) => item.text)
      .join(""),
  ).toBe("[]")
})

test("bst retains an empty bracket index while unrelated files have no extension", () => {
  expect(marks(state("{do not parse} [bst]", "style.bst"))).toEqual([])
  ;["main.txt", "file.ts", "file.tex.bak"].forEach((filename) => expect(extensions(filename)).toEqual([]))
})
