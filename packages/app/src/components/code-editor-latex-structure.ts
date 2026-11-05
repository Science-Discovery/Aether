import { foldService } from "@codemirror/language"
import { StateField, type Extension, type Text } from "@codemirror/state"
import { Decoration, EditorView } from "@codemirror/view"
import { comment, command, group, literal, space } from "./code-editor-latex-lexical"

type Scope = { name: string; start: number; to?: number; parent?: Scope; valid: boolean }
type Heading = { rank: number; start: number; to?: number; scope?: Scope; valid: boolean }

const levels = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"]
const heading = Decoration.mark({ class: "cm-latex-heading" })

function entry(source: string, from: number) {
  const close = source[from] === "{" ? "}" : ")"
  let depth = 0
  let quote = false
  let pos = from + 1
  while (pos < source.length) {
    const char = source[pos]
    if (char === "\\") {
      pos += 2
      continue
    }
    if (char === "%" && !quote && depth === 0) {
      pos = comment(source, pos)
      continue
    }
    if (char === "{") {
      depth++
      pos++
      continue
    }
    if (char === "}" && depth > 0) {
      depth--
      pos++
      continue
    }
    if (char === '"' && depth === 0) {
      quote = !quote
      pos++
      continue
    }
    if (!quote && depth === 0 && (char === "}" || char === ")")) return char === close ? pos : undefined
    pos++
  }
}

function scan(doc: Text, bib: boolean) {
  const source = doc.toString()
  const folds = new Map<number, { from: number; to: number }>()
  const marks: ReturnType<typeof heading.range>[] = []
  const scopes: Scope[] = []
  const stack: Scope[] = []
  const headings: Heading[] = []
  const active: Heading[] = []
  const add = (start: number, to: number) => {
    const line = doc.lineAt(start)
    if (line.to >= to || doc.lineAt(to).number === line.number) return
    const previous = folds.get(line.from)
    if (!previous || previous.to < to) folds.set(line.from, { from: line.to, to })
  }
  const end = (item: Heading, to: number) => {
    item.to = Math.max(0, doc.lineAt(to).from - 1)
  }
  let pos = 0
  tokens: while (pos < source.length) {
    if (source[pos] === "%") {
      pos = comment(source, pos)
      continue
    }
    if (bib) {
      if (source[pos] !== "@") {
        pos++
        continue
      }
      const token = /^@[a-zA-Z][\w-]*/.exec(source.slice(pos))
      const from = token && space(source, pos + token[0].length)
      if (from === null || (source[from] !== "{" && source[from] !== "(")) {
        pos++
        continue
      }
      const to = entry(source, from)
      if (to === undefined) break
      add(pos, to)
      pos = to + 1
      continue
    }
    // Arguments and explicit groups may contain macro definitions, not active structure.
    if (source[pos] === "{") {
      const to = group(source, pos)
      if (to === undefined) break
      pos = to
      continue
    }
    if (source[pos] !== "\\") {
      pos++
      continue
    }
    const start = pos
    const token = command(source, pos)
    pos = token.to
    if (token.name === "begin" || token.name === "end") {
      if (source[pos - 1] === "*") continue
      const from = space(source, pos)
      if (source[from] !== "{") continue
      const to = group(source, from)
      if (to === undefined) break
      pos = to
      const name = source.slice(from + 1, to - 1).trim()
      if (!/^[a-zA-Z][\w*:-]*$/.test(name)) continue
      if (token.name === "begin") {
        const scope: Scope = { name, start, parent: stack.at(-1), valid: true }
        scopes.push(scope)
        if (literal.test(name)) {
          // Raw environments only end at their own delimiter on a fresh line.
          const pattern = new RegExp(`^[\\t ]*\\\\end\\s*\\{${name.replace("*", "\\*")}\\}`, "gm")
          pattern.lastIndex = pos
          const match = pattern.exec(source)
          if (!match) {
            stack.push(scope)
            break
          }
          scope.to = match.index + match[0].indexOf("\\")
          pos = pattern.lastIndex
          continue
        }
        stack.push(scope)
        continue
      }
      const scope = stack.at(-1)
      if (!scope || scope.name !== name) {
        stack.forEach((item) => (item.valid = false))
        active.forEach((item) => (item.valid = false))
        stack.length = 0
        continue
      }
      scope.to = start
      stack.pop()
      while (active.at(-1)?.scope === scope) end(active.pop()!, start)
      continue
    }
    const rank = levels.indexOf(token.name)
    if (rank < 0) {
      let from = space(source, pos)
      while (source[from] === "{" || source[from] === "[") {
        const to = group(source, from)
        if (to === undefined) break tokens
        pos = to
        from = space(source, pos)
      }
      continue
    }
    let from = space(source, pos)
    if (source[from] === "[") {
      const to = group(source, from)
      if (to === undefined) break
      from = space(source, to)
    }
    if (source[from] !== "{") continue
    const to = group(source, from)
    if (to === undefined) break
    pos = to
    marks.push(heading.range(start, to))
    while (active.length && active.at(-1)!.rank >= rank) end(active.pop()!, start)
    const item: Heading = { rank, start, scope: stack.at(-1), valid: true }
    headings.push(item)
    active.push(item)
  }
  // Propagate incomplete/mismatched parents in creation order, without recursive walks.
  scopes.forEach((scope) => {
    scope.valid = scope.valid && scope.to !== undefined && (!scope.parent || scope.parent.valid)
    if (scope.valid) add(scope.start, scope.to!)
  })
  active.forEach((item) => {
    item.to = source.length
    if (stack.length || pos < source.length) item.valid = false
  })
  headings.forEach((item) => {
    if (item.valid && item.to !== undefined && (!item.scope || item.scope.valid)) add(item.start, item.to)
  })
  // Unusual headings inside environments can overlap rather than nest. Keep folds disjoint or nested.
  const nested: { from: number; to: number }[] = []
  Array.from(folds)
    .sort((a, b) => a[0] - b[0])
    .forEach((item) => {
      const range = item[1]
      while (nested.length && nested.at(-1)!.to <= range.from) nested.pop()
      if (nested.length && range.to > nested.at(-1)!.to) {
        folds.delete(item[0])
        return
      }
      nested.push(range)
    })
  return { folds, marks: Decoration.set(marks) }
}

export function structure(filename: string): Extension {
  if (!/\.(tex|ltx|sty|cls|bib)$/i.test(filename)) return []
  const bib = /\.bib$/i.test(filename)
  const index = StateField.define({
    create: (state) => scan(state.doc, bib),
    update: (value, tr) => (tr.docChanged ? scan(tr.newDoc, bib) : value),
    provide: (field) => EditorView.decorations.from(field, (value) => value.marks),
  })
  return [index, foldService.of((state, from) => state.field(index).folds.get(from) ?? null)]
}
