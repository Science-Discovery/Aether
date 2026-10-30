import { StreamLanguage, type StreamParser } from "@codemirror/language"
import { stex } from "@codemirror/legacy-modes/mode/stex"
import { modern } from "./code-editor-latex-modern"

// BibTeX has different entry/value delimiters from TeX. Keep its lexer separate;
// bibliography validation belongs to the actual compiler, not the highlighter.
const bib: StreamParser<{ depth: number; quote: boolean; value: boolean }> = {
  startState: () => ({ depth: 0, quote: false, value: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null
    if (state.depth > 1 || state.quote) {
      const char = stream.next()
      if (char === "\\") stream.next()
      if (char === "{" && !state.quote) state.depth++
      if (char === "}" && !state.quote) state.depth--
      if (char === '"' && state.depth <= 1) state.quote = false
      return "string"
    }
    if (stream.match(/^%.*/)) return "comment"
    if (stream.match(/^@[\w-]+/)) return "keyword"
    if (stream.match(/^[\w:-]+(?=\s*=)/)) return "propertyName"
    if (stream.match(/^\d+/)) return "number"
    const char = stream.next()
    if (char === "{") state.depth++
    if (char === "}") state.depth = Math.max(0, state.depth - 1)
    if (char === '"') state.quote = true
    if (char === "=") state.value = true
    if (char === ",") state.value = false
    if (char === "=" || char === "#") return "operator"
    if (char === "{" || char === "}" || char === "," || char === "(") return "punctuation"
    stream.eatWhile(/[\w:./-]/)
    return state.value ? "variableName" : "labelName"
  },
}

const tex = StreamLanguage.define(stex)
const bibliography = StreamLanguage.define(bib)

export function latex(filename: string, preset: "paper" | "vscode" = "paper") {
  if (/\.(tex|ltx|sty|cls)$/i.test(filename)) return preset === "vscode" ? modern : tex
  if (/\.bib$/i.test(filename)) return bibliography
}
