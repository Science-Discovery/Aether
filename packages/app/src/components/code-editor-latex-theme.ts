import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { tags as t } from "@lezer/highlight"
import { tokens } from "./code-editor-latex-modern"

export type WritingStyle = {
  preset?: "paper" | "vscode"
  typeface?: "aether" | "vscode"
  guides?: boolean
  brackets?: boolean
  dark: boolean
  size: number
  spacing: "compact" | "normal" | "wide"
  font: string
}

export function manuscript(filename: string) {
  return /\.(tex|ltx|sty|cls|bib|bst)$/i.test(filename)
}

// Keep the chosen Latin monospace faces ahead of CJK fallbacks, and generic
// families last so Chinese prose does not fall back to a serif system font.
export function typography(font: string) {
  return `${font.replace(/\bui-monospace,\s*/g, "").replace(/,\s*monospace$/, "")}, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace`
}

const highlight = HighlightStyle.define([
  { tag: [t.tagName, t.keyword, t.meta, t.attributeName], color: "var(--latex-command)" },
  { tag: [t.atom, t.labelName, t.propertyName, t.string], color: "var(--latex-argument)" },
  { tag: [t.variableName, t.special(t.variableName), t.number, t.operator], color: "var(--latex-math)" },
  { tag: [t.bracket, t.punctuation], color: "var(--latex-punctuation)" },
  { tag: t.comment, color: "var(--latex-comment)" },
  { tag: t.escape, color: "var(--latex-command)" },
  { tag: t.invalid, textDecoration: "underline wavy var(--latex-error)" },
])

// Modern/Plus colors with Workshop-style TeX scopes; standard tags retain
// the existing BibTeX highlighting without applying TeX command semantics.
const studio = HighlightStyle.define([
  { tag: tokens.preamble, color: "var(--latex-control)" },
  { tag: tokens.command, color: "var(--latex-command)" },
  { tag: [tokens.type, tokens.math], color: "var(--latex-type)" },
  { tag: tokens.symbol, color: "var(--latex-keyword)" },
  { tag: tokens.number, color: "var(--latex-number)" },
  { tag: tokens.comment, color: "var(--latex-comment)" },
  { tag: tokens.strong, color: "var(--latex-strong)", fontWeight: "bold" },
  { tag: tokens.emphasis, color: "var(--latex-emphasis)", fontStyle: "italic" },
  { tag: tokens.escape, color: "var(--latex-control)" },
  { tag: tokens.bracket, color: "var(--latex-punctuation)" },
  { tag: [t.tagName, t.escape], color: "var(--latex-command)" },
  { tag: [t.keyword, t.attributeName], color: "var(--latex-keyword)" },
  { tag: t.meta, color: "var(--latex-control)" },
  { tag: t.atom, color: "var(--latex-type)" },
  { tag: [t.labelName, t.propertyName, t.variableName, t.special(t.variableName)], color: "var(--latex-math)" },
  { tag: t.string, color: "var(--latex-argument)" },
  { tag: t.number, color: "var(--latex-number)" },
  { tag: [t.operator, t.bracket, t.punctuation], color: "var(--latex-punctuation)" },
  { tag: t.comment, color: "var(--latex-comment)" },
  { tag: t.invalid, textDecoration: "underline wavy var(--latex-error)" },
])

