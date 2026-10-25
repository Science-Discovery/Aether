import { createMemo, createResource, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import { formatServerError } from "@/utils/server-errors"

export function SettingsNative() {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()
  const params = useParams()
  const client = createMemo(() => sdk.createClient({ directory: decode64(params.dir), throwOnError: true }))
  const [store, setStore] = createStore<{ path?: string; saving: boolean; error?: string }>({ saving: false })
  const [result, actions] = createResource(
    () => `${sdk.url}\n${decode64(params.dir) ?? ""}\n${sync.data.config.native?.codex?.path ?? ""}`,
    async () =>
      client()
        .native.status()
        .then((response) => ({ data: response.data, error: undefined }))
        .catch((error: unknown) => ({ data: undefined, error: formatServerError(error, language.t) })),
  )
  const status = () => result()?.data
  const error = () => store.error ?? result()?.error ?? status()?.error
  const save = async () => {
    if (store.saving) return
    const path = (store.path ?? sync.data.config.native?.codex?.path ?? "").trim()
    const changed = path !== (sync.data.config.native?.codex?.path ?? "")
    setStore({ saving: true, error: undefined })
    await sync
      .updateConfig({ native: { codex: { path } } })
      .then(() => {
        setStore("path", undefined)
        if (!changed) return actions.refetch()
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
        <TextField
          label={language.t("native.path")}
          description={language.t("native.pathHelp")}
          placeholder={language.t("native.automatic")}
          value={store.path ?? sync.data.config.native?.codex?.path ?? ""}
          onChange={(path) => setStore("path", path)}
          disabled={store.saving}
          data-action="native-path"
        />
        <div class="flex gap-2">
          <Button onClick={() => void save()} disabled={store.saving} data-action="native-save">
            {language.t("common.save")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void actions.refetch()}
            disabled={result.loading || store.saving}
            data-action="native-refresh"
          >
            {language.t(result.loading ? "native.checking" : "native.refresh")}
          </Button>
        </div>
        <Show when={status()}>
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
