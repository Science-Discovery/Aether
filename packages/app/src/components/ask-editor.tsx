import { Show, createEffect, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"

export type AskAnchor = { top: number; left: number; bottom: number; right: number }

export type AskEditorProps = {
  title: string
  preview: string
  image?: string
  question?: string
  anchor: AskAnchor
  editing?: boolean
  onSave: (question: string) => void
  onCancel: () => void
}

export function AskEditor(props: AskEditorProps) {
  const language = useLanguage()
  const [state, setState] = createStore({ question: props.question ?? "", top: 0, left: 0 })
  let card: HTMLFormElement | undefined
  let input: HTMLTextAreaElement | undefined
  let composing = false
  const position = () => {
    if (!card) return
    const rect = card.getBoundingClientRect()
    const below = props.anchor.bottom + 8
    setState({
      top: Math.max(
        8,
        Math.min(
          below + rect.height <= window.innerHeight - 8 ? below : props.anchor.top - rect.height - 8,
          window.innerHeight - rect.height - 8,
        ),
      ),
      left: Math.max(8, Math.min(props.anchor.left, window.innerWidth - rect.width - 8)),
    })
  }
  createEffect(() => {
    props.anchor
    position()
  })
  onMount(() => {
    position()
    input?.focus({ preventScroll: true })
    const observer = new ResizeObserver(position)
    if (card) observer.observe(card)
    window.addEventListener("resize", position)
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", position)
    })
  })
  return (
    <Portal>
      <form
        ref={card}
        role="dialog"
        aria-label={props.title}
        data-component="ask-editor"
        class="fixed z-[250] flex w-[300px] max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] flex-col gap-3 overflow-y-auto rounded-xl border border-border-base bg-background-base p-3 text-text-base shadow-xl"
        style={{ top: `${state.top}px`, left: `${state.left}px` }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!composing) props.onSave(state.question.trim())
        }}
        onKeyDown={(event) => {
          if (composing || event.isComposing || event.keyCode === 229) return
          if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            props.onCancel()
          }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            props.onSave(state.question.trim())
          }
        }}
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-13-medium">{props.title}</span>
          <button
            type="button"
            class="rounded p-1 text-text-weak hover:bg-surface-base-hover"
            aria-label={language.t("common.close")}
            onClick={props.onCancel}
          >
            <Icon name="close" size="small" />
          </button>
        </div>
        <Show
          when={props.image}
          fallback={
            <div class="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-surface-base p-2 text-12-regular text-text-weak">
              {props.preview}
            </div>
          }
        >
          <img src={props.image} alt={props.preview} class="max-h-32 w-full rounded-md object-contain" />
        </Show>
        <textarea
          ref={input}
          value={state.question}
          aria-label={language.t("ask.reference.question")}
          placeholder={language.t("ask.editor.placeholder")}
          class="min-h-24 w-full shrink-0 resize-y rounded-lg border border-border-base bg-surface-base p-2 text-13-regular outline-none focus:border-border-active focus:ring-1 focus:ring-border-active"
          onInput={(event) => setState("question", event.currentTarget.value)}
          onCompositionStart={() => (composing = true)}
          onCompositionEnd={() => (composing = false)}
        />
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="rounded-md px-3 py-1.5 text-12-medium text-text-weak hover:bg-surface-base-hover"
            onClick={props.onCancel}
          >
            {language.t("common.cancel")}
          </button>
          <button
            type="submit"
            class="rounded-md bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-strong hover:bg-surface-base-hover"
          >
            {language.t(props.editing ? "ask.editor.update" : "ask.editor.save")}
          </button>
        </div>
      </form>
    </Portal>
  )
}
