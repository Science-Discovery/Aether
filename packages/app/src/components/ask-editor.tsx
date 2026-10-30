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

let owner: (() => void) | undefined

export function AskEditor(props: AskEditorProps) {
  const language = useLanguage()
  const [state, setState] = createStore({ question: props.question ?? "", top: 0, left: 0, open: true })
  let card: HTMLFormElement | undefined
  let input: HTMLTextAreaElement | undefined
  let composing = false
  let cleanup = () => {}
  const close = () => {
    if (!state.open) return false
    cleanup()
    if (owner === cancel) owner = undefined
    setState("open", false)
    return true
  }
  const cancel = () => {
    if (close()) props.onCancel()
  }
  const save = () => {
    if (!composing && close()) props.onSave(state.question.trim())
  }
  const position = () => {
    if (!state.open || !card) return
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
  const resize = () => {
    if (!state.open || !input) return
    const style = getComputedStyle(input)
    const line = Number.parseFloat(style.lineHeight) || 20
    const padding = (Number.parseFloat(style.paddingTop) || 4) + (Number.parseFloat(style.paddingBottom) || 4)
    input.style.height = "0px"
    const limit = line * 4 + padding
    const content = state.question ? input.scrollHeight : line + padding
    const height = Math.max(line + padding, Math.min(content, limit))
    input.style.height = `${height}px`
    input.style.overflowY = content > limit ? "auto" : "hidden"
    position()
  }
  createEffect(() => {
    props.anchor
    position()
  })
  onMount(() => {
    const previous = owner
    owner = cancel
    previous?.()
    if (owner !== cancel || !state.open) return
    resize()
    input?.focus({ preventScroll: true })
    const observer = new ResizeObserver(resize)
    if (card) observer.observe(card)
    window.addEventListener("resize", resize)
    cleanup = () => {
      observer.disconnect()
      window.removeEventListener("resize", resize)
    }
  })
  onCleanup(() => {
    cleanup()
    if (owner === cancel) owner = undefined
  })
  return (
    <Show when={state.open}>
      <Portal>
        <form
          ref={card}
          role="dialog"
          aria-label={props.title}
          data-component="ask-editor"
          class="fixed z-[250] flex w-[320px] max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] items-start gap-1.5 overflow-y-auto rounded-[16px] border border-border-base bg-background-base p-2 font-sans text-text-base shadow-md"
          style={{ top: `${state.top}px`, left: `${state.left}px` }}
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
          onKeyDown={(event) => {
            if (composing || event.isComposing || event.keyCode === 229) return
            if (event.key === "Escape") {
              event.preventDefault()
              event.stopPropagation()
              cancel()
            }
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              event.stopPropagation()
              save()
            }
          }}
        >
          <textarea
            ref={input}
            rows={1}
            value={state.question}
            aria-label={language.t("ask.reference.question")}
            placeholder={language.t("ask.editor.placeholder")}
            class="min-h-7 min-w-0 flex-1 resize-none rounded-lg bg-transparent px-2 py-1 text-13-regular leading-5 outline-none placeholder:whitespace-nowrap placeholder:text-text-weak focus-visible:ring-1 focus-visible:ring-border-active"
            onInput={(event) => {
              setState("question", event.currentTarget.value)
              resize()
            }}
            onCompositionStart={() => (composing = true)}
            onCompositionEnd={() => (composing = false)}
          />
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="submit"
              class="flex size-7 items-center justify-center rounded-full bg-icon-base text-background-base hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-active"
              aria-label={language.t(props.editing ? "ask.editor.update" : "ask.editor.save")}
              title={language.t(props.editing ? "ask.editor.update" : "ask.editor.save")}
            >
              <Icon name="check" size="small" class="text-background-base" />
            </button>
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded-full text-text-weak hover:bg-surface-base-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-active"
              aria-label={language.t("common.cancel")}
              title={language.t("common.close")}
              onClick={cancel}
            >
              <Icon name="close-small" size="small" />
            </button>
          </div>
        </form>
      </Portal>
    </Show>
  )
}
