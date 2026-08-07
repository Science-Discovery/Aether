import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { Show, createEffect, createMemo, createResource, onCleanup, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { OpenIntent } from "@/utils/open-intent"
import { formatServerError } from "@/utils/server-errors"
import {
  DialogMineruExternalHelp,
  DialogMineruRemove,
  DialogMineruSetup,
} from "./dialog-mineru-setup"
import { watchMineruMonitor } from "./mineru-monitor"
import { SettingsRow } from "./settings-list"

type Mode = "managed" | "external"

const Item: Component<{ label: string; value: string; mono?: boolean; wide?: boolean; note?: string }> = (props) => (
  <div classList={{ "sm:col-span-2": props.wide }}>
    <p class="text-11-regular text-text-weaker">{props.label}</p>
    <p
      class="mt-0.5 text-12-regular text-text-strong"
      classList={{ "break-all font-mono": props.mono }}
      title={props.value}
    >
      {props.value}
    </p>
    <Show when={props.note}>
      <p class="mt-0.5 text-11-regular text-text-weaker">{props.note}</p>
    </Show>
  </div>
)

function bytes(value: number | undefined) {
  if (value === undefined) return
  if (value < 1024) return `${value} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  const rank = Math.min(Math.floor(Math.log(value) / Math.log(1024)) - 1, units.length - 1)
  return `${(value / 1024 ** (rank + 1)).toFixed(rank > 0 ? 1 : 0)} ${units[rank]}`
}

export const SettingsMineru: Component = () => {
  const dialog = useDialog()
  const global = useGlobalSync()
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const navigate = useNavigate()
  const server = useServer()
  const [store, setStore] = createStore({
    activate: false,
    busy: false,
    loaded: false,
    scanning: false,
    url: "http://127.0.0.1:8000",
    state: "idle" as "idle" | "checking" | "ok" | "error",
  })

  const cfg = createMemo(() => global.data.config.experimental?.attachment_text_extraction)
  const mode = createMemo<Mode>(() => cfg()?.mineru?.mode ?? "external")
  const [managed, { refetch, mutate }] = createResource(
    () => mode() === "managed",
    (active) =>
      active
        ? sdk.client.global
            .mineruManagedStatus({ throwOnError: true })
            .then((item) => item.data)
            .catch(() => undefined)
        : undefined,
  )

  createEffect(() => {
    if (store.loaded) return
    setStore({
      loaded: true,
      url: cfg()?.mineru?.base_url || "http://127.0.0.1:8000",
    })
  })

  createEffect(() => {
    if (mode() !== "managed" || managed()?.install !== "installing") return
    const timer = setInterval(() => {
      void refetch()
    }, 2_000)
    onCleanup(() => clearInterval(timer))
  })

  const save = async (
    patch: Partial<NonNullable<NonNullable<typeof global.data.config.experimental>["attachment_text_extraction"]>>,
  ) => {
    const before = global.data.config.experimental
    const next = {
      ...before,
      attachment_text_extraction: {
        ...before?.attachment_text_extraction,
        ...patch,
      },
    }
    global.set("config", "experimental", next)
    return global
      .updateConfig({ experimental: next })
      .then(() => true)
      .catch((err) => {
        global.set("config", "experimental", before)
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(err, language.t),
        })
        return false
      })
  }

  const probe = async (enable = cfg()?.enabled === true) => {
    const url = store.url.trim()
    if (!url) {
      setStore("state", "error")
      return false
    }
    setStore("state", "checking")
    const healthy = await sdk.client.global
      .mineruHealth({ base_url: url }, { throwOnError: true })
      .then(() => true)
      .catch(() => false)
    if (!healthy) {
      setStore("state", "error")
      return false
    }
    const saved = await save({
      enabled: enable,
      strategy: "local",
      mineru: {
        ...cfg()?.mineru,
        mode: "external",
        base_url: url,
        scope: "selective",
      },
    })
    setStore("state", saved ? "ok" : "error")
    if (saved) setStore("activate", false)
    return saved
  }

  const text = () => {
    if (mode() === "external") {
      if (store.state === "checking") return language.t("settings.general.row.mineruUrl.testing")
      if (store.state === "ok") return language.t("settings.general.row.mineruUrl.connected")
      if (store.state === "error") return language.t("settings.general.row.mineruUrl.failed")
      return language.t("settings.general.row.mineruMode.external")
    }
    const value = managed()
    if (!value) return language.t("settings.general.mineru.unconfigured")
    if (!value.supported) return language.t("settings.general.mineru.unsupported")
    if (value.run === "running") return language.t("settings.general.mineru.running")
    if (value.install === "installing") return language.t("settings.general.mineru.installing")
    if (value.install === "ready") return language.t("settings.general.mineru.ready")
    if (value.install === "failed") return language.t("settings.general.mineru.failed")
    if (value.install === "cancelled") return language.t("settings.general.mineru.cancelled")
    return language.t("settings.general.mineru.unconfigured")
  }

  const tone = () => {
    if (mode() === "external") {
      if (store.state === "checking") return "progress"
      if (store.state === "ok") return "success"
      if (store.state === "error") return "error"
      return "idle"
    }
    if (managed()?.run === "running" || managed()?.install === "ready") return "success"
    if (managed()?.install === "installing") return "progress"
    if (managed()?.install === "failed") return "error"
    return "idle"
  }

  const Status: Component = () => (
    <span class="inline-flex max-w-64 items-center gap-1.5 rounded-full border border-border-weak-base bg-surface-raised-base px-2 py-1 text-12-regular text-text-weak">
      <span
        class="size-1.5 shrink-0 rounded-full"
        classList={{
          "bg-icon-success-base": tone() === "success",
          "bg-icon-critical-base": tone() === "error",
          "bg-icon-warning-base animate-pulse": tone() === "progress",
          "bg-icon-weak-base": tone() === "idle",
        }}
      />
      <span class="truncate">{text()}</span>
    </span>
  )

  const jump = (session: { id: string; directory: string }) => {
    watchMineruMonitor()
    OpenIntent.mark(server.key, session.directory)
    dialog.close()
    navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  const setup = () => {
    const session = managed()?.session
    if (session && managed()?.install !== "ready") return jump(session)
    dialog.show(() => <DialogMineruSetup />)
  }

  const chat = () => {
    const session = managed()?.session
    if (session) jump(session)
  }

  const test = async () => {
    await sdk.client.global
      .mineruManagedStart({ throwOnError: true })
      .then(() => {
        void refetch()
        showToast({ title: language.t("settings.general.mineru.testReady") })
      })
      .catch((err) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(err, language.t),
        })
      })
  }

  const measure = async () => {
    setStore("scanning", true)
    await sdk.client.global
      .mineruManagedMeasure({ throwOnError: true })
      .then((item) => {
        if (item.data) mutate(item.data)
        showToast({ title: language.t("settings.general.mineru.details.measure.done") })
      })
      .catch((err) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: formatServerError(err, language.t),
        })
      })
      .finally(() => setStore("scanning", false))
  }

  const choose = async (item: { value: Mode } | undefined) => {
    if (!item || item.value === mode()) return
    setStore("state", "idle")
    await save({
      enabled: item.value === "managed" && managed()?.install === "ready" ? cfg()?.enabled : false,
      strategy: "local",
      mineru: {
        ...cfg()?.mineru,
        mode: item.value,
        scope: "selective",
        base_url:
          item.value === "managed"
            ? (managed()?.base_url ?? cfg()?.mineru?.base_url ?? "http://127.0.0.1:8000")
            : store.url.trim(),
      },
    })
  }

  const toggle = async (enabled: boolean) => {
    if (!enabled) {
      await save({ enabled: false })
      return
    }
    if (mode() === "managed" && managed()?.install !== "ready") {
      open(true)
      return
    }
    setStore("busy", true)
    if (mode() === "managed") {
      await save({
        enabled: true,
        strategy: "local",
        mineru: {
          ...cfg()?.mineru,
          mode: "managed",
          base_url: managed()?.base_url ?? cfg()?.mineru?.base_url,
          scope: "selective",
        },
      })
      setStore("busy", false)
      return
    }
    if (!(await probe(true))) open(true)
    setStore("busy", false)
  }

  const Details: Component = () => {
    const modes = [
      { value: "managed" as const, label: language.t("settings.general.row.mineruMode.managed") },
      { value: "external" as const, label: language.t("settings.general.row.mineruMode.external") },
    ]
    const current = () => modes.find((item) => item.value === mode()) ?? modes[1]
    const engine = () => {
      const value = managed()
      if (!value?.backend || !value.device) return language.t("settings.general.mineru.details.userManaged")
      const device =
        value.device === "auto" ? language.t("settings.general.mineru.details.device.auto") : value.device.toUpperCase()
      return `${value.backend} · ${device}`
    }
    const source = () => {
      if (managed()?.source === "modelscope") return "ModelScope"
      if (managed()?.source === "huggingface") return "Hugging Face"
      if (managed()?.source === "local") return language.t("settings.general.mineru.details.source.local")
      return language.t("settings.general.mineru.details.userManaged")
    }

    return (
      <Dialog
        title={language.t("settings.general.row.attachmentExtraction.title")}
        description={language.t("settings.general.mineru.dialog.description")}
        class="w-[min(560px,calc(100vw-32px))]"
      >
        <div data-action="settings-mineru-dialog" class="flex max-h-[72vh] flex-col gap-4 overflow-y-auto p-4">
          <section class="flex flex-col items-stretch gap-3 rounded-lg border border-border-weak-base bg-surface-base p-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
              <p class="text-13-medium text-text-strong">{language.t("settings.general.row.mineruMode.title")}</p>
              <p class="mt-0.5 text-12-regular text-text-weak">
                {language.t("settings.general.row.mineruMode.description")}
              </p>
            </div>
            <div class="w-full sm:w-44 sm:shrink-0">
              <Select
                data-action="settings-mineru-mode"
                options={modes}
                current={current()}
                value={(item) => item.value}
                label={(item) => item.label}
                onSelect={(item) => void choose(item)}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                triggerStyle={{ width: "100%" }}
              />
            </div>
          </section>

          <Show
            when={mode() === "managed"}
            fallback={
              <section class="rounded-lg border border-border-weak-base bg-surface-base p-3.5">
                <div class="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
                  <div>
                    <p class="text-13-medium text-text-strong">{language.t("settings.general.row.mineruUrl.title")}</p>
                    <p class="mt-0.5 text-12-regular text-text-weak">
                      {language.t("settings.general.row.mineruUrl.description")}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-3">
                    <button
                      type="button"
                      data-action="settings-mineru-external-help"
                      class="text-12-regular text-text-weak underline decoration-current underline-offset-4 transition-colors hover:text-text-strong"
                      onClick={() => dialog.show(() => <DialogMineruExternalHelp />)}
                    >
                      {language.t("settings.general.mineru.externalHelp.open")}
                    </button>
                    <Status />
                  </div>
                </div>
                <div class="mt-3 flex flex-col gap-2 sm:flex-row">
                  <TextField
                    data-action="settings-mineru-url"
                    type="text"
                    value={store.url}
                    onChange={(value) => {
                      setStore("url", value)
                      setStore("state", "idle")
                    }}
                    class="min-w-0 flex-1"
                  />
                  <Button
                    data-action="settings-mineru-test"
                    variant="primary"
                    size="small"
                    disabled={store.state === "checking" || !store.url.trim()}
                    onClick={() => void probe(store.activate || cfg()?.enabled === true)}
                  >
                    {language.t(
                      store.state === "checking"
                        ? "settings.general.row.mineruUrl.testing"
                        : "settings.general.row.mineruUrl.test",
                    )}
                  </Button>
                </div>
              </section>
            }
          >
            <section class="rounded-lg border border-border-weak-base bg-surface-base p-3.5">
              <div class="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
                <div>
                  <p class="text-13-medium text-text-strong">{language.t("settings.general.mineru.ai.title")}</p>
                  <p class="mt-0.5 text-12-regular text-text-weak">
                    {language.t("settings.general.mineru.ai.description")}
                  </p>
                </div>
                <Status />
              </div>
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <Show
                  when={managed()?.install === "ready"}
                  fallback={
                    <>
                      <Button
                        data-action="settings-mineru-configure"
                        variant="primary"
                        size="small"
                        disabled={managed()?.supported === false}
                        onClick={setup}
                      >
                        {managed()?.session
                          ? language.t("settings.general.mineru.ai.open")
                          : language.t("settings.general.mineru.ai.configure")}
                      </Button>
                      <Show when={managed()?.install !== "unconfigured"}>
                        <Button
                          data-action="settings-mineru-remove-incomplete"
                          variant="ghost"
                          size="small"
                          onClick={() => dialog.show(() => <DialogMineruRemove done={() => void refetch()} />)}
                        >
                          {language.t("settings.general.mineru.remove.open")}
                        </Button>
                      </Show>
                    </>
                  }
                >
                  <Button variant="primary" size="small" onClick={() => void test()}>
                    {language.t("settings.general.mineru.test")}
                  </Button>
                  <Show when={managed()?.session}>
                    <Button data-action="settings-mineru-chat" variant="secondary" size="small" onClick={chat}>
                      {language.t("settings.general.mineru.ai.open")}
                    </Button>
                  </Show>
                  <DropdownMenu placement="bottom-end">
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      size="small"
                      variant="ghost"
                      data-action="settings-mineru-more"
                      aria-label={language.t("settings.general.mineru.more")}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1 min-w-44">
                        <DropdownMenu.Item onSelect={() => dialog.show(() => <DialogMineruSetup />)}>
                          <DropdownMenu.ItemLabel>
                            {language.t("settings.general.mineru.ai.reconfigure")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          onSelect={() => dialog.show(() => <DialogMineruRemove done={() => void refetch()} />)}
                          class="text-text-on-critical-base hover:bg-surface-critical-weak"
                        >
                          <DropdownMenu.ItemLabel>
                            {language.t("settings.general.mineru.remove.open")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </Show>
              </div>
            </section>
          </Show>

          <div class="rounded-lg bg-background-stronger px-3 py-2.5">
            <p class="text-12-medium text-text-strong">{language.t("settings.general.row.mineruScope.title")}</p>
            <p class="mt-0.5 text-12-regular text-text-weak">
              {language.t("settings.general.row.mineruScope.unsupported")}
            </p>
          </div>

          <Show when={mode() === "managed"}>
          <section data-action="settings-mineru-details" class="border-t border-border-weak-base px-0.5 pt-3.5">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-12-medium text-text-strong">{language.t("settings.general.mineru.details.title")}</p>
                <Show when={managed()?.scanned_at}>
                  {(value) => (
                    <p class="mt-0.5 text-11-regular text-text-weaker">
                      {language.t("settings.general.mineru.details.scannedAt")} {new Date(value()).toLocaleString()}
                    </p>
                  )}
                </Show>
              </div>
              <Button
                data-action="settings-mineru-measure"
                variant="secondary"
                size="small"
                disabled={store.scanning || managed()?.install !== "ready"}
                onClick={() => void measure()}
              >
                {language.t(
                  store.scanning
                    ? "settings.general.mineru.details.measure.running"
                    : managed()?.storage
                      ? "settings.general.mineru.details.measure.again"
                      : "settings.general.mineru.details.measure",
                )}
              </Button>
            </div>
            <div class="mt-3 grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
              <Show
                when={mode() === "managed"}
                fallback={
                  <>
                    <Item
                      label={language.t("settings.general.mineru.details.runtime")}
                      value={language.t("settings.general.mineru.details.runtime.external")}
                    />
                    <Item
                      label={language.t("settings.general.mineru.details.address")}
                      value={store.url.trim() || language.t("settings.general.mineru.details.unavailable")}
                      mono
                    />
                    <Item
                      label={language.t("settings.general.mineru.details.connection")}
                      value={text()}
                    />
                    <Item
                      label={language.t("settings.general.mineru.details.managed")}
                      value={language.t("settings.general.mineru.details.userManaged")}
                      wide
                    />
                  </>
                }
              >
                <Item
                  label={language.t("settings.general.mineru.details.runtime")}
                  value={language.t(
                    managed()?.runtime === "adopted"
                      ? "settings.general.mineru.details.runtime.adopted"
                      : "settings.general.mineru.details.runtime.managed",
                  )}
                />
                <Item
                  label={language.t("settings.general.mineru.details.address")}
                  value={
                    managed()?.base_url ??
                    cfg()?.mineru?.base_url ??
                    language.t("settings.general.mineru.details.unavailable")
                  }
                  mono
                />
                <Item
                  label={language.t("settings.general.mineru.details.directory")}
                  value={managed()?.directory ?? language.t("settings.general.mineru.details.unavailable")}
                  mono
                  wide
                />
                <Show when={managed()?.runtime === "adopted" && managed()?.data_directory}>
                  <Item
                    label={language.t("settings.general.mineru.details.dataDirectory")}
                    value={managed()!.data_directory}
                    mono
                    wide
                  />
                </Show>
                <Item
                  label="MinerU"
                  value={managed()?.version?.mineru ?? language.t("settings.general.mineru.details.unavailable")}
                />
                <Item
                  label="Python"
                  value={managed()?.version?.python ?? language.t("settings.general.mineru.details.notDetected")}
                />
                <Item
                  label="uv"
                  value={managed()?.version?.uv ?? language.t("settings.general.mineru.details.notDetected")}
                />
                <Item
                  label={language.t("settings.general.mineru.details.backend")}
                  value={engine()}
                />
                <Item
                  label={language.t("settings.general.mineru.details.source")}
                  value={source()}
                />
                <Item
                  label={language.t("settings.general.mineru.details.size.total")}
                  value={bytes(managed()?.storage?.total) ?? language.t("settings.general.mineru.details.unmeasured")}
                  note={language.t("settings.general.mineru.details.size.totalNote")}
                />
                <Item
                  label={language.t("settings.general.mineru.details.size.environment")}
                  value={
                    bytes(managed()?.storage?.environment) ?? language.t("settings.general.mineru.details.unmeasured")
                  }
                />
                <Item
                  label={language.t("settings.general.mineru.details.size.models")}
                  value={bytes(managed()?.storage?.models) ?? language.t("settings.general.mineru.details.unmeasured")}
                  note={language.t(
                    managed()?.runtime === "adopted"
                      ? "settings.general.mineru.details.size.modelsShared"
                      : "settings.general.mineru.details.size.modelsManaged",
                  )}
                />
                <Item
                  label={language.t("settings.general.mineru.details.size.aether")}
                  value={bytes(managed()?.storage?.aether) ?? language.t("settings.general.mineru.details.unmeasured")}
                />
                <Show when={managed()?.storage?.model_directories.length}>
                  <Item
                    label={language.t("settings.general.mineru.details.modelDirectories")}
                    value={managed()!.storage!.model_directories.join("; ")}
                    mono
                    wide
                  />
                </Show>
              </Show>
            </div>
          </section>
          </Show>
        </div>
      </Dialog>
    )
  }

  function open(activate = false) {
    setStore("activate", activate)
    dialog.show(() => <Details />)
  }

  return (
    <SettingsRow
      title={language.t("settings.general.row.attachmentExtraction.title")}
      description={language.t("settings.general.row.attachmentExtraction.description")}
    >
      <div class="flex flex-wrap items-center justify-end gap-2">
        <Status />
        <Button data-action="settings-mineru-open" variant="secondary" size="small" onClick={() => open()}>
          {language.t("settings.general.mineru.configure")}
        </Button>
        <div data-action="settings-attachment-extraction">
          <Switch
            checked={cfg()?.enabled === true}
            disabled={store.busy}
            onChange={(enabled) => void toggle(enabled)}
            hideLabel
          >
            {language.t("settings.general.row.attachmentExtraction.title")}
          </Switch>
        </div>
      </div>
    </SettingsRow>
  )
}
