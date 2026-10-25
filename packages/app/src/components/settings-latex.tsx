import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { LatexStatus } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"

export function SettingsLatex() {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()
  let epoch = 0
  const [state, setState] = createStore({
    tectonic: "",
    latexmk: "",
    busy: false,
    error: "",
    saved: false,
    status: undefined as LatexStatus | undefined,
  })
  const error = (cause: unknown) => setState("error", formatServerError(cause, language.t))
  const refresh = async () => {
    const version = epoch
    const result = await sdk.client.latex.status({}, { throwOnError: true }).catch((cause: unknown) => {
      if (version === epoch) throw cause
    })
    if (version === epoch) setState("status", result?.data)
  }
  createEffect(
    on(
      () => [sdk.url, sync.ready] as const,
      () => {
        epoch++
        const version = epoch
        setState({
          tectonic: sync.data.config.latex?.tectonic?.path ?? "",
          latexmk: sync.data.config.latex?.latexmk?.path ?? "",
          error: "",
          saved: false,
          status: undefined,
          busy: false,
        })
        void refresh().catch((cause) => {
          if (version === epoch) error(cause)
        })
      },
    ),
  )
  onCleanup(() => {
    epoch++
  })
  const save = () => {
    const version = epoch
    setState({ busy: true, error: "", saved: false })
    void sync
      .updateConfig({ latex: { tectonic: { path: state.tectonic.trim() }, latexmk: { path: state.latexmk.trim() } } })
      .then(() => {
        if (version === epoch) return refresh()
      })
      .then(() => {
        if (version === epoch) setState("saved", true)
      })
      .catch((cause) => {
        if (version === epoch) error(cause)
      })
      .finally(() => {
        if (version === epoch) setState("busy", false)
      })
  }
  return (
    <div class="flex h-full flex-col gap-4 overflow-auto px-6 py-6" data-component="settings-latex">
      <h2 class="text-16-medium text-text-strong">{language.t("latex.settings")}</h2>
      <p class="text-12-regular text-text-weak">{language.t("latex.settingsHelp")}</p>
      <For each={["tectonic", "latexmk"] as const}>
        {(driver) => (
          <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-4">
            <TextField
              label={`${driver} — ${language.t("latex.executable")}`}
              value={state[driver]}
              onChange={(value) => setState(driver, value)}
              placeholder={language.t("latex.pathHint")}
              disabled={state.busy}
            />
            <Show when={state.status?.tools.find((tool) => tool.driver === driver)}>
              {(tool) => (
                <div class="break-all text-12-regular text-text-weak">
                  <p>
                    {tool().installed ? language.t("latex.installed") : language.t("latex.notInstalled")}
                    {tool().version ? ` · ${tool().version}` : ""}
                  </p>
                  <p>{tool().path}</p>
                  <p>{tool().error}</p>
                </div>
              )}
            </Show>
          </div>
        )}
      </For>
      <div class="flex gap-2">
        <Button onClick={save} disabled={state.busy}>
          {language.t("common.save")}
        </Button>
        <Button variant="secondary" onClick={() => void refresh().catch(error)} disabled={state.busy}>
          {language.t("latex.refresh")}
        </Button>
      </div>
      <Show when={state.saved}>
        <p role="status" class="text-12-regular">
          {language.t("latex.settingsSaved")}
        </p>
      </Show>
      <Show when={state.error}>
        <p role="alert" class="text-12-regular">
          {state.error}
        </p>
      </Show>
    </div>
  )
}
