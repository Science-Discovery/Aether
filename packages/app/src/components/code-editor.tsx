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
])

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
  initialScroll?: { x: number; y: number }
  /** 进入编辑模式时从预览中提取的文本锚点，编辑器挂载后滚动到该文本 */
  initialAnchorText?: string
  /** 文本锚点未找到时的 fallback 滚动比例（0-1） */
  initialScrollRatio?: number
  onScroll?: (pos: { x: number; y: number }) => void
  /** 卸载时回调：中心行文本（用于切回预览时定位）和滚动比例（fallback） */
  onUnmount?: (centerText: string, ratio: number) => void
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
      padding: "0 0 160px 0",
      caretColor: "var(--text-base)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono, 'Fira Code', Consolas, monospace)",
      overflow: "auto",
      scrollbarWidth: "thin",
      scrollbarColor: "var(--border-weak-base) transparent",
    },
    ".cm-scroller::-webkit-scrollbar": {
      width: "12px",
      height: "12px",
    },
    ".cm-scroller::-webkit-scrollbar-track": {
      backgroundColor: "transparent",
    },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      border: "4px solid transparent",
      borderRadius: "9999px",
      backgroundClip: "padding-box",
      backgroundColor: "var(--border-weak-base)",
    },
    ".cm-scroller::-webkit-scrollbar-thumb:hover": {
      backgroundColor: "var(--border-strong-base)",
    },
    ".cm-line": {
      color: "var(--syntax-punctuation)",
      fontFamily: "var(--font-family-mono)",
      fontSize: "var(--font-size-small)",
      lineHeight: "24px",
      padding: "0 1ch !important",
    },
    ".cm-gutters": {
      backgroundColor: "var(--background-stronger)",
      color: "var(--text-weak)",
      fontFamily: "var(--font-family-mono)",
      fontSize: "var(--font-size-small)",
      borderRight: "none",
    },
    ".cm-gutterElement": {
      padding: "0 1ch 0 2ch !important",
      minWidth: "4ch !important",
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      boxSizing: "content-box",
      borderRight: "2px solid transparent",
    },
    ".cm-foldGutter": {
      display: "none !important",
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

    const scroller = container.querySelector(".cm-scroller") as HTMLElement | null
    let frame: number | undefined
    let next: { x: number; y: number } | undefined

    const flush = () => {
      frame = undefined
      const pos = next
      next = undefined
      if (!pos) return
      props.onScroll?.(pos)
    }

    const report = () => {
      if (!scroller) return
      next = { x: scroller.scrollLeft, y: scroller.scrollTop }
      if (frame !== undefined) return
      frame = requestAnimationFrame(flush)
    }

    scroller?.addEventListener("scroll", report, { passive: true })
    onCleanup(() => {
      if (scroller) {
        props.onScroll?.({ x: scroller.scrollLeft, y: scroller.scrollTop })
      }
      scroller?.removeEventListener("scroll", report)
      if (frame !== undefined) cancelAnimationFrame(frame)
    })

    // 等内容渲染完毕后，滚动到对应位置
    if (
      props.initialAnchorText ||
      (props.initialScrollRatio != null && props.initialScrollRatio > 0) ||
      props.initialScroll
    ) {
      requestAnimationFrame(() => {
        if (!view) return

        // 优先：在文档中搜索锚点文本，滚动到对应行（居中）
        if (props.initialAnchorText) {
          const content = view.state.doc.toString()
          const idx = content.indexOf(props.initialAnchorText)
          if (idx >= 0) {
            view.dispatch({ effects: EditorView.scrollIntoView(idx, { y: "center" }) })
            return
          }
        }

        if (scroller && props.initialScroll) {
          if (scroller.scrollLeft !== props.initialScroll.x) scroller.scrollLeft = props.initialScroll.x
          if (scroller.scrollTop !== props.initialScroll.y) scroller.scrollTop = props.initialScroll.y
          return
        }

        // Fallback：按比例定位
        if (scroller && props.initialScrollRatio != null && props.initialScrollRatio > 0) {
          const maxScroll = scroller.scrollHeight - scroller.clientHeight
          if (maxScroll > 0) scroller.scrollTop = props.initialScrollRatio * maxScroll
        }
      })
    }
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
    if (props.onUnmount) {
      const scroller = container.querySelector(".cm-scroller") as HTMLElement | null
      const maxScroll = scroller ? scroller.scrollHeight - scroller.clientHeight : 0
      const ratio = scroller && maxScroll > 0 ? scroller.scrollTop / maxScroll : 0

      // 从视口中心找最近的普通文本行（跳过纯 LaTeX 行），作为切回预览时的锚点
      const centerText = (() => {
        if (!scroller) return ""
        const scrollRect = scroller.getBoundingClientRect()
        const centerScreenY = scrollRect.top + scroller.clientHeight / 2
        const lines = Array.from(container.querySelectorAll(".cm-line"))

        // 找距中心最近的行
        let bestIdx = -1
        let bestDist = Infinity
        for (let i = 0; i < lines.length; i++) {
          const r = lines[i].getBoundingClientRect()
          if (r.height === 0) continue
          const dist = Math.abs((r.top + r.bottom) / 2 - centerScreenY)
          if (dist < bestDist) { bestDist = dist; bestIdx = i }
        }
        if (bestIdx < 0) return ""

        // 从中心行向外找第一个"普通文本行"（跳过 LaTeX/空行）
        const isLatexLine = (text: string) => {
          const t = text.trim()
          return t === "" || t === "$$" || t === "$" || t.startsWith("\\") || t.startsWith("$$")
        }
        for (let d = 0; d <= 10; d++) {
          for (const delta of d === 0 ? [0] : [-d, d]) {
            const line = lines[bestIdx + delta]
            if (!line) continue
            const text = line.textContent?.trim() ?? ""
            if (text.length >= 15 && !isLatexLine(text)) return text.slice(0, 35)
          }
        }
        return ""
      })()

      props.onUnmount(centerText, ratio)
    }
    view?.destroy()
    view = undefined
  })

  return <div ref={container} class="h-full min-h-0 flex-1 overflow-hidden" />
}