export function writing(opts: WritingStyle) {
  const vscode = opts.preset === "vscode"
  const paper = opts.dark
    ? {
        background: "#20252b",
        gutter: "#1c2127",
        text: "#dce2e7",
        muted: "#8c99a5",
        border: "#343e48",
        active: "#29313a",
        selection: "#3b5268",
        command: "#8eb9e8",
        math: "#d4abde",
        argument: "#d9b57d",
        comment: "#99ae9a",
        punctuation: "#a8b5c1",
        match: "#354d48",
        search: "#675638",
        error: "#ed9b94",
      }
    : {
        background: "#fafbf9",
        gutter: "#f0f3f0",
        text: "#29343b",
        muted: "#69786f",
        border: "#dce3dc",
        active: "#edf2ed",
        selection: "#cbdff0",
        command: "#285c92",
        math: "#82478b",
        argument: "#855c24",
        comment: "#5b735e",
        punctuation: "#606d76",
        match: "#d9e9dd",
        search: "#f4e3ae",
        error: "#b3403b",
      }
  // VS Code's Modern editor surfaces, with token colors inherited from Plus.
  // https://github.com/microsoft/vscode/tree/main/extensions/theme-defaults/themes
  const colors = !vscode
    ? paper
    : opts.dark
      ? {
          background: "#1f1f1f",
          gutter: "#1f1f1f",
          text: "#cccccc",
          muted: "#6e7681",
          border: "#2b2b2b",
          active: "#292929",
          selection: "#264f78",
          command: "#dcdcaa",
          math: "#9cdcfe",
          argument: "#ce9178",
          comment: "#6a9955",
          punctuation: "#cccccc",
          match: "#3a3d41",
          search: "#6c4b0b",
          error: "#f48771",
        }
      : {
          background: "#ffffff",
          gutter: "#ffffff",
          text: "#3b3b3b",
          muted: "#6e7681",
          border: "#e5e5e5",
          active: "#f3f3f3",
          selection: "#add6ff",
          command: "#795e26",
          math: "#001080",
          argument: "#a31515",
          comment: "#008000",
          punctuation: "#3b3b3b",
          match: "#e5ebf1",
          search: "#f8d776",
          error: "#a1260d",
        }
  return [
    EditorView.theme(
      {
        "&": {
          height: "100%",
          backgroundColor: colors.background,
          color: colors.text,
          colorScheme: opts.dark ? "dark" : "light",
          "--latex-command": colors.command,
          "--latex-math": colors.math,
          "--latex-argument": colors.argument,
          "--latex-comment": colors.comment,
          "--latex-punctuation": colors.punctuation,
          "--latex-error": colors.error,
          "--latex-guide": opts.dark ? "#404040" : "#d3d3d3",
          "--latex-keyword": opts.dark ? "#569cd6" : "#0000ff",
          "--latex-control": opts.dark ? "#c586c0" : "#af00db",
          "--latex-type": opts.dark ? "#4ec9b0" : "#267f99",
          "--latex-number": opts.dark ? "#b5cea8" : "#098658",
          "--latex-strong": opts.dark ? "#569cd6" : "#000080",
          "--latex-emphasis": opts.dark ? "#c586c0" : "#800080",
        },
        ".cm-scroller": {
          fontFamily: typography(
            vscode && opts.typeface !== "aether"
              ? 'Consolas, Menlo, Monaco, "Liberation Mono", "DejaVu Sans Mono", monospace'
              : opts.font,
          ),
          fontSize: `${opts.size}px`,
          lineHeight: String({ compact: 1.5, normal: 1.7, wide: 1.9 }[opts.spacing]),
          overflow: "auto",
          scrollbarWidth: "thin",
          scrollbarColor: `${colors.border} transparent`,
        },
        ".cm-content": {
          padding: vscode ? "4px 0 160px" : "8px 0 160px",
          caretColor: colors.text,
          fontVariantLigatures: "none",
        },
        ".cm-line": { padding: vscode ? "0 10px" : "0 16px" },
        ".cm-gutters": {
          backgroundColor: colors.gutter,
          color: colors.muted,
          borderRight: vscode ? "1px solid transparent" : `1px solid ${colors.border}`,
        },
        ".cm-lineNumbers .cm-gutterElement": { minWidth: "2ch", padding: "0 8px 0 14px" },
        ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", cursor: "pointer" },
        ".cm-activeLineGutter": {
          color: vscode && !opts.dark ? "#171184" : colors.text,
          backgroundColor: vscode ? colors.gutter : colors.active,
        },
        ".cm-activeLine": {
          backgroundColor: vscode ? "transparent" : colors.active,
          boxShadow: vscode ? `inset 0 0 0 1px ${colors.border}` : "none",
        },
        "&:not(.cm-focused) .cm-activeLine": { backgroundColor: "transparent", boxShadow: "none" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: colors.text },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: colors.selection },
        ".cm-content ::selection, .cm-content::selection": { backgroundColor: colors.selection },
        ".cm-matchingBracket": { backgroundColor: colors.match, outline: `1px solid ${colors.comment}` },
        ".cm-nonmatchingBracket": { textDecoration: `underline wavy ${colors.error}` },
        ".cm-searchMatch": { backgroundColor: colors.search, outline: `1px solid ${colors.argument}` },
        ".cm-searchMatch.cm-searchMatch-selected": { outline: `2px solid ${colors.argument}` },
        ".cm-selectionMatch": { backgroundColor: colors.match },
        ".cm-foldPlaceholder": {
          color: colors.muted,
          backgroundColor: colors.gutter,
          border: `1px solid ${colors.border}`,
          borderRadius: vscode ? "2px" : "4px",
          padding: vscode ? "0 3px" : "0 5px",
          margin: "0 4px",
        },
        ".cm-latex-heading": { fontWeight: vscode ? "400" : "600" },
        ".cm-latex-bracket-0, .cm-latex-bracket-0 span": { color: opts.dark ? "#ffd700" : "#0431fa" },
        ".cm-latex-bracket-1, .cm-latex-bracket-1 span": { color: opts.dark ? "#da70d6" : "#267326" },
        ".cm-latex-bracket-2, .cm-latex-bracket-2 span": { color: opts.dark ? "#179fff" : "#7b3814" },
        ".cm-panels, .cm-tooltip": { color: colors.text, backgroundColor: colors.gutter },
      },
      { dark: opts.dark },
    ),
    syntaxHighlighting(vscode ? studio : highlight),
  ]
}
