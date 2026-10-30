import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { tags as t } from "@lezer/highlight"

export type WritingStyle = {
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

export function writing(opts: WritingStyle) {
  const colors = opts.dark
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
        },
        ".cm-scroller": {
          fontFamily: typography(opts.font),
          fontSize: `${opts.size}px`,
          lineHeight: String({ compact: 1.5, normal: 1.7, wide: 1.9 }[opts.spacing]),
          overflow: "auto",
          scrollbarWidth: "thin",
          scrollbarColor: `${colors.border} transparent`,
        },
        ".cm-content": {
          padding: "8px 0 160px",
          caretColor: colors.text,
          fontVariantLigatures: "none",
        },
        ".cm-line": { padding: "0 16px" },
        ".cm-gutters": {
          backgroundColor: colors.gutter,
          color: colors.muted,
          borderRight: `1px solid ${colors.border}`,
        },
        ".cm-lineNumbers .cm-gutterElement": { minWidth: "2ch", padding: "0 8px 0 14px" },
        ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", cursor: "pointer" },
        ".cm-activeLineGutter": { color: colors.text, backgroundColor: colors.active },
        ".cm-activeLine": { backgroundColor: colors.active },
        "&:not(.cm-focused) .cm-activeLine": { backgroundColor: "transparent" },
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
          borderRadius: "4px",
          padding: "0 5px",
          margin: "0 4px",
        },
        ".cm-latex-heading": { fontWeight: "600" },
        ".cm-panels, .cm-tooltip": { color: colors.text, backgroundColor: colors.gutter },
      },
      { dark: opts.dark },
    ),
    syntaxHighlighting(highlight),
  ]
}
