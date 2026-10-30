import { getIndentUnit } from "@codemirror/language"
import { countColumn, Facet, RangeSet, RangeValue, StateField, type Extension } from "@codemirror/state"
import { Decoration, ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view"
import { command, comment, literal, space } from "./code-editor-latex-lexical"

type Options = { guides: boolean; brackets: boolean }

export const assistance = Facet.define<Options, Options>({
  combine: (values) => values[0] ?? { guides: false, brackets: false },
})

class Bracket extends RangeValue {
  constructor(readonly depth: number) {
    super()
  }
}

type Pair = { from: number; to?: number; close: string; depth: number; parent?: Pair; valid: boolean }

// Keep the syntax index separate from displayed marks: scrolling never tokenizes the document.
function scan(source: string, bib: boolean) {
  const pairs: Pair[] = []
  const stack: Pair[] = []
  const open = (from: number, close: string) => {
    const pair: Pair = { from, close, depth: stack.length, parent: stack.at(-1), valid: true }
    stack.push(pair)
    pairs.push(pair)
  }
  const close = (to: number, char: string) => {
    const pair = stack.at(-1)
    if (pair?.close === char) {
      pair.to = to
      stack.pop()
      return
    }
    stack.forEach((item) => (item.valid = false))
    stack.length = 0
  }
  let quote = false
  let pos = 0
  while (pos < source.length) {
    const char = source[pos]
    if (bib) {
      if (!stack.length) {
        quote = false
        if (char === "%") {
          pos = comment(source, pos)
          continue
        }
        const token = char === "@" && /^@[a-zA-Z][\w-]*/.exec(source.slice(pos))
        const from = token ? space(source, pos + token[0].length) : -1
        if (source[from] === "{" || source[from] === "(") {
          open(from, source[from] === "{" ? "}" : ")")
          pos = from + 1
          continue
        }
        pos++
        continue
      }
      if (char === "\\") {
        pos += 2
        continue
      }
      if (char === "%" && !quote && stack.length === 1) {
        pos = comment(source, pos)
        continue
      }
      if (char === '"' && stack.length === 1) quote = !quote
      if (char === "{") open(pos, "}")
      if (char === "}" && stack.length > 1) {
        close(pos, char)
        pos++
        continue
      }
      if (!quote && stack.length === 1 && (char === "}" || char === ")")) close(pos, char)
      pos++
      continue
    }
    if (char === "%") {
      pos = comment(source, pos)
      continue
    }
    if (char === "\\") {
      const token = command(source, pos)
      pos = token.to
      if (token.name !== "begin" || source[pos - 1] === "*") continue
      const from = space(source, pos)
      // Environment names are flat. A general group walk here would rescan to EOF
      // for every unfinished begin command while the user is still typing.
      const parameter = /^\{\s*([a-zA-Z][\w*:-]*)\s*\}/.exec(source.slice(from))
      if (!parameter) continue
      const name = parameter[1]
      if (!literal.test(name)) continue
      const to = from + parameter[0].length
      open(from, "}")
      close(to - 1, "}")
      const pattern = new RegExp(`^[\\t ]*\\\\end\\s*\\{${name.replace("*", "\\*")}\\}`, "gm")
      pattern.lastIndex = to
      const match = pattern.exec(source)
      // Resume at the end command itself so its real delimiter can still be colored.
      pos = match ? match.index + match[0].indexOf("\\") : source.length
      continue
    }
    if (char === "{" || char === "[" || char === "(") open(pos, { "{": "}", "[": "]", "(": ")" }[char])
    if (char === "}" || char === "]" || char === ")") close(pos, char)
    pos++
  }
  // A valid child of an unfinished parent is still ambiguous; do not color that subtree.
  pairs.forEach((pair) => {
    pair.valid = pair.valid && pair.to !== undefined && (!pair.parent || pair.parent.valid)
  })
  return RangeSet.of(
    pairs.flatMap((pair) => {
      if (!pair.valid || pair.to === undefined) return []
      const value = new Bracket(pair.depth % 3)
      return [value.range(pair.from, pair.from + 1), value.range(pair.to, pair.to + 1)]
    }),
    true,
  )
}

export function extensions(filename: string): Extension {
  if (!/\.(tex|ltx|sty|cls|bib|bst)$/i.test(filename)) return []
  const bib = /\.bib$/i.test(filename)
  const bst = /\.bst$/i.test(filename)
  const index = StateField.define({
    create: (state) => (bst || !state.facet(assistance).brackets ? RangeSet.empty : scan(state.doc.toString(), bib)),
    update: (value, tr) => {
      if (bst || !tr.state.facet(assistance).brackets) return RangeSet.empty
      if (tr.docChanged || !tr.startState.facet(assistance).brackets) return scan(tr.newDoc.toString(), bib)
      return value
    },
  })
  const marks = (view: EditorView) => {
    const cfg = view.state.facet(assistance)
    const ranges: ReturnType<Decoration["range"]>[] = []
    const lines = new Set<number>()
    const unit = getIndentUnit(view.state)
    view.visibleRanges.forEach((range) => {
      if (cfg.brackets) {
        view.state.field(index).between(range.from, range.to, (from, to, value) => {
          if (!(value instanceof Bracket) || from < range.from || to > range.to) return
          ranges.push(Decoration.mark({ class: `cm-latex-bracket-${value.depth}` }).range(from, to))
        })
      }
      if (!cfg.guides) return
      let line = view.state.doc.lineAt(range.from)
      while (line.from <= range.to) {
        if (!lines.has(line.number)) {
          lines.add(line.number)
          const prefix = /^[\t ]+/.exec(line.text)?.[0]
          if (
            prefix &&
            prefix.length < line.length &&
            line.from >= range.from &&
            line.from + prefix.length <= range.to &&
            countColumn(prefix, view.state.tabSize) >= unit
          ) {
            ranges.push(
              Decoration.mark({
                class: "cm-latex-indent",
                attributes: {
                  style: `background-image: linear-gradient(to right, var(--latex-guide) 1px, transparent 1px); background-size: ${unit}ch 100%; background-repeat: repeat-x`,
                },
              }).range(line.from, line.from + prefix.length),
            )
          }
        }
        if (line.number === view.state.doc.lines) break
        line = view.state.doc.line(line.number + 1)
      }
    })
    return Decoration.set(ranges, true)
  }
  return [
    index,
    ViewPlugin.fromClass(
      class {
        decorations
        constructor(view: EditorView) {
          this.decorations = marks(view)
        }
        update(update: ViewUpdate) {
          if (
            update.docChanged ||
            update.viewportChanged ||
            update.geometryChanged ||
            update.startState.facet(assistance) !== update.state.facet(assistance) ||
            update.startState.tabSize !== update.state.tabSize ||
            getIndentUnit(update.startState) !== getIndentUnit(update.state)
          ) {
            this.decorations = marks(update.view)
          }
        }
      },
      { decorations: (value) => value.decorations },
    ),
  ]
}
