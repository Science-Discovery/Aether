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
  defaultHighlightStyle,
  bracketMatching,
  foldGutter,
} from "@codemirror/language"
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { oneDark } from "@codemirror/theme-one-dark"
import { python } from "@codemirror/lang-python"
import { javascript } from "@codemirror/lang-javascript"
import { css } from "@codemirror/lang-css"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"

function getLanguageExtension(filename: string) {
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
      syntaxHighlighting(defaultHighlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap, indentWithTab]),
      oneDark,
      editableCompartment.of(EditorView.editable.of(!props.disabled)),
      wrapCompartment.of(props.wordWrap ? EditorView.lineWrapping : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          props.onChange(update.state.doc.toString())
        }
      }),
      EditorView.theme({
        "&": { height: "100%", fontSize: "13px" },
        ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)" },
        ".cm-content": { padding: "8px 0" },
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
