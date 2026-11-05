import { StreamLanguage, type StreamParser } from "@codemirror/language"
import { Tag } from "@lezer/highlight"
import { literal } from "./code-editor-latex-lexical"

// Separate tags keep these TextMate-inspired colors local to the VS Code preset.
export const tokens = {
  preamble: Tag.define(),
  command: Tag.define(),
  type: Tag.define(),
  math: Tag.define(),
  symbol: Tag.define(),
  number: Tag.define(),
  comment: Tag.define(),
  strong: Tag.define(),
  emphasis: Tag.define(),
  escape: Tag.define(),
  bracket: Tag.define(),
}

type Tone = "argument" | "strong" | "emphasis" | null
type Pending = { tone: Tone; prose?: boolean; action?: "begin" | "end" }
type Frame = {
  close: string
  tone: Tone
  prose: number
  option: boolean
  resume?: Pending
  env?: { action: "begin" | "end"; name: string; valid: boolean }
}
type State = {
  frames: Frame[]
  envs: { name: string; math: boolean; tone: Tone; depth: number }[]
  pending: Pending | null
  delimiters: { close: string; depth: number }[]
  raw: string | null
  tone: Tone
}

const preamble = /^(?:documentclass|usepackage|RequirePackage|LoadClass)$/
const reference = /^(?:(?:auto|text|paren|foot|smart|super|no)?cite[pt]?|[cC]ref|[vV]ref|eqref|pageref|ref|label)$/
const equation =
  /^(?:math|displaymath|equation|align|alignat|flalign|gather|multline|eqnarray|aligned|alignedat|gathered|split)\*?$/
