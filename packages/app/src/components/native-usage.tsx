import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import type { NativeUsageStatus } from "@opencode-ai/sdk/v2/client"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

export function NativeUsage() {
  const sdk = useSDK()
  const sync = useGlobalSync()
  const language = useLanguage()
  const enabled = () => sync.ready && sync.data.config.native?.codex?.enabled !== false
  const scope = createMemo(() => `${sdk.url}\n${sync.data.config.native?.codex?.path ?? ""}`)
  const [state, setState] = createStore<{ data?: NativeUsageStatus; loading: boolean }>({ loading: false })
  let serial = 0

  const load = async (refresh = false) => {
    if (!enabled() || state.loading) return
    const request = ++serial
    const key = scope()
    setState("loading", true)
    try {
      const result = await sdk.client.native.usage({ refresh }, { throwOnError: true })
      if (request !== serial || key !== scope() || !enabled()) return
      setState("data", reconcile(result.data))
    } catch {
      if (request !== serial || key !== scope() || !enabled()) return
      setState("data", undefined)
    } finally {
      if (request === serial) setState("loading", false)
    }
  }

  createEffect(
    on([scope, enabled], () => {
      serial++
      setState({ data: undefined, loading: false })
      if (enabled()) void load()
    }),
  )
  onCleanup(() => serial++)

  const time = (value: number) => new Date(value).toLocaleString(language.intl())
  return (
    <section class="flex flex-col gap-2" data-component="native-usage">
      <div class="flex items-center justify-between gap-2">
        <span class="text-13-medium text-text-strong">{language.t("native.usage.title")}</span>
        <Button variant="ghost" size="small" onClick={() => void load(true)} disabled={!enabled() || state.loading}>
          {language.t(state.loading ? "native.usage.checking" : "native.usage.refresh")}
        </Button>
      </div>
      <p class="text-12-regular text-text-weak">{language.t("native.usage.description")}</p>
      <Show
        when={enabled() && state.data?.state !== "disabled"}
        fallback={
          <p class="text-12-regular text-text-weak">
            {language.t(sync.ready ? "native.usage.disabled" : "native.usage.checking")}
          </p>
        }
      >
        <Show
          when={state.data?.state === "available"}
          fallback={
            <p role="status" class="text-12-regular text-text-weak">
              {language.t(state.loading ? "native.usage.checking" : "native.usage.unavailable")}
            </p>
          }
        >
          <For each={state.data?.limits ?? []}>
            {(limit) => (
              <div class="rounded-md border border-border-base px-3 py-2 text-12-regular">
                <div class="text-text-strong">{limit.name || limit.id}</div>
                <For
                  each={(["primary", "secondary"] as const).flatMap((key) =>
                    limit[key] ? [{ key, value: limit[key]! }] : [],
                  )}
                >
                  {(window) => (
                    <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-text-weak">
                      <span>
                        {window.value.windowDurationMins === undefined
                          ? language.t(`native.usage.${window.key}`)
                          : language.t("native.usage.window", { minutes: window.value.windowDurationMins })}
                      </span>
                      <span>
                        {language.t("native.usage.remaining", {
                          value: Math.max(0, Math.min(100, 100 - window.value.usedPercent)),
                        })}
                      </span>
                      <span>
                        {window.value.resetsAt === undefined
                          ? language.t("native.usage.resetUnknown")
                          : language.t("native.usage.reset", { time: time(window.value.resetsAt * 1000) })}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </Show>
      <Show when={state.data?.updatedAt}>
        {(updated) => (
          <p class="text-11-regular text-text-weaker">
            {language.t("native.usage.updated", { time: time(updated()) })}
          </p>
        )}
      </Show>
    </section>
  )
}
