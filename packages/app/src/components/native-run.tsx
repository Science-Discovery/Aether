import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import type { createNativeRun } from "@/context/native-run"

export function NativeRunPanel(props: {
  run: ReturnType<typeof createNativeRun>
  working: boolean
  disabled?: boolean
}) {
  const language = useLanguage()
  const queue = () => props.run.data()?.queue
  const notice = () => {
    const value = props.run.notice()
    return value?.type === "accepted" ? undefined : value
  }
  return (
    <div class="flex flex-col gap-1 px-3 py-1 text-12-regular text-text-weak" data-component="native-run">
      <Show when={props.working || props.run.data()?.active || props.run.retry()}>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={props.working || props.run.data()?.active}>
            <span role="status">{language.t(`native.run.${props.run.data()?.active?.phase ?? "checking"}`)}</span>
          </Show>
          <Show when={props.run.retry()}>
            <Button size="small" variant="ghost" disabled={props.disabled} onClick={() => void props.run.recover()}>
              {language.t("native.run.recover")}
            </Button>
            <Button size="small" variant="ghost" onClick={() => props.run.discard()}>
              {language.t("native.run.discard")}
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={props.run.unconfirmed()}>
        {(id) => (
          <div class="flex flex-wrap items-center gap-2" role="status">
            <span>{language.t("native.queue.unconfirmed")}</span>
            <Button
              size="small"
              variant="ghost"
              disabled={props.disabled || props.run.busy()}
              onClick={() => void props.run.send(id())}
            >
              {language.t("native.queue.check")}
            </Button>
          </div>
        )}
      </Show>
      <Show when={props.run.error() || props.run.data()?.active?.error}>
        {(error) => <div role="status">{language.t("native.run.unavailable", { error: error() })}</div>}
      </Show>
      <Show when={notice()}>
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
              <Button
                size="small"
                variant="ghost"
                disabled={props.disabled || props.run.busy()}
                onClick={() => void props.run.resume()}
              >
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
                    <Show when={item.attachments?.length}>
                      <div
                        class="truncate"
                        title={item.attachments
                          ?.map((file) => file.filename ?? language.t("common.attachment"))
                          .join(", ")}
                      >
                        {item.attachments?.map((file) => file.filename ?? language.t("common.attachment")).join(", ")}
                      </div>
                    </Show>
                    <div class="break-words">
                      {language.t(`native.queue.${item.state}`)}
                      <Show when={item.error}> · {item.error}</Show>
                    </div>
                  </div>
                  <Show when={item.state === "pending" && props.run.data()?.active?.steer}>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={props.disabled || props.run.busy() || !!props.run.unconfirmed()}
                      data-action="native-queue-send"
                      onClick={() => void props.run.send(item.id)}
                    >
                      {language.t("native.queue.send")}
                    </Button>
                  </Show>
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
