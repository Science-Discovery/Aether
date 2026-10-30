import { Index, Show, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { formatReadingPageRange } from "@/utils/comment-note"
import type { QuoteReference } from "@/utils/conversation-quote-metadata"

export function MessageReferences(props: {
  references: readonly QuoteReference[]
  onSelect: (reference: QuoteReference) => void
}) {
  const language = useLanguage()
  return (
    <section
      data-component="message-references"
      class="ml-auto w-[320px] max-w-full min-w-0 rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2"
      aria-label={language.t("ask.reference.group", { count: props.references.length })}
    >
      <div class="text-11-medium text-text-weak">
        {language.t("ask.reference.group", { count: props.references.length })}
      </div>
      <div
        data-scrollable
        class="mt-2 flex max-h-[172px] min-w-0 flex-col gap-2 overflow-y-auto overscroll-y-contain pr-1"
      >
        <Index each={props.references}>
          {(ref, index) => {
            const pdf = createMemo(() => {
              const value = ref()
              return value.kind === "pdf" ? value.quote : undefined
            })
            return (
              <button
                type="button"
                class="w-full min-w-0 shrink-0 rounded-[5px] border border-border-weak-base bg-background-base px-2 py-1.5 text-left transition hover:bg-surface-base-hover focus-visible:outline-1 focus-visible:outline-border-active"
                onClick={() => props.onSelect(ref())}
              >
                <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-11-medium text-text-weak">
                  <span class="shrink-0">
                    {language.t("ask.reference.title", { number: ref().quote.order ?? index + 1 })}
                  </span>
                  <span class="min-w-0 flex-1 truncate">
                    {pdf()?.pdfFileName ?? language.t("ask.reference.conversation")}
                  </span>
                  <Show when={pdf()}>
                    {(value) => <span class="shrink-0">p.{formatReadingPageRange(value())}</span>}
                  </Show>
                  <Show when={pdf()?.action === "translate"}>
                    <span class="shrink-0">{language.t("pdf.selection.translate")}</span>
                  </Show>
                </div>
                <div class="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-12-regular text-text-strong [overflow-wrap:anywhere]">
                  {ref().quote.summary}
                </div>
              </button>
            )
          }}
        </Index>
      </div>
    </section>
  )
}