const symbol =
  /^(?:(?:var)?(?:alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|[io]*int|sum|prod|infty|partial|nabla|ell|hbar|times|cdot|pm|mp|div|leq?|geq?|neq?|approx|equiv|sim|to|rightarrow|leftarrow)$/

function math(state: State) {
  const delimiter = state.delimiters.at(-1)
  const prose = state.frames.at(-1)?.prose
  if (prose) return !!delimiter && delimiter.depth >= prose
  return !!delimiter || !!state.envs.at(-1)?.math
}

function tone(state: State) {
  const frame = state.frames.at(-1)
  return math(state) && !frame?.env ? "math" : frame ? frame.tone : state.tone
}

function reset(state: State) {
  state.frames = []
  state.pending = null
  state.delimiters = []
  state.tone = null
}

function environment(state: State, env: NonNullable<Frame["env"]>) {
  if (!env.valid || !/^[a-zA-Z@]+\*?$/.test(env.name.trim())) return
  const name = env.name.trim()
  if (env.action === "begin") {
    const frame = state.frames.at(-1)
    state.envs.push({
      name,
      math: equation.test(name) || math(state),
      tone: frame ? frame.tone : state.tone,
      depth: state.frames.length,
    })
    if (literal.test(name)) state.raw = name
    return
  }
  const index = state.envs.findLastIndex((item) => item.name === name)
  if (index < 0) return
  const scope = state.envs[index]
  if (!scope.depth) state.tone = scope.tone
  if (scope.depth === state.frames.length && scope.depth) state.frames[scope.depth - 1].tone = scope.tone
  state.envs.length = index
}

const parser: StreamParser<State> = {
  name: "latex-modern",
  // `type` is a reserved legacy alias in StreamLanguage, so use another token
  // name while exposing the semantic tag as tokens.type to the theme.
  tokenTable: { ...tokens, argument: tokens.type },
  languageData: { commentTokens: { line: "%" } },
  startState: () => ({ frames: [], envs: [], pending: null, delimiters: [], raw: null, tone: null }),
  copyState: (state) => ({
    ...state,
    pending: state.pending ? { ...state.pending } : null,
    delimiters: state.delimiters.map((delimiter) => ({ ...delimiter })),
    envs: state.envs.map((env) => ({ ...env })),
    frames: state.frames.map((frame) => ({
      ...frame,
      resume: frame.resume ? { ...frame.resume } : undefined,
      env: frame.env ? { ...frame.env } : undefined,
    })),
  }),
  blankLine(state) {
    // Paragraph boundaries recover from unfinished arguments/delimiters. Raw
    // environments and explicit display environments can span blank lines.
    if (state.raw) return
    const value = state.tone
    reset(state)
    state.tone = value
  },
  token(stream, state) {
    if (state.raw) {
      const end = stream.match(/^\\end\s*\{([a-zA-Z@]+\*?)\}/, false)
      if (Array.isArray(end) && end[1] === state.raw && /^\s*$/.test(stream.string.slice(0, stream.pos))) {
        stream.match(end[0])
        environment(state, { action: "end", name: state.raw, valid: true })
        state.raw = null
        return "command"
      }
      if (stream.peek() === "\\") stream.next()
      while (!stream.eol() && stream.peek() !== "\\") stream.next()
      return null
    }
    if (
      stream.sol() &&
      stream.match(
        /^\s*\\(?:(?:documentclass|usepackage|(?:sub)*section|chapter|part)\b|(?:begin|end)\s*\{\s*document\s*\})/,
        false,
      )
    ) {
      reset(state)
      state.envs = []
    }
    if (stream.eatSpace()) return null
    if (stream.match(/^%.*/)) return "comment"

    const frame = state.frames.at(-1)
    if (stream.peek() === "\\") {
      if (frame?.env) frame.env.valid = false
      state.pending = null
      stream.next()
      if (stream.match(/^[a-zA-Z@]+/)) {
        const name = stream.current().slice(1)
        stream.eat("*")
        if (name === "verb" || name === "Verb") {
          const delimiter = stream.peek()
          if (delimiter && !/\s/.test(delimiter)) {
            stream.next()
            if (stream.skipTo(delimiter)) stream.next()
            else stream.skipToEnd()
          }
          return "escape"
        }
        if (name === "begin" || name === "end") {
          state.pending = { tone: "argument", action: name }
          return "command"
        }
        if (preamble.test(name)) {
          state.pending = { tone: "argument" }
          return "preamble"
        }
        if (reference.test(name)) {
          state.pending = { tone: null }
          return "preamble"
        }
        if (name === "textbf" || name === "emph" || name === "textit") {
          state.pending = { tone: name === "textbf" ? "strong" : "emphasis", prose: true }
          return "command"
        }
        if (/^(?:text|mbox|mathtext|textrm|textnormal|textsf|texttt)$/.test(name)) {
          state.pending = { tone: null, prose: true }
          return math(state) ? "math" : "command"
        }
        if (/^(?:bfseries|itshape|normalfont|mdseries|upshape)$/.test(name)) {
          const value = name === "bfseries" ? "strong" : name === "itshape" ? "emphasis" : null
          if (frame) frame.tone = value
          else state.tone = value
          return "command"
        }
        if (math(state)) return symbol.test(name) ? "symbol" : "math"
        return "command"
      }
      const char = stream.next()
      if (char === "(" || char === "[") {
        state.delimiters.push({ close: char === "(" ? ")" : "]", depth: state.frames.length })
        return "math"
      }
      if (char === state.delimiters.at(-1)?.close && (char === ")" || char === "]")) {
        state.delimiters.pop()
        return "math"
      }
      return "escape"
    }
    if (stream.peek() === "{") {
      stream.next()
      if (frame?.env) frame.env.valid = false
      const pending = state.pending
      state.frames.push({
        close: "}",
        tone: pending ? pending.tone : frame ? frame.tone : state.tone,
        prose: pending?.prose ? state.frames.length + 1 : (frame?.prose ?? 0),
        option: frame?.option ?? false,
        env: pending?.action ? { action: pending.action, name: "", valid: true } : undefined,
      })
      state.pending = null
      return "bracket"
    }
    if (stream.peek() === "[" && (state.pending || frame?.close === "]")) {
      stream.next()
      state.frames.push({
        close: "]",
        tone: frame ? frame.tone : state.tone,
        prose: frame?.prose ?? 0,
        option: true,
        resume: state.pending ?? undefined,
      })
      state.pending = null
      return "bracket"
    }
    if (frame && stream.peek() === frame.close) {
      stream.next()
      state.frames.pop()
      state.pending = frame.resume ?? null
      if (frame.env) environment(state, frame.env)
      return "bracket"
    }
    state.pending = null
    if (stream.peek() === "$") {
      stream.next()
      stream.eat("$")
      const delimiter = stream.current()
      if (math(state) && state.delimiters.at(-1)?.close === delimiter) state.delimiters.pop()
      else state.delimiters.push({ close: delimiter, depth: state.frames.length })
      return "math"
    }
    if (stream.match(/^[{}[\]()]/)) return "bracket"
    if (stream.match(/^\d+(?:\.\d+)?/)) {
      if (frame?.env) frame.env.name += stream.current()
      const value = tone(state)
      return value === "math" || frame?.option ? "number" : value
    }
    stream.next()
    stream.eatWhile(/[^\\%{}[\]()$\d\s]/)
    if (frame?.env) frame.env.name += stream.current()
    return tone(state)
  },
}

export const modern = StreamLanguage.define(parser)
