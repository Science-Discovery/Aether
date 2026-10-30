import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import type { useLatexReading } from "@/pages/session/use-latex-reading"

export function LatexReadingToolbar(props: {
  reading: ReturnType<typeof useLatexReading>
  download: () => Promise<void>
  collapsed?: boolean
  embedded?: boolean
}) {
  const language = useLanguage()
  const status = () =>
    props.reading.updating()
      ? language.t("latex.preview.updating")
      : props.reading.outdated()
        ? language.t("latex.preview.stale")
        : language.t("latex.preview")
  return (
    <Show when={!props.collapsed || props.reading.slow() || props.reading.state.error}>
      <div
        class="flex flex-col gap-1 border-b border-border-base px-3 py-2 text-12-regular"
        data-component="latex-reading-toolbar"
      >
        <Show when={!props.collapsed}>
          <div class="flex flex-wrap items-center gap-2">
            <span
              class="shrink-0"
              classList={{ "w-28 truncate": !props.embedded }}
              title={props.reading.outdated() ? language.t("latex.preview.outdated") : status()}
            >
              {props.embedded ? language.t("latex.preview") : status()}
            </span>
            <select
              class="min-w-0 max-w-full flex-1 basis-40 rounded border border-border-base bg-surface-base px-2 py-1"
              aria-label={language.t("latex.preview.versions")}
              value={props.reading.state.selected}
              onChange={(event) => props.reading.select(event.currentTarget.value)}
            >
              <option value="">{language.t("latex.preview.latest")}</option>
              <For each={props.reading.state.versions}>
                {(item) => (
                  <option value={item.build.id}>
                    {new Date(item.build.completedAt ?? item.build.createdAt).toLocaleString(language.intl())}
                    {item.annotationCount
                      ? ` · ${language.t("latex.preview.annotated")} (${item.annotationCount})`
                      : ""}
                  </option>
                )}
              </For>
            </select>
            <Button
              size="small"
              variant="ghost"
              disabled={!props.reading.state.displayed}
              title={props.reading.outdated() ? language.t("latex.preview.outdated") : undefined}
              onClick={() => {
                if (props.reading.outdated())
                  showToast({
                    title: language.t("latex.preview.export"),
                    description: language.t("latex.preview.outdated"),
                  })
                void props.download().catch((error: unknown) =>
                  showToast({
                    variant: "error",
                    title: language.t("common.requestFailed"),
                    description: String(error),
                  }),
                )
              }}
            >
              {language.t("latex.preview.export")}
            </Button>
          </div>
        </Show>
        <Show when={props.reading.slow()}>
          <p role="status" class="text-text-weak">
            {language.t("latex.preview.waiting")}
          </p>
        </Show>
        <Show when={props.reading.state.error}>
          <p role="alert" class="text-text-danger">
            {props.reading.state.error}
          </p>
        </Show>
      </div>
    </Show>
  )
}
