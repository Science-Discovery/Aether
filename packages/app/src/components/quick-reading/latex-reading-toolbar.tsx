import { createMemo, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
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
  const versions = createMemo(() => ["latest", ...props.reading.state.versions.map((item) => item.build.id)])
  const versionLabel = (value: string) => {
    if (value === "latest") return language.t("latex.preview.latest")
    const item = props.reading.state.versions.find((entry) => entry.build.id === value)
    if (!item) return value
    return `${new Date(item.build.completedAt ?? item.build.createdAt).toLocaleString(language.intl())}${
      item.annotationCount ? ` · ${language.t("latex.preview.annotated")} (${item.annotationCount})` : ""
    }`
  }
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
            <div class="min-w-0 flex-1 basis-40">
              <select
                aria-hidden="true"
                tabIndex={-1}
                class="sr-only"
                aria-label={language.t("latex.preview.versions")}
                value={props.reading.state.selected}
                onChange={(event) => props.reading.select(event.currentTarget.value)}
              >
                <option value="">{language.t("latex.preview.latest")}</option>
                <For each={props.reading.state.versions}>
                  {(item) => <option value={item.build.id}>{versionLabel(item.build.id)}</option>}
                </For>
              </select>
              <Select
                options={versions()}
                current={props.reading.state.selected || "latest"}
                value={(value) => value}
                label={(value) => versionLabel(value)}
                onSelect={(value) => props.reading.select(!value || value === "latest" ? "" : value)}
                size="small"
                variant="secondary"
                triggerVariant="settings"
                triggerStyle={{ width: "100%" }}
                triggerProps={{
                  "aria-label": language.t("latex.preview.versions"),
                  "data-action": "latex-version",
                }}
              />
            </div>
            <Button
              size="small"
              variant="ghost"
              data-action="latex-export"
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
