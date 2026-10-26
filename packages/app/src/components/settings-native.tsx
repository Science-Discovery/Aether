import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Switch } from "@opencode-ai/ui/switch"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import { formatServerError } from "@/utils/server-errors"
import { createNativeStatus } from "@/context/native-status"

export function SettingsNative() {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()
  const params = useParams()
  const client = createMemo(() => sdk.createClient({ directory: decode64(params.dir), throwOnError: true }))
  const [store, setStore] = createStore<{ path?: string; limit?: string; saving: boolean; error?: string }>({
    saving: false,
  })
  const cfg = () => sync.data.config.native?.codex
  const enabled = () => cfg()?.enabled !== false
  const result = createNativeStatus({
    key: () => `${sdk.url}\n${decode64(params.dir) ?? ""}\n${cfg()?.path ?? ""}`,
    enabled: () => sync.ready && enabled(),
    active: () => true,
    read: (refresh) =>
      client()
        .native.status({ refresh })
        .then((response) => response.data),
  })
  const status = result.data
  const error = () =>
    store.error ?? (result.error() ? formatServerError(result.error(), language.t) : undefined) ?? status()?.error
  const toggle = async (enabled: boolean) => {
    if (store.saving) return
    setStore({ saving: true, error: undefined })
    await sync
      .updateConfig({ native: { codex: { enabled } } })
      .catch((error: unknown) => setStore("error", formatServerError(error, language.t)))
      .finally(() => setStore("saving", false))
  }
  const save = async () => {
    if (store.saving) return
    const text = (store.limit ?? String(cfg()?.limit ?? 4)).trim()
    const limit = Number(text)
    if (!/^\d+$/.test(text) || !Number.isInteger(limit) || limit < 0 || limit > 16) {
      setStore("error", language.t("native.limitInvalid"))
      return
    }
    const path = (store.path ?? cfg()?.path ?? "").trim()
    const changed = path !== (cfg()?.path ?? "")
    const adjusted = limit !== (cfg()?.limit ?? 4)
    setStore({ saving: true, error: undefined })
    await sync
      .updateConfig({ native: { codex: { path, limit } } })
      .then(() => {
        setStore({ path: undefined, limit: undefined })
        if (!changed && !adjusted && enabled()) return result.refresh()
      })
      .catch((error: unknown) => setStore("error", formatServerError(error, language.t)))
      .finally(() => setStore("saving", false))
  }
  return (
    <div class="flex flex-col gap-6 px-6 py-6 max-w-[720px]" data-component="settings-native">
      <div>
        <h2 class="text-16-medium text-text-strong">{language.t("native.title")}</h2>
        <p class="mt-2 text-13-regular text-text-weak">{language.t("native.description")}</p>
      </div>
      <div class="rounded-lg border border-border-base p-4 flex flex-col gap-4">
        <h3 class="text-14-medium text-text-strong">Codex</h3>
        <Switch
          checked={enabled()}
          disabled={store.saving || !sync.ready}
          onChange={(value) => void toggle(value)}
          description={language.t("native.enableHelp")}
          data-action="native-enabled"
        >
          {language.t("native.enable")}
        </Switch>
        <Show when={!enabled() || status()?.enabled === false}>
          <p class="text-13-regular text-text-weak" role="status">
            {language.t("native.disabled")}
          </p>
        </Show>
        <TextField
          label={language.t("native.path")}
          description={language.t("native.pathHelp")}
          placeholder={language.t("native.automatic")}
          value={store.path ?? cfg()?.path ?? ""}
          onChange={(path) => setStore("path", path)}
          disabled={store.saving}
          data-action="native-path"
        />
        <TextField
          label={language.t("native.limit")}
          description={language.t("native.limitHelp")}
          type="number"
          min="0"
          max="16"
          step="1"
          value={store.limit ?? String(cfg()?.limit ?? 4)}
          onChange={(limit) => setStore("limit", limit)}
          disabled={store.saving}
          data-action="native-limit"
        />
        <div class="flex gap-2">
          <Button onClick={() => void save()} disabled={store.saving || !sync.ready} data-action="native-save">
            {language.t("common.save")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void result.refresh()}
            disabled={!enabled() || !sync.ready || result.loading() || store.saving}
            data-action="native-refresh"
          >
            {language.t(result.loading() ? "native.checking" : "native.refresh")}
          </Button>
        </div>
        <Show when={status()?.enabled ? status() : undefined}>
          {(status) => (
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-13-regular" aria-live="polite">
              <dt>{language.t("native.installation")}</dt>
              <dd>{language.t(status().installed ? "native.found" : "native.missing")}</dd>
              <dt>{language.t("native.executable")}</dt>
              <dd class="break-all">{status().path ?? "—"}</dd>
              <dt>{language.t("native.version")}</dt>
              <dd>{status().version ?? "—"}</dd>
              <dt>{language.t("native.connection")}</dt>
              <dd>{language.t(status().connected ? "native.connected" : "native.disconnected")}</dd>
              <dt>{language.t("native.authentication")}</dt>
              <dd>{language.t(`native.auth.${status().auth}`)}</dd>
              <dt>{language.t("native.models")}</dt>
              <dd>
                {status()
                  .models.map((model) => model.name)
                  .join(", ") || "—"}
              </dd>
            </dl>
          )}
        </Show>
        <Show when={error()}>
          <p role="alert" class="text-13-regular text-text-critical-base break-words">
            {error()}
          </p>
        </Show>
      </div>
    </div>
  )
}
