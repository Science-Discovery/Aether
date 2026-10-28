import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { useLanguage } from "@/context/language"
import type { createNativeRun, NativeAction } from "@/context/native-run"

export function NativeRunPanel(props: {
  run: ReturnType<typeof createNativeRun>
  working: boolean
  action: NativeAction
  select: (value: NativeAction) => void
}) {
  const language = useLanguage()
  const queue = () => props.run.data()?.queue
  return (
    <div class="flex flex-col gap-1 px-3 py-1 text-12-regular text-text-weak" data-component="native-run">
      <Show when={props.working || props.run.data()?.active || props.run.retry()}>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={props.working || props.run.data()?.active}>
            <span role="status">{language.t(`native.run.${props.run.data()?.active?.phase ?? "checking"}`)}</span>
          </Show>
          <Select<NativeAction>
            options={props.run.data()?.active?.steer || props.run.retry() === "steer" ? ["steer", "queue"] : ["queue"]}
            current={props.action}
            label={(value) => language.t(`native.run.action.${value}`)}
            onSelect={(value) => value && props.select(value)}
            disabled={props.run.busy() || !!props.run.retry()}
            variant="ghost"
            size="small"
            triggerProps={{ "data-action": "prompt-native-action", "aria-label": language.t("native.run.action") }}
          />
          <Show when={props.run.retry()}>
            <Button size="small" variant="ghost" onClick={() => props.run.discard()}>
              {language.t("native.run.discard")}
            </Button>
          </Show>
          <span>{language.t("native.run.textOnly.hint")}</span>
        </div>
      </Show>
      <Show when={props.run.error() || props.run.data()?.active?.error}>
        {(error) => <div role="status">{language.t("native.run.unavailable", { error: error() })}</div>}
      </Show>
      <Show when={props.run.notice()}>
        {(notice) => (
          <div role="status" class="break-words">
            {language.t(`native.run.notice.${notice().type}`)}
            <Show when={notice().text}>
              <span> {notice().text}</span>
            </Show>
          </div>
        )}
      </Show>
      <Show when={queue()?.items.length}>
        <div class="rounded-md border border-border-base px-2 py-1">
          <div class="flex items-center justify-between gap-2">
            <span>{language.t("native.queue.title", { count: queue()!.items.length })}</span>
            <Show when={queue()?.paused && queue()?.items.some((item) => item.state === "pending")}>
              <Button size="small" variant="ghost" disabled={props.run.busy()} onClick={() => void props.run.resume()}>
                {language.t("native.queue.resume")}
              </Button>
            </Show>
          </div>
          <Show when={queue()?.paused}>
            <div role="status" class="break-words">
              {language.t("native.queue.paused")} {queue()?.reason}
            </div>
          </Show>
          <div class="max-h-40 overflow-y-auto">
            <For each={queue()?.items}>
              {(item) => (
                <div class="flex items-start gap-2 py-1" data-queue-state={item.state}>
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-text-base" title={item.text}>
                      {item.text}
                    </div>
                    <div class="break-words">
                      {language.t(`native.queue.${item.state}`)}
                      <Show when={item.error}> · {item.error}</Show>
                    </div>
                  </div>
                  <Show when={item.state !== "dispatching"}>
                    <IconButton
                      icon="close"
                      size="small"
                      variant="ghost"
                      disabled={props.run.busy()}
                      aria-label={language.t("native.queue.remove")}
                      onClick={() => void props.run.remove(item.id)}
                    />
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
