import { createEffect, onCleanup, onMount } from "solid-js"
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view"
import { Compartment, EditorState } from "@codemirror/state"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import {
  syntaxHighlighting,
  bracketMatching,
  foldGutter,
  HighlightStyle,
} from "@codemirror/language"
import { tags as t } from "@lezer/highlight" 
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { python } from "@codemirror/lang-python"
import { javascript } from "@codemirror/lang-javascript"
import { css } from "@codemirror/lang-css"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"

const customHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syntax-keyword)" },
  { tag: t.operator, color: "var(--syntax-operator)" },
  { tag: t.variableName, color: "var(--syntax-variable)" },
  { tag: [t.propertyName, t.labelName], color: "var(--syntax-primitive)" },
  { tag: [t.string, t.character], color: "var(--syntax-string)" },
  { tag: t.regexp, color: "var(--syntax-constant)" },
  { tag: t.number, color: "var(--syntax-constant)" },
  { tag: t.bool, color: "var(--syntax-constant)" },
  { tag: t.null, color: "var(--syntax-constant)" },
  { tag: t.atom, color: "var(--syntax-constant)" },
  { tag: t.comment, color: "var(--syntax-comment)" },
  { tag: t.meta, color: "var(--syntax-primitive)" },
  { tag: t.tagName, color: "var(--syntax-primitive)" },
  { tag: t.attributeName, color: "var(--syntax-primitive)" },
  { tag: t.function(t.variableName), color: "var(--syntax-primitive)" },
  { tag: t.className, color: "var(--syntax-primitive)" },
  { tag: t.typeName, color: "var(--syntax-primitive)" },
  { tag: t.escape, color: "var(--syntax-constant)" },
  { tag: t.link, color: "var(--text-interactive-base)", textDecoration: "underline" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  // Markdown-specific highlighting
  { tag: t.heading, color: "var(--text-strong)", fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold", color: "var(--text-strong)" },
  { tag: t.monospace, color: "var(--syntax-string)", fontFamily: "var(--font-family-mono)" },
  { tag: t.url, color: "var(--text-interactive-base)", textDecoration: "underline" },
  { tag: t.special(t.string), color: "var(--syntax-string)" },
])

export function getLanguageExtension(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  switch (ext) {
    case "py":
    case "pyi":
      return python()
    case "js":
    case "mjs":
    case "cjs":
      return javascript()
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true })
    case "tsx":
    case "jsx":
      return javascript({ jsx: true, typescript: ext === "tsx" })
    case "css":
    case "scss":
    case "sass":
      return css()
    case "json":
    case "jsonc":
      return json()
    case "md":
    case "mdx":
    case "markdown":
      return markdown()
    default:
      return null
  }
}

export function CodeEditor(props: {
  content: string
  filename: string
  onChange: (value: string) => void
  disabled?: boolean
  wordWrap?: boolean
}) {
  let container!: HTMLDivElement
  let view: EditorView | undefined
  const editableCompartment = new Compartment()
  const wrapCompartment = new Compartment()

  const editorTheme = EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "14px",
      backgroundColor: "var(--background-stronger)",
      color: "var(--text-base)",
    },
    ".cm-content": {
      backgroundColor: "var(--background-stronger)",
      fontFamily: "var(--font-family-mono)",
      fontSize: "var(--font-size-small)",
      lineHeight: "24px",
      padding: "0",
      caretColor: "var(--text-base)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono, 'Fira Code', Consolas, monospace)",
      overflow: "auto",
    },
    ".cm-line": {
      color: "var(--syntax-punctuation)",
      fontFamily: "var(--font-family-mono)",
      fontSize: "var(--font-size-small)",
      lineHeight: "24px",
    },
    ".cm-gutters": {
      backgroundColor: "var(--background-stronger)",
      color: "var(--text-weak)",
      fontFamily: "var(--font-family-mono)",
      fontSize: "var(--font-size-small)",
      borderRight: "1px solid var(--border-base)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--surface-base-hover)",
      color: "var(--text-base)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--surface-base-hover)",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--text-base)",
    },
    ".cm-matchhighlight": {
      backgroundColor: "rgba(128, 128, 128, 0.2)",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(255, 255, 0, 0.3)",
      outline: "1px solid rgba(255, 255, 0, 0.5)",
    },
    ".cm-selectionBackground, .cm-focused .cm-selectionBackground": {
      background: "var(--diffs-bg-selection) !important",
    },
  })

  onMount(() => {
    const lang = getLanguageExtension(props.filename)

    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      foldGutter(),
      bracketMatching(),
      closeBrackets(),
      syntaxHighlighting(customHighlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap, indentWithTab]),
      editorTheme,
      editableCompartment.of(EditorView.editable.of(!props.disabled)),
      wrapCompartment.of(props.wordWrap ? EditorView.lineWrapping : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          props.onChange(update.state.doc.toString())
        }
      }),
    ]

    if (lang) extensions.push(lang)

    view = new EditorView({
      state: EditorState.create({
        doc: props.content,
        extensions,
      }),
      parent: container,
    })
  })

  createEffect(() => {
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== props.content) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: props.content },
      })
    }
  })

  createEffect(() => {
    if (!view) return
    view.dispatch({ effects: editableCompartment.reconfigure(EditorView.editable.of(!props.disabled)) })
  })

  createEffect(() => {
    if (!view) return
    view.dispatch({ effects: wrapCompartment.reconfigure(props.wordWrap ? EditorView.lineWrapping : []) })
  })

  onCleanup(() => {
    view?.destroy()
    view = undefined
  })

  return <div ref={container} class="h-full min-h-0 flex-1 overflow-hidden" />
}
