import { marked } from "marked"
import markedKatex from "marked-katex-extension"
import markedShiki from "marked-shiki"
import katex from "katex"
import { bundledLanguages, type BundledLanguage } from "shiki"
import { createSimpleContext } from "./helper"
import { getSharedHighlighter, registerCustomTheme, ThemeRegistrationResolved } from "@pierre/diffs"

registerCustomTheme("OpenCode", () => {
  return Promise.resolve({
    name: "OpenCode",
    colors: {
      "editor.background": "var(--color-background-stronger)",
      "editor.foreground": "var(--text-base)",
      "gitDecoration.addedResourceForeground": "var(--syntax-diff-add)",
      "gitDecoration.deletedResourceForeground": "var(--syntax-diff-delete)",
      // "gitDecoration.conflictingResourceForeground": "#ffca00",
      // "gitDecoration.modifiedResourceForeground": "#1a76d4",
      // "gitDecoration.untrackedResourceForeground": "#00cab1",
      // "gitDecoration.ignoredResourceForeground": "#84848A",
      // "terminal.titleForeground": "#adadb1",
      // "terminal.titleInactiveForeground": "#84848A",
      // "terminal.background": "#141415",
      // "terminal.foreground": "#adadb1",
      // "terminal.ansiBlack": "#141415",
      // "terminal.ansiRed": "#ff2e3f",
      // "terminal.ansiGreen": "#0dbe4e",
      // "terminal.ansiYellow": "#ffca00",
      // "terminal.ansiBlue": "#008cff",
      // "terminal.ansiMagenta": "#c635e4",
      // "terminal.ansiCyan": "#08c0ef",
      // "terminal.ansiWhite": "#c6c6c8",
      // "terminal.ansiBrightBlack": "#141415",
      // "terminal.ansiBrightRed": "#ff2e3f",
      // "terminal.ansiBrightGreen": "#0dbe4e",
      // "terminal.ansiBrightYellow": "#ffca00",
      // "terminal.ansiBrightBlue": "#008cff",
      // "terminal.ansiBrightMagenta": "#c635e4",
      // "terminal.ansiBrightCyan": "#08c0ef",
      // "terminal.ansiBrightWhite": "#c6c6c8",
    },
    tokenColors: [
      {
        scope: ["comment", "punctuation.definition.comment", "string.comment"],
        settings: {
          foreground: "var(--syntax-comment)",
        },
      },
      {
        scope: ["entity.other.attribute-name"],
        settings: {
          foreground: "var(--syntax-property)", // maybe attribute
        },
      },
      {
        scope: ["constant", "entity.name.constant", "variable.other.constant", "variable.language", "entity"],
        settings: {
          foreground: "var(--syntax-constant)",
        },
      },
      {
        scope: ["entity.name", "meta.export.default", "meta.definition.variable"],
        settings: {
          foreground: "var(--syntax-type)",
        },
      },
      {
        scope: ["meta.object.member"],
        settings: {
          foreground: "var(--syntax-primitive)",
        },
      },
      {
        scope: [
          "variable.parameter.function",
          "meta.jsx.children",
          "meta.block",
          "meta.tag.attributes",
          "entity.name.constant",
          "meta.embedded.expression",
          "meta.template.expression",
          "string.other.begin.yaml",
          "string.other.end.yaml",
        ],
        settings: {
          foreground: "var(--syntax-punctuation)",
        },
      },
      {
        scope: ["entity.name.function", "support.type.primitive"],
        settings: {
          foreground: "var(--syntax-primitive)",
        },
      },
      {
        scope: ["support.class.component"],
        settings: {
          foreground: "var(--syntax-type)",
        },
      },
      {
        scope: "keyword",
        settings: {
          foreground: "var(--syntax-keyword)",
        },
      },
      {
        scope: [
          "keyword.operator",
          "storage.type.function.arrow",
          "punctuation.separator.key-value.css",
          "entity.name.tag.yaml",
          "punctuation.separator.key-value.mapping.yaml",
        ],
        settings: {
          foreground: "var(--syntax-operator)",
        },
      },
      {
        scope: ["storage", "storage.type"],
        settings: {
          foreground: "var(--syntax-keyword)",
        },
      },
      {
        scope: ["storage.modifier.package", "storage.modifier.import", "storage.type.java"],
        settings: {
          foreground: "var(--syntax-primitive)",
        },
      },
      {
        scope: [
          "string",
          "punctuation.definition.string",
          "string punctuation.section.embedded source",
          "entity.name.tag",
        ],
        settings: {
          foreground: "var(--syntax-string)",
        },
      },
      {
        scope: "support",
        settings: {
          foreground: "var(--syntax-primitive)",
        },
      },
      {
        scope: ["support.type.object.module", "variable.other.object", "support.type.property-name.css"],
        settings: {
          foreground: "var(--syntax-object)",
        },
      },
      {
        scope: "meta.property-name",
        settings: {
          foreground: "var(--syntax-property)",
        },
      },
      {
        scope: "variable",
        settings: {
          foreground: "var(--syntax-variable)",
        },
      },
      {
        scope: "variable.other",
        settings: {
          foreground: "var(--syntax-variable)",
        },
      },
      {
        scope: [
          "invalid.broken",
          "invalid.illegal",
          "invalid.unimplemented",
          "invalid.deprecated",
          "message.error",
          "markup.deleted",
          "meta.diff.header.from-file",
          "punctuation.definition.deleted",
          "brackethighlighter.unmatched",
          "token.error-token",
        ],
        settings: {
          foreground: "var(--syntax-critical)",
        },
      },
      {
        scope: "carriage-return",
        settings: {
          foreground: "var(--syntax-keyword)",
        },
      },
      {
        scope: "string source",
        settings: {
          foreground: "var(--syntax-variable)",
        },
      },
      {
        scope: "string variable",
        settings: {
          foreground: "var(--syntax-constant)",
        },
      },
      {
        scope: [
          "source.regexp",
          "string.regexp",
          "string.regexp.character-class",
          "string.regexp constant.character.escape",
          "string.regexp source.ruby.embedded",
          "string.regexp string.regexp.arbitrary-repitition",
          "string.regexp constant.character.escape",
        ],
        settings: {
          foreground: "var(--syntax-regexp)",
        },
      },
      {
        scope: "support.constant",
        settings: {
          foreground: "var(--syntax-primitive)",
        },
      },
      {
        scope: "support.variable",
        settings: {
          foreground: "var(--syntax-variable)",
        },
      },
      {
        scope: "meta.module-reference",
        settings: {
          foreground: "var(--syntax-info)",
        },
      },
      {
        scope: "punctuation.definition.list.begin.markdown",
        settings: {
          foreground: "var(--syntax-punctuation)",
        },
      },
      {
        scope: ["markup.heading", "markup.heading entity.name"],
        settings: {
          fontStyle: "bold",
          foreground: "var(--syntax-info)",
        },
      },
      {
        scope: "markup.quote",
        settings: {
          foreground: "var(--syntax-info)",
        },
      },
      {
        scope: "markup.italic",
        settings: {
          fontStyle: "italic",
          // foreground: "",
        },
      },
      {
        scope: "markup.bold",
        settings: {
          fontStyle: "bold",
          foreground: "var(--text-strong)",
        },
      },
      {
        scope: [
          "markup.raw",
          "markup.inserted",
          "meta.diff.header.to-file",
          "punctuation.definition.inserted",
          "markup.changed",
          "punctuation.definition.changed",
          "markup.ignored",
          "markup.untracked",
        ],
        settings: {
          foreground: "var(--text-base)",
        },
      },
      {
        scope: "meta.diff.range",
        settings: {
          fontStyle: "bold",
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: "meta.diff.header",
        settings: {
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: "meta.separator",
        settings: {
          fontStyle: "bold",
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: "meta.output",
        settings: {
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: "meta.export.default",
        settings: {
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: [
          "brackethighlighter.tag",
          "brackethighlighter.curly",
          "brackethighlighter.round",
          "brackethighlighter.square",
          "brackethighlighter.angle",
          "brackethighlighter.quote",
        ],
        settings: {
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: ["constant.other.reference.link", "string.other.link"],
        settings: {
          fontStyle: "underline",
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: "token.info-token",
        settings: {
          foreground: "var(--syntax-info)",
        },
      },
      {
        scope: "token.warn-token",
        settings: {
          foreground: "var(--syntax-warning)",
        },
      },
      {
        scope: "token.debug-token",
        settings: {
          foreground: "var(--syntax-info)",
        },
      },
    ],
    semanticTokenColors: {
      comment: "var(--syntax-comment)",
      string: "var(--syntax-string)",
      number: "var(--syntax-constant)",
      regexp: "var(--syntax-regexp)",
      keyword: "var(--syntax-keyword)",
      variable: "var(--syntax-variable)",
      parameter: "var(--syntax-variable)",
      property: "var(--syntax-property)",
      function: "var(--syntax-primitive)",
      method: "var(--syntax-primitive)",
      type: "var(--syntax-type)",
      class: "var(--syntax-type)",
      namespace: "var(--syntax-type)",
      enumMember: "var(--syntax-primitive)",
      "variable.constant": "var(--syntax-constant)",
      "variable.defaultLibrary": "var(--syntax-unknown)",
    },
  } as unknown as ThemeRegistrationResolved)
})

const katexMacros: Record<string, string> = {
  "\\slashed": "\\not\\!#1",
}

export function decodeMath(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
}

export function normalizeMath(text: string) {
  return text
    .replace(/\\\(((?:\\.|[^\\])*?)\\\)/g, (_, math) => `$${math}$`)
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_, math) => `\n$$\n${math}\n$$\n`)
}

const blockStart = /^[ \t]*(?:\n|\||#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~)/
const blockBreak = /^[ \t]*(?:\n|```|~~~)/

const mathy = /[\\^_{}|~=<>*+/:-]/
const proseWord =
  /\b(?:and|or|not|but|if|then|than|is|are|was|were|be|been|being|the|an|of|to|in|on|at|by|for|with|from|into|onto|per|via|vs|versus|up|down|out|over|under|between|each|every|some|any|all|both|more|less|most|least|only|just|also|very|too|here|there|when|where|which|who|what|that|this|these|those|its|our|you|they|them|their|will|would|can|could|should|may|might|must|does|did|have|has|had|about|after|before|during|since|until|while|total|cost|costs|price|fee|pay)\b/i
const cjk = /[\u4e00-\u9fff\u3040-\u30ff]/

export function mathLike(content: string) {
  return !/\s/.test(content) || mathy.test(content) || (!proseWord.test(content) && !cjk.test(content))
}

function stars(span: string) {
  return span
    .split(/(\\(?:text|textrm|textbf|textit|mathrm|operatorname)\{[^{}]*\})/g)
    .map((part, i) => (i % 2 ? part : part.replace(/(?<!\\)\*/g, "\\ast ")))
    .join("")
}

function pair(text: string) {
  let out = ""
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === "\\") {
      out += text.slice(i, i + 2)
      i += 2
      continue
    }
    if (c !== "$") {
      out += c
      i++
      continue
    }
    const display = text[i + 1] === "$"
    const width = display ? 2 : 1
    let j = i + width
    let close = -1
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2
        continue
      }
      if (text[j] === "$") {
        if (display === (text[j + 1] === "$")) {
          close = j
          break
        }
        j++
        continue
      }
      if (text[j] === "\n" && (display ? blockBreak : blockStart).test(text.slice(j + 1, j + 40))) break
      j++
    }
    if (close === -1) {
      out += text.slice(i, i + width)
      i += width
      continue
    }
    const span = text.slice(i, close + width)
    const flat = span.includes("\n") ? span.replace(/\s*\n[ \t]*>*[ \t]*/g, " ") : span
    const content = flat.slice(width, flat.length - width)
    out += mathLike(content) ? stars(flat) : "\\$".repeat(width) + content + "\\$".repeat(width)
    i = close + width
  }
  return out
}

const tableRow = /^[ \t]*\|/
const tableDelim = /^[ \t|:= -]*-[ \t|:= -]*$/

export function guardPipes(text: string) {
  const lines = text.split("\n")
  let fence = false
  let table = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^[ \t]*(```|~~~)/.test(line)) {
      fence = !fence
      table = false
      continue
    }
    if (fence) continue
    const row: boolean = tableRow.test(line)
    const next = lines[i + 1] ?? ""
    const opens: boolean = row && !table && tableDelim.test(next)
    if (row && (table || opens)) {
      lines[i] = line.replace(/\$[^$\n]*\$/g, (span) => span.replace(/(?<!\\)\|/g, "\\|"))
    }
    table = row && (table || opens)
  }
  return lines.join("\n")
}

const fenceLine = /^[ \t]*(```|~~~)/

function splitCode(text: string): [string, boolean][] {
  const lines = text.split("\n")
  const flags: boolean[] = []
  let fence = false
  let indented = false
  let prevBlank = true
  for (const line of lines) {
    if (fence) {
      flags.push(true)
      if (fenceLine.test(line)) fence = false
      continue
    }
    const blank = line.trim() === ""
    const isIndent = /^(?: {4}|\t)/.test(line)
    if (indented) {
      if (isIndent || blank) flags.push(true)
      else {
        indented = false
        flags.push(false)
      }
    } else if (isIndent && prevBlank && !fenceLine.test(line)) {
      indented = true
      flags.push(true)
    } else {
      flags.push(false)
    }
    if (fenceLine.test(line)) fence = true
    prevBlank = blank
  }
  const groups: [string, boolean][] = []
  let buf: string[] = [lines[0]]
  let code = flags[0]
  lines.slice(1).forEach((line, i) => {
    if (flags[i + 1] !== code) {
      groups.push([buf.join("\n"), code])
      buf = [line]
      code = flags[i + 1]
    } else {
      buf.push(line)
    }
  })
  groups.push([buf.join("\n"), code])
  return groups
}

export function joinMath(text: string) {
  return splitCode(text.replace(/\r\n?/g, "\n"))
    .map(([part, code]) => (code ? part : pair(guardPipes(part))))
    .join("\n")
}

export function renderMathInText(text: string): string {
  let result = normalizeMath(text)

  // Display math: $$...$$
  const displayMathRegex = /\$\$((?:[^$<>\\]|\\[\s\S])+?)\$\$/g
  result = result.replace(displayMathRegex, (match, math) => {
    if (!mathLike(math)) return match
    try {
      return katex.renderToString(decodeMath(math), {
        displayMode: true,
        throwOnError: false,
        macros: katexMacros,
      })
    } catch {
      return `$$${math}$$`
    }
  })

  // Inline math: $...$
  const inlineMathRegex = /(?<!\$)\$(?!\$)((?:[^$\\<>\n]|\\.)+?)\$(?!\$)/g
  result = result.replace(inlineMathRegex, (match, math) => {
    if (!mathLike(math)) return match
    try {
      return katex.renderToString(decodeMath(math), {
        displayMode: false,
        throwOnError: false,
        macros: katexMacros,
      })
    } catch {
      return `$${math}$`
    }
  })

  return result
}

function renderMathExpressions(html: string): string {
  // Split on code/pre/kbd tags to avoid processing their contents
  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi
  const parts = html.split(codeBlockPattern)

  return parts
    .map((part, i) => {
      // Odd indices are the captured code blocks - leave them alone
      if (i % 2 === 1) return part
      // Process math only in non-code parts
      return renderMathInText(part)
    })
    .join("")
}

const jsParser = marked.use(
  {
    renderer: {
      link({ href, title, text }) {
        const titleAttr = title ? ` title="${title}"` : ""
        return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
      },
    },
    tokenizer: {
      del(src: string) {
        const match = /^~~(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))~~(?=[^~]|$)/.exec(src)
        if (!match) return
        return {
          type: "del" as const,
          raw: match[0],
          text: match[1],
          tokens: this.lexer.inlineTokens(match[1]),
        }
      },
    },
  },
  markedKatex({
    throwOnError: false,
    nonStandard: true,
    macros: katexMacros,
  }),
  markedShiki({
    async highlight(code, lang) {
      const highlighter = await getSharedHighlighter({
        themes: ["OpenCode"],
        langs: [],
        preferredHighlighter: "shiki-wasm",
      })
      if (!(lang in bundledLanguages)) {
        lang = "text"
      }
      if (!highlighter.getLoadedLanguages().includes(lang)) {
        await highlighter.loadLanguage(lang as BundledLanguage)
      }
      return highlighter.codeToHtml(code, {
        lang: lang || "text",
        theme: "OpenCode",
        tabindex: false,
      })
    },
  }),
)

export async function parseMarkdown(markdown: string): Promise<string> {
  const html = await jsParser.parse(joinMath(normalizeMath(markdown)))
  return renderMathExpressions(html)
}

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: () => ({ parse: parseMarkdown }),
})
