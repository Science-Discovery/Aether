import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { NativeMcpStatus } from "@opencode-ai/sdk/v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"

export function NativeMcp() {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore<{ data?: NativeMcpStatus; busy: boolean; error?: string }>({ busy: false })
  let revision = 0
  let disposed = false
  const key = () => `${sdk.url}\n${sdk.directory}`
  const auth = (value: string) => {
    if (value === "unsupported") return language.t("native.mcp.auth.unsupported")
    if (value === "bearerToken") return language.t("native.mcp.auth.token")
    if (value === "oAuth") return language.t("native.mcp.auth.oauth")
    if (value === "notLoggedIn") return language.t("native.mcp.auth.required")
    if (value === "unknown") return language.t("native.mcp.auth.unknown")
    return value
  }
  async function refresh(force = false) {
    const scope = key()
    const stamp = ++revision
    setState({ busy: true, error: undefined, data: undefined })
    await sdk.client.native
      .mcp({ refresh: force }, { throwOnError: true })
      .then((result) => {
        if (disposed || stamp !== revision || scope !== key()) return
        if (!result.data) throw new Error(language.t("native.question.noResult"))
        setState({ data: result.data, error: result.data.error })
      })
      .catch((err: unknown) => {
        if (!disposed && stamp === revision && scope === key())
          setState("error", err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!disposed && stamp === revision && scope === key()) setState("busy", false)
      })
  }
  createEffect(on(key, () => void refresh()))
  onCleanup(() => {
    disposed = true
    revision++
  })
  return (
    <Dialog title={language.t("native.slash.mcp")}>
      <div class="p-4 flex flex-col gap-3 overflow-y-auto max-h-[70vh]">
        <p class="text-12-regular text-text-weak">{language.t("native.mcp.description")}</p>
        <Button size="small" variant="secondary" disabled={state.busy} onClick={() => void refresh(true)}>
          {language.t(state.busy ? "common.loading" : "native.mcp.refresh")}
        </Button>
        <Show when={state.error}>
          {(error) => (
            <div role="alert" class="break-words">
              {error()}
            </div>
          )}
        </Show>
        <Show when={!state.busy && !state.error && !state.data?.servers.length}>
          <div>{language.t(state.data?.state === "disabled" ? "native.disabledShort" : "native.mcp.empty")}</div>
        </Show>
        <For each={state.data?.servers}>
          {(server) => (
            <section class="rounded-md border border-border-base p-3 flex flex-col gap-2">
              <strong>{server.name}</strong>
              <div class="text-12-regular text-text-weak">
                {language.t("native.mcp.connection")}:{" "}
                {server.status === "unknown" ? language.t("native.mcp.unknown") : server.status} ·{" "}
                {language.t("native.mcp.auth")}: {auth(server.auth)}
              </div>
              <Show when={server.error}>
                {(error) => (
                  <div role="alert" class="break-words">
                    {error()}
                  </div>
                )}
              </Show>
              <For each={server.tools}>
                {(tool) => (
                  <div class="text-12-regular">
                    <span class="font-medium">{tool.name}</span>
                    <p class="text-text-weak whitespace-pre-wrap">{tool.description}</p>
                  </div>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  )
}
