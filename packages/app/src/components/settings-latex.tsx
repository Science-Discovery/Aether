import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { LatexSetup, LatexStatus } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { Link } from "./link"
import { LatexAppearance } from "./latex-appearance"

export function SettingsLatex() {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()
  let epoch = 0
  let serial = 0
  let probe = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const [state, setState] = createStore({
    tectonic: "",
    latexmk: "",
    busy: false,
    error: "",
    saved: false,
    status: undefined as LatexStatus | undefined,
    setup: undefined as LatexSetup | undefined,
    action: undefined as "start" | "cancel" | undefined,
    setupError: "",
  })
  const error = (cause: unknown) => setState("error", formatServerError(cause, language.t))
  const running = () => ["downloading", "verifying", "extracting", "checking"].includes(state.setup?.state ?? "")
  const custom = () => {
    const path = sync.data.config.latex?.tectonic?.path?.trim()
    return !!path && path !== state.setup?.path
  }
  const bytes = (value: number) => {
    const unit = value >= 1024 * 1024 ? 1024 * 1024 : value >= 1024 ? 1024 : 1
    return `${new Intl.NumberFormat(language.intl(), { maximumFractionDigits: unit === 1 ? 0 : 1 }).format(value / unit)} ${unit === 1 ? "B" : unit === 1024 ? "KiB" : "MiB"}`
  }
  const refresh = async () => {
    const version = epoch
    const request = ++probe
    const result = await sdk.client.latex.status({}, { throwOnError: true }).catch((cause: unknown) => {
      if (version === epoch && request === probe) throw cause
    })
    if (version === epoch && request === probe) setState("status", reconcile(result?.data))
  }
  const inspect = async (action: "status" | "start" | "cancel" = "status") => {
    clearTimeout(timer)
    const version = epoch
    const request = ++serial
    const client = sdk.client
    setState({ setupError: "", action: action === "status" ? undefined : action })
    await (
      action === "start"
        ? client.latex.setupStart({}, { throwOnError: true })
        : action === "cancel"
          ? client.latex.setupCancel({}, { throwOnError: true })
          : client.latex.setupStatus({}, { throwOnError: true })
    )
      .then((response) => {
        if (version !== epoch || request !== serial) return
        const setup = response.data
        if (!setup) return
        const ready = setup.state === "ready" && (state.setup?.state !== "ready" || state.setup.path !== setup.path)
        setState("setup", reconcile(setup))
        if (!ready) return
        void refresh().catch((cause) => {
          if (version === epoch) error(cause)
        })
      })
      .catch((cause: unknown) => {
        if (version === epoch && request === serial) setState("setupError", formatServerError(cause, language.t))
      })
      .finally(() => {
        if (version !== epoch || request !== serial) return
        setState("action", undefined)
        if (running()) timer = setTimeout(() => void inspect(), 750)
      })
  }
  createEffect(
    on(
      () => [sdk.url, sync.ready] as const,
      () => {
        epoch++
        serial++
        probe++
        clearTimeout(timer)
        const version = epoch
        setState({
          tectonic: sync.data.config.latex?.tectonic?.path ?? "",
          latexmk: sync.data.config.latex?.latexmk?.path ?? "",
          error: "",
          saved: false,
          status: undefined,
          busy: false,
          setup: undefined,
          action: undefined,
          setupError: "",
        })
        if (!sync.ready) return
        void refresh().catch((cause) => {
          if (version === epoch) error(cause)
        })
        void inspect()
      },
    ),
  )
  onCleanup(() => {
    epoch++
    serial++
    probe++
    clearTimeout(timer)
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
      <LatexAppearance />
      <section class="flex flex-col gap-4 border-t border-border-weak-base pt-5" data-component="latex-compilers">
        <h3 class="text-14-medium text-text-strong">{language.t("latex.compilers")}</h3>
        <p class="text-12-regular text-text-weak">{language.t("latex.settingsHelp")}</p>
        <For each={["tectonic", "latexmk"] as const}>
          {(driver) => (
            <div
              class="flex flex-col gap-2 rounded-md border border-border-weak-base p-4"
              data-component={`latex-${driver}`}
            >
              <TextField
                label={`${driver} — ${language.t("latex.executable")}`}
                value={state[driver]}
                onChange={(value) => setState(driver, value)}
                data-action={`latex-${driver}-path`}
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
              <Show
                when={driver === "tectonic"}
                fallback={
                  <div class="text-12-regular text-text-weak">
                    <p>{language.t("latex.setup.latexmk")}</p>
                    <div class="mt-1 flex flex-wrap gap-3">
                      <Link href="https://www.tug.org/texlive/acquire-netinstall.html">TeX Live</Link>
                      <Link href="https://miktex.org/download">MiKTeX</Link>
                    </div>
                  </div>
                }
              >
                <p class="text-12-regular text-text-weak">{language.t("latex.setup.help")}</p>
                <p class="text-12-regular text-text-weak">{language.t("latex.setup.packages")}</p>
                <div class="flex flex-wrap items-center gap-2">
                  <Show
                    when={running()}
                    fallback={
                      <Button
                        size="small"
                        data-action="latex-setup-start"
                        disabled={!sync.ready || !state.setup?.supported || !!state.action || state.busy}
                        onClick={() => void inspect("start")}
                      >
                        {language.t(
                          state.setup?.state === "ready"
                            ? "latex.setup.repair"
                            : state.setupError || state.setup?.state === "failed" || state.setup?.state === "cancelled"
                              ? "latex.setup.retry"
                              : "latex.setup.install",
                        )}
                      </Button>
                    }
                  >
                    <Button
                      size="small"
                      variant="secondary"
                      data-action="latex-setup-cancel"
                      disabled={!!state.action}
                      onClick={() => void inspect("cancel")}
                    >
                      {language.t("common.cancel")}
                    </Button>
                  </Show>
                  <Link href="https://tectonic-typesetting.github.io/book/latest/installation/">
                    {language.t("latex.setup.manual")}
                  </Link>
                </div>
                <Show when={(state.setup && state.setup.supported) || state.action}>
                  <div
                    role="status"
                    aria-live="polite"
                    aria-busy={running() || !!state.action}
                    data-component="latex-setup-status"
                    class="text-12-regular text-text-weak"
                  >
                    <p>
                      {language.t(
                        state.action === "start"
                          ? "latex.setup.starting"
                          : state.action === "cancel"
                            ? "latex.setup.cancelling"
                            : `latex.setup.${state.setup?.state ?? "idle"}`,
                      )}
                      {state.setup?.version ? ` · ${state.setup.version}` : ""}
                    </p>
                    <Show when={state.setup?.state === "downloading"}>
                      <progress
                        class="mt-1 w-full"
                        aria-label={language.t("latex.setup.downloading")}
                        max={state.setup?.total || undefined}
                        value={state.setup?.total ? Math.min(state.setup.downloaded, state.setup.total) : undefined}
                      />
                      <p>
                        {language.t(state.setup?.total ? "latex.setup.progressTotal" : "latex.setup.progress", {
                          downloaded: bytes(state.setup?.downloaded ?? 0),
                          total: bytes(state.setup?.total ?? 0),
                        })}
                      </p>
                    </Show>
                    <Show when={state.setup?.state === "ready" && state.setup.path}>
                      <p class="break-all" data-component="latex-managed-path">
                        {state.setup?.path}
                      </p>
                      <p>{language.t(custom() ? "latex.setup.custom" : "latex.setup.automatic")}</p>
                    </Show>
                  </div>
                </Show>
                <Show when={state.setup?.supported === false}>
                  <p class="text-12-regular text-text-weak">{language.t("latex.setup.unsupported")}</p>
                </Show>
                <Show when={state.setupError || state.setup?.error}>
                  <p role="alert" class="break-words text-12-regular">
                    {state.setupError || state.setup?.error}
                  </p>
                </Show>
              </Show>
            </div>
          )}
        </For>
        <div class="flex gap-2">
          <Button onClick={save} disabled={state.busy || !sync.ready} data-action="latex-save">
            {language.t("common.save")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              void refresh().catch(error)
              void inspect()
            }}
            disabled={state.busy || !sync.ready || !!state.action}
            data-action="latex-refresh"
          >
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
      </section>
    </div>
  )
}
