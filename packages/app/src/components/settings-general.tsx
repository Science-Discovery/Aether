import { Component, Show, createEffect, createMemo, createResource, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { showToast, showPromiseToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { useSettings, monoFontFamily } from "@/context/settings"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { Link } from "./link"
import { formatServerError } from "@/utils/server-errors"
import { SettingsList } from "./settings-list"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
  run: 0,
}

type ThemeOption = {
  id: string
  name: string
}

let font: Promise<typeof import("@opencode-ai/ui/font-loader")> | undefined

function loadFont() {
  font ??= import("@opencode-ai/ui/font-loader")
  return font
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const stopDemoSound = () => {
  demoSoundState.run += 1
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }
  clearTimeout(demoSoundState.timeout)
  demoSoundState.cleanup = undefined
}

const playDemoSound = (id: string | undefined) => {
  stopDemoSound()
  if (!id) return

  const run = ++demoSoundState.run
  demoSoundState.timeout = setTimeout(() => {
    void playSoundById(id).then((cleanup) => {
      if (demoSoundState.run !== run) {
        cleanup?.()
        return
      }
      demoSoundState.cleanup = cleanup
    })
  }, 100)
}

type Model = {
  id: string
  name: string
  provider: { id: string; name: string }
  capabilities?: { input: { audio: boolean } }
  modalities?: { input: Array<string> }
}

function voice(model: Model) {
  const text = `${model.id} ${model.name}`.toLowerCase()
  return (
    model.capabilities?.input.audio ||
    model.modalities?.input.includes("audio") ||
    /\b(asr|omni|realtime|whisper)\b|speech[-_ ]?to[-_ ]?text|transcri/.test(text)
  )
}

function rank(model: Model) {
  const provider = `${model.provider.id} ${model.provider.name}`.toLowerCase()
  const text = `${model.id} ${model.name}`.toLowerCase()
  if (provider.includes("alibaba") && /\b(cn|china)\b/.test(provider) && /\b(asr|omni|realtime)\b/.test(text)) return 0
  return 1
}

export const SettingsGeneral: Component = () => {
  const dialog = useDialog()
  const theme = useTheme()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const globalSync = useGlobalSync()
  const models = useModels()

  onMount(() => {
    void theme.loadThemes()
  })

  const [store, setStore] = createStore({
    checking: false,
  })

  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const proxied = createMemo(() => !!platform.getProxyConfig && !!platform.setProxyConfig)
  const [proxy, setProxy] = createStore({
    busy: false,
    loaded: false,
    enabled: false,
    httpHost: "",
    httpPort: "8080",
    httpsHost: "",
    httpsPort: "8080",
  })

  createEffect(() => {
    if (!proxied()) return
    void platform
      .getProxyConfig?.()
      .then((cfg) => {
        if (!cfg) return
        setProxy("enabled", cfg.enabled)
        setProxy("httpHost", cfg.http.host)
        setProxy("httpPort", `${cfg.http.port}`)
        setProxy("httpsHost", cfg.https.host)
        setProxy("httpsPort", `${cfg.https.port}`)
      })
      .finally(() => {
        setProxy("loaded", true)
      })
  })

  const modelOptions = createMemo(() => {
    const none = { value: "", label: language.t("settings.general.row.defaultModel.none"), providerID: "" }
    const items = models
      .list()
      .filter((m) => models.visible({ providerID: m.provider.id, modelID: m.id }))
      .map((m) => ({
        value: `${m.provider.id}/${m.id}`,
        label: `${m.name} (${m.provider.name})`,
        providerID: m.provider.id,
      }))
    return [none, ...items]
  })

  const currentModel = createMemo(() => {
    const val = globalSync.data.config.model ?? ""
    return modelOptions().find((o) => o.value === val) ?? modelOptions()[0]
  })

  const currentSmallModel = createMemo(() => {
    const val = globalSync.data.config.small_model ?? ""
    return modelOptions().find((o) => o.value === val) ?? modelOptions()[0]
  })

  const voiceModelOptions = createMemo(() => {
    const none = { value: "", label: language.t("settings.general.row.voiceModel.none"), providerID: "" }
    const items = models
      .list()
      .filter((m) => models.visible({ providerID: m.provider.id, modelID: m.id }))
      .filter(voice)
      .sort((a, b) => rank(a) - rank(b))
      .map((m) => ({
        value: `${m.provider.id}/${m.id}`,
        label: `${m.name} (${m.provider.name})`,
        providerID: m.provider.id,
      }))
    return [none, ...items]
  })

  const currentVoiceModel = createMemo(() => {
    const val = settings.voice.model()
    if (!val) return voiceModelOptions()[0]
    return voiceModelOptions().find((o) => o.value === val) ?? { value: val, label: val, providerID: "" }
  })

  const desc = createMemo(() =>
    language.t(
      voiceModelOptions().length > 1
        ? "settings.general.row.voiceModel.description"
        : "settings.general.row.voiceModel.emptyDescription",
    ),
  )

  const check = () => {
    if (!platform.checkUpdate) return
    setStore("checking", true)
    const install = async () => {
      if (platform.platform === "web") {
        const x = await import("@/components/dialog-update")
        dialog.show(() => <x.DialogUpdate auto="install" />)
        return
      }
      showPromiseToast(
        (async () => {
          await platform.update!()
          await platform.restart!()
        })(),
        {
          loading: language.t("update.installing"),
          success: () => language.t("update.installHint"),
          error: (err) => formatServerError(err, language.t),
        },
      )
    }

    void platform
      .checkUpdate()
      .then((result) => {
        if (!result.updateAvailable) {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
          return
        }

        const actions = platform.update
          ? [
              {
                label: language.t("update.install"),
                onClick: install,
              },
              {
                label: language.t("toast.update.action.notYet"),
                onClick: "dismiss" as const,
              },
            ]
          : [
              {
                label: language.t("toast.update.action.notYet"),
                onClick: "dismiss" as const,
              },
            ]

        showToast({
          persistent: true,
          placement: "top-center",
          guarded: true,
          icon: "download",
          title: language.t("toast.update.title"),
          description: `${language.t("toast.update.description", { version: result.version ?? "" })} ${language.t("update.installHint")}`,
          actions,
        })
      })
      .catch((err: unknown) => {
        showToast({ title: language.t("common.requestFailed"), description: formatServerError(err, language.t) })
      })
      .finally(() => setStore("checking", false))
  }

  const themeOptions = createMemo<ThemeOption[]>(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const branchFontOptions = createMemo(() => [
    { value: "xs", label: language.t("settings.general.row.branchGraphFontSize.option.xs") },
    { value: "sm", label: language.t("settings.general.row.branchGraphFontSize.option.sm") },
    { value: "md", label: language.t("settings.general.row.branchGraphFontSize.option.md") },
    { value: "lg", label: language.t("settings.general.row.branchGraphFontSize.option.lg") },
    { value: "xl", label: language.t("settings.general.row.branchGraphFontSize.option.xl") },
  ])

  const branchDensityOptions = createMemo(() => [
    { value: "xcompact", label: language.t("settings.general.row.branchGraphRowDensity.option.xcompact") },
    { value: "compact", label: language.t("settings.general.row.branchGraphRowDensity.option.compact") },
    { value: "normal", label: language.t("settings.general.row.branchGraphRowDensity.option.normal") },
    { value: "relaxed", label: language.t("settings.general.row.branchGraphRowDensity.option.relaxed") },
    { value: "xrelaxed", label: language.t("settings.general.row.branchGraphRowDensity.option.xrelaxed") },
  ])

  const followupOptions = createMemo((): { value: "queue" | "steer"; label: string }[] => [
    { value: "queue", label: language.t("settings.general.row.followup.option.queue") },
    { value: "steer", label: language.t("settings.general.row.followup.option.steer") },
  ])
  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  const fontOptions = [
    { value: "system", label: "font.option.system" },
    { value: "ibm-plex-mono", label: "font.option.ibmPlexMono" },
    { value: "cascadia-code", label: "font.option.cascadiaCode" },
    { value: "fira-code", label: "font.option.firaCode" },
    { value: "hack", label: "font.option.hack" },
    { value: "inconsolata", label: "font.option.inconsolata" },
    { value: "intel-one-mono", label: "font.option.intelOneMono" },
    { value: "iosevka", label: "font.option.iosevka" },
    { value: "jetbrains-mono", label: "font.option.jetbrainsMono" },
    { value: "meslo-lgs", label: "font.option.mesloLgs" },
    { value: "monaco", label: "font.option.monaco" },
    { value: "roboto-mono", label: "font.option.robotoMono" },
    { value: "source-code-pro", label: "font.option.sourceCodePro" },
    { value: "ubuntu-mono", label: "font.option.ubuntuMono" },
    { value: "geist-mono", label: "font.option.geistMono" },
  ] as const
  const fontOptionsList = [...fontOptions]

  const noneSound = { id: "none", label: "sound.option.none" } as const
  const soundOptions = [noneSound, ...SOUND_OPTIONS]

  const soundSelectProps = (
    enabled: () => boolean,
    current: () => string,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    options: soundOptions,
    current: enabled() ? (soundOptions.find((o) => o.id === current()) ?? noneSound) : noneSound,
    value: (o: (typeof soundOptions)[number]) => o.id,
    label: (o: (typeof soundOptions)[number]) => language.t(o.label),
    onHighlight: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      playDemoSound(option.id === "none" ? undefined : option.id)
    },
    onSelect: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        stopDemoSound()
        return
      }
      setEnabled(true)
      set(option.id)
      playDemoSound(option.id)
    },
    variant: "secondary" as const,
    size: "small" as const,
    triggerVariant: "settings" as const,
  })

  const GeneralSection = () => (
    <div class="flex flex-col gap-1">
      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.defaultModel.title")}
          description={language.t("settings.general.row.defaultModel.description")}
        >
          <Select
            data-action="settings-default-model"
            options={modelOptions()}
            current={currentModel()}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              const model = option.value || undefined
              const before = globalSync.data.config.model
              if (model === before) return
              globalSync.set("config", "model", model)
              globalSync.updateConfig({ model }).catch((err: unknown) => {
                globalSync.set("config", "model", before)
                showToast({
                  title: language.t("common.requestFailed"),
                  description: formatServerError(err, language.t),
                })
              })
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "220px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.voiceModel.title")}
          description={desc()}
        >
          <Select
            data-action="settings-voice-model"
            options={voiceModelOptions()}
            current={currentVoiceModel()}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              settings.voice.setModel(option.value)
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "220px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.smallModel.title")}
          description={language.t("settings.general.row.smallModel.description")}
        >
          <Select
            data-action="settings-small-model"
            options={modelOptions()}
            current={currentSmallModel()}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              const small_model = option.value || undefined
              const before = globalSync.data.config.small_model
              if (small_model === before) return
              globalSync.set("config", "small_model", small_model)
              globalSync.updateConfig({ small_model }).catch((err: unknown) => {
                globalSync.set("config", "small_model", before)
                showToast({
                  title: language.t("common.requestFailed"),
                  description: formatServerError(err, language.t),
                })
              })
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "220px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.language.title")}
          description={language.t("settings.general.row.language.description")}
        >
          <Select
            data-action="settings-language"
            options={languageOptions()}
            current={languageOptions().find((o) => o.value === language.locale())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && language.setLocale(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.reasoningSummaries.title")}
          description={language.t("settings.general.row.reasoningSummaries.description")}
        >
          <div data-action="settings-feed-reasoning-summaries">
            <Switch
              checked={settings.general.showReasoningSummaries()}
              onChange={(checked) => settings.general.setShowReasoningSummaries(checked)}
            />
          </div>
        </SettingsRow>

        <Show when={import.meta.env.DEV}>
          <SettingsRow
            title={language.t("settings.general.row.debugBar.title")}
            description={language.t("settings.general.row.debugBar.description")}
          >
            <div data-action="settings-debug-bar">
              <Switch
                checked={settings.general.debugBar()}
                onChange={(checked) => settings.general.setDebugBar(checked)}
              />
            </div>
          </SettingsRow>
        </Show>

        <SettingsRow
          title={language.t("settings.general.row.branchesTab.title")}
          description={language.t("settings.general.row.branchesTab.description")}
        >
          <div
            class="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:flex-nowrap"
            data-action="settings-feed-branches-tab"
          >
            <Show when={settings.general.branchesTab()}>
              <div class="flex flex-wrap justify-end gap-2" data-action="settings-branch-graph-controls">
                <button
                  type="button"
                  data-action="settings-branch-graph-compact"
                  class="rounded-md border border-border-weak-base px-2 py-px text-[11px] text-text-weak transition-colors hover:bg-background-base"
                  onClick={() => settings.general.setBranchGraphCompact(!settings.general.branchGraphCompact())}
                >
                  {settings.general.branchGraphCompact()
                    ? language.t("settings.general.row.branchGraphCompact.option.full")
                    : language.t("settings.general.row.branchGraphCompact.option.compact")}
                </button>

                <div
                  class="flex overflow-hidden rounded-md border border-border-weak-base"
                  data-action="settings-branch-graph-order-mode"
                >
                  <button
                    type="button"
                    class="px-2 py-px text-[11px] transition-colors"
                    classList={{
                      "bg-background-base text-text-strong": settings.general.branchGraphOrderMode() === "sequence",
                      "text-text-weak hover:bg-background-base": settings.general.branchGraphOrderMode() !== "sequence",
                    }}
                    onClick={() => settings.general.setBranchGraphOrderMode("sequence")}
                  >
                    {language.t("settings.general.row.branchGraphOrderMode.option.sequence")}
                  </button>
                  <button
                    type="button"
                    class="border-l border-border-weak-base px-2 py-px text-[11px] transition-colors"
                    classList={{
                      "bg-background-base text-text-strong": settings.general.branchGraphOrderMode() === "time",
                      "text-text-weak hover:bg-background-base": settings.general.branchGraphOrderMode() !== "time",
                    }}
                    onClick={() => settings.general.setBranchGraphOrderMode("time")}
                  >
                    {language.t("settings.general.row.branchGraphOrderMode.option.time")}
                  </button>
                </div>

                <DropdownMenu placement="bottom-end">
                  <DropdownMenu.Trigger
                    data-action="settings-branch-graph-display"
                    class="rounded-md border border-border-weak-base px-2 py-px text-[11px] text-text-weak transition-colors hover:bg-background-base"
                  >
                    {language.t("settings.general.row.branchGraphDisplay.label")}
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="min-w-40">
                      <DropdownMenu.Group>
                        <DropdownMenu.GroupLabel>
                          {language.t("settings.general.row.branchGraphFontSize.title")}
                        </DropdownMenu.GroupLabel>
                        <DropdownMenu.RadioGroup
                          value={settings.general.branchGraphFontSize()}
                          onChange={(value) => {
                            if (
                              value === "xs" ||
                              value === "sm" ||
                              value === "md" ||
                              value === "lg" ||
                              value === "xl"
                            ) {
                              settings.general.setBranchGraphFontSize(value)
                            }
                          }}
                        >
                          {branchFontOptions().map((item) => (
                            <DropdownMenu.RadioItem value={item.value}>
                              <DropdownMenu.ItemLabel>{item.label}</DropdownMenu.ItemLabel>
                              <DropdownMenu.ItemIndicator>
                                <Icon name="check-small" size="small" class="text-icon-weak" />
                              </DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                          ))}
                        </DropdownMenu.RadioGroup>
                      </DropdownMenu.Group>

                      <DropdownMenu.Separator />

                      <DropdownMenu.Group>
                        <DropdownMenu.GroupLabel>
                          {language.t("settings.general.row.branchGraphRowDensity.title")}
                        </DropdownMenu.GroupLabel>
                        <DropdownMenu.RadioGroup
                          value={settings.general.branchGraphRowDensity()}
                          onChange={(value) => {
                            if (
                              value === "xcompact" ||
                              value === "compact" ||
                              value === "normal" ||
                              value === "relaxed" ||
                              value === "xrelaxed"
                            ) {
                              settings.general.setBranchGraphRowDensity(value)
                            }
                          }}
                        >
                          {branchDensityOptions().map((item) => (
                            <DropdownMenu.RadioItem value={item.value}>
                              <DropdownMenu.ItemLabel>{item.label}</DropdownMenu.ItemLabel>
                              <DropdownMenu.ItemIndicator>
                                <Icon name="check-small" size="small" class="text-icon-weak" />
                              </DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                          ))}
                        </DropdownMenu.RadioGroup>
                      </DropdownMenu.Group>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </div>
            </Show>

            <Switch
              checked={settings.general.branchesTab()}
              onChange={(checked) => settings.general.setBranchesTab(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.shellToolPartsExpanded.title")}
          description={language.t("settings.general.row.shellToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-shell-tool-parts-expanded">
            <Switch
              checked={settings.general.shellToolPartsExpanded()}
              onChange={(checked) => settings.general.setShellToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.editToolPartsExpanded.title")}
          description={language.t("settings.general.row.editToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-edit-tool-parts-expanded">
            <Switch
              checked={settings.general.editToolPartsExpanded()}
              onChange={(checked) => settings.general.setEditToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.followup.title")}
          description={language.t("settings.general.row.followup.description")}
        >
          <Select
            data-action="settings-followup"
            options={followupOptions()}
            current={followupOptions().find((o) => o.value === settings.general.followup())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && settings.general.setFollowup(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "180px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.reviewBatch.title")}
          description={language.t("settings.general.row.reviewBatch.description")}
        >
          <TextField
            data-action="settings-review-batch"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={`${settings.general.reviewBatch()}`}
            onChange={(value) => {
              const next = Number.parseInt(value, 10)
              if (!Number.isInteger(next) || next < 1) return
              settings.general.setReviewBatch(next)
            }}
            class="w-24"
          />
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const cfg = () => {
    const httpHost = proxy.httpHost.trim()
    const httpPort = Number.parseInt(proxy.httpPort, 10)
    const httpsHost = proxy.httpsHost.trim()
    const httpsPort = Number.parseInt(proxy.httpsPort, 10)
    if (proxy.enabled && !httpHost && !httpsHost) {
      showToast({ title: language.t("settings.general.proxy.toast.invalidHost") })
      return
    }
    if (proxy.enabled && httpHost && (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535)) {
      showToast({ title: language.t("settings.general.proxy.toast.invalidHttpPort") })
      return
    }
    if (proxy.enabled && httpsHost && (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535)) {
      showToast({ title: language.t("settings.general.proxy.toast.invalidHttpsPort") })
      return
    }
    return {
      enabled: proxy.enabled,
      http: {
        host: httpHost,
        port: Number.isInteger(httpPort) ? httpPort : 8080,
      },
      https: {
        host: httpsHost,
        port: Number.isInteger(httpsPort) ? httpsPort : 8080,
      },
    }
  }

  const save = async (apply: boolean) => {
    const next = cfg()
    if (!next || !platform.setProxyConfig) return
    setProxy("busy", true)
    await platform
      .setProxyConfig(next)
      .then(async () => {
        showToast({ title: language.t("settings.general.proxy.toast.saved") })
        if (!apply) return
        showToast({ title: language.t("settings.general.proxy.toast.restarting") })
        await platform.restart()
      })
      .catch((err: unknown) => {
        showToast({ title: language.t("common.requestFailed"), description: formatServerError(err, language.t) })
      })
      .finally(() => {
        setProxy("busy", false)
      })
  }

  const AppearanceSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.appearance")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <Select
            data-action="settings-color-scheme"
            options={colorSchemeOptions()}
            current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && theme.setColorScheme(option.value)}
            onHighlight={(option) => {
              if (!option) return
              theme.previewColorScheme(option.value)
              return () => theme.cancelPreview()
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "220px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.theme.title")}
          description={
            <>
              {language.t("settings.general.row.theme.description")}{" "}
              <Link href="https://opencode.ai/docs/themes/">{language.t("common.learnMore")}</Link>
            </>
          }
        >
          <Select
            data-action="settings-theme"
            options={themeOptions()}
            current={themeOptions().find((o) => o.id === theme.themeId())}
            value={(o) => o.id}
            label={(o) => o.name}
            onSelect={(option) => {
              if (!option) return
              theme.setTheme(option.id)
            }}
            onHighlight={(option) => {
              if (!option) return
              theme.previewTheme(option.id)
              return () => theme.cancelPreview()
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.font.title")}
          description={language.t("settings.general.row.font.description")}
        >
          <Select
            data-action="settings-font"
            options={fontOptionsList}
            current={fontOptionsList.find((o) => o.value === settings.appearance.font())}
            value={(o) => o.value}
            label={(o) => language.t(o.label)}
            onHighlight={(option) => {
              void loadFont().then((x) => x.ensureMonoFont(option?.value))
            }}
            onSelect={(option) => option && settings.appearance.setFont(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "font-family": monoFontFamily(settings.appearance.font()), "min-width": "180px" }}
          >
            {(option) => (
              <span style={{ "font-family": monoFontFamily(option?.value) }}>
                {option ? language.t(option.label) : ""}
              </span>
            )}
          </Select>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const NotificationsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.notifications")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const SoundsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.sounds")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.sounds.agent.title")}
          description={language.t("settings.general.sounds.agent.description")}
        >
          <Select
            data-action="settings-sounds-agent"
            {...soundSelectProps(
              () => settings.sounds.agentEnabled(),
              () => settings.sounds.agent(),
              (value) => settings.sounds.setAgentEnabled(value),
              (id) => settings.sounds.setAgent(id),
            )}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.sounds.permissions.title")}
          description={language.t("settings.general.sounds.permissions.description")}
        >
          <Select
            data-action="settings-sounds-permissions"
            {...soundSelectProps(
              () => settings.sounds.permissionsEnabled(),
              () => settings.sounds.permissions(),
              (value) => settings.sounds.setPermissionsEnabled(value),
              (id) => settings.sounds.setPermissions(id),
            )}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.sounds.errors.title")}
          description={language.t("settings.general.sounds.errors.description")}
        >
          <Select
            data-action="settings-sounds-errors"
            {...soundSelectProps(
              () => settings.sounds.errorsEnabled(),
              () => settings.sounds.errors(),
              (value) => settings.sounds.setErrorsEnabled(value),
              (id) => settings.sounds.setErrors(id),
            )}
          />
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const UpdatesSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.updates")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.updates.row.startup.title")}
          description={language.t("settings.updates.row.startup.description")}
        >
          <div data-action="settings-updates-startup">
            <Switch
              checked={settings.updates.startup()}
              disabled={!platform.checkUpdate}
              onChange={(checked) => settings.updates.setStartup(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.releaseNotes.title")}
          description={language.t("settings.general.row.releaseNotes.description")}
        >
          <div data-action="settings-release-notes">
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.updates.row.check.title")}
          description={language.t("settings.updates.row.check.description")}
        >
          <Button size="small" variant="secondary" disabled={store.checking || !platform.checkUpdate} onClick={check}>
            {store.checking
              ? language.t("settings.updates.action.checking")
              : language.t("settings.updates.action.checkNow")}
          </Button>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const ServerSection = () => {
    const idleOptions = createMemo(() => [
      { value: "15", label: "15 sec" },
      { value: "30", label: "30 sec" },
      { value: "60", label: "1 min" },
      { value: "300", label: "5 min" },
      { value: "1800", label: "30 min" },
      { value: "0", label: language.t("settings.general.row.idleTimeout.never") },
    ])

    const currentIdle = createMemo(() => {
      const config = globalSync.data.config as Record<string, unknown>
      const server =
        typeof config.server === "object" && config.server ? (config.server as Record<string, unknown>) : {}
      const val = String(typeof server.idleTimeout === "number" ? server.idleTimeout : 60)
      return idleOptions().find((o) => o.value === val) ?? idleOptions()[0]
    })

    const onIdleChange = (option: { value: string } | undefined) => {
      if (!option) return
      const idleTimeout = Number(option.value)
      const config = globalSync.data.config as Record<string, unknown>
      const server =
        typeof config.server === "object" && config.server ? (config.server as Record<string, unknown>) : {}
      const before = typeof server.idleTimeout === "number" ? server.idleTimeout : 60
      if (idleTimeout === before) return
      globalSync.set("config", (prev: unknown) => ({
        ...(prev as Record<string, unknown>),
        server: { ...(((prev as Record<string, unknown>).server as Record<string, unknown>) ?? {}), idleTimeout },
      }))
      globalSync
        .updateConfig({ server: { idleTimeout } } as Parameters<typeof globalSync.updateConfig>[0])
        .catch((err: unknown) => {
          globalSync.set("config", (prev: unknown) => ({
            ...(prev as Record<string, unknown>),
            server: {
              ...(((prev as Record<string, unknown>).server as Record<string, unknown>) ?? {}),
              idleTimeout: before,
            },
          }))
          showToast({ title: language.t("common.requestFailed"), description: formatServerError(err, language.t) })
        })
    }

    return (
      <div class="flex flex-col gap-1">
        <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.server")}</h3>
        <SettingsList>
          <SettingsRow
            title={language.t("settings.general.row.idleTimeout.title")}
            description={language.t("settings.general.row.idleTimeout.description")}
          >
            <Select
              data-action="settings-idle-timeout"
              options={idleOptions()}
              current={currentIdle()}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(o) => o && onIdleChange(o as { value: string })}
              variant="secondary"
              size="small"
              triggerVariant="settings"
              triggerStyle={{ "min-width": "180px" }}
            />
          </SettingsRow>
        </SettingsList>
      </div>
    )
  }

  const ProxySection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.network")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.proxyEnabled.title")}
          description={language.t("settings.general.row.proxyEnabled.description")}
        >
          <div data-action="settings-proxy-enabled">
            <Switch
              checked={proxy.enabled}
              disabled={proxy.busy || !proxy.loaded}
              onChange={(value) => setProxy("enabled", value)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.proxyHttp.title")}
          description={language.t("settings.general.row.proxyHttp.description")}
        >
          <div class="flex items-center gap-2">
            <TextField
              data-action="settings-proxy-http-host"
              type="text"
              value={proxy.httpHost}
              onChange={(value) => setProxy("httpHost", value)}
              placeholder={language.t("settings.general.row.proxyHost.placeholder")}
              disabled={proxy.busy || !proxy.loaded || !proxy.enabled}
              class="w-48"
            />
            <TextField
              data-action="settings-proxy-http-port"
              type="text"
              value={proxy.httpPort}
              onChange={(value) => setProxy("httpPort", value)}
              placeholder={language.t("settings.general.row.proxyPort.placeholder")}
              disabled={proxy.busy || !proxy.loaded || !proxy.enabled}
              class="w-24"
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.proxyHttps.title")}
          description={language.t("settings.general.row.proxyHttps.description")}
        >
          <div class="flex items-center gap-2">
            <TextField
              data-action="settings-proxy-https-host"
              type="text"
              value={proxy.httpsHost}
              onChange={(value) => setProxy("httpsHost", value)}
              placeholder={language.t("settings.general.row.proxyHost.placeholder")}
              disabled={proxy.busy || !proxy.loaded || !proxy.enabled}
              class="w-48"
            />
            <TextField
              data-action="settings-proxy-https-port"
              type="text"
              value={proxy.httpsPort}
              onChange={(value) => setProxy("httpsPort", value)}
              placeholder={language.t("settings.general.row.proxyPort.placeholder")}
              disabled={proxy.busy || !proxy.loaded || !proxy.enabled}
              class="w-24"
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.proxyApply.title")}
          description={language.t("settings.general.row.proxyApply.description")}
        >
          <div class="flex items-center gap-2">
            <Button
              data-action="settings-proxy-save"
              size="small"
              variant="secondary"
              disabled={proxy.busy || !proxy.loaded}
              onClick={() => void save(false)}
            >
              {language.t("settings.general.proxy.action.save")}
            </Button>
            <Button
              data-action="settings-proxy-apply"
              size="small"
              variant="secondary"
              disabled={proxy.busy || !proxy.loaded}
              onClick={() => void save(true)}
            >
              {language.t("settings.general.proxy.action.applyRestart")}
            </Button>
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.general")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <GeneralSection />

        <AppearanceSection />

        <NotificationsSection />

        <SoundsSection />

        <ServerSection />

        <Show when={proxied()}>{(_) => <ProxySection />}</Show>

        {/*<Show when={platform.platform === "desktop" && platform.os === "windows" && platform.getWslEnabled}>
          {(_) => {
            const [enabledResource, actions] = createResource(() => platform.getWslEnabled?.())
            const enabled = () => (enabledResource.state === "pending" ? undefined : enabledResource.latest)

            return (
              <div class="flex flex-col gap-1">
                <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.desktop.section.wsl")}</h3>

                <SettingsList>
                  <SettingsRow
                    title={language.t("settings.desktop.wsl.title")}
                    description={language.t("settings.desktop.wsl.description")}
                  >
                    <div data-action="settings-wsl">
                      <Switch
                        checked={enabled() ?? false}
                        disabled={enabledResource.state === "pending"}
                        onChange={(checked) => platform.setWslEnabled?.(checked)?.finally(() => actions.refetch())}
                      />
                    </div>
                  </SettingsRow>
                </SettingsList>
              </div>
            )
          }}
        </Show>*/}

        <UpdatesSection />

        <Show when={linux()}>
          {(_) => {
            const [valueResource, actions] = createResource(() => platform.getDisplayBackend?.())
            const value = () => (valueResource.state === "pending" ? undefined : valueResource.latest)

            const onChange = (checked: boolean) =>
              platform.setDisplayBackend?.(checked ? "wayland" : "auto").finally(() => actions.refetch())

            return (
              <div class="flex flex-col gap-1">
                <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.display")}</h3>

                <SettingsList>
                  <SettingsRow
                    title={
                      <div class="flex items-center gap-2">
                        <span>{language.t("settings.general.row.wayland.title")}</span>
                        <Tooltip value={language.t("settings.general.row.wayland.tooltip")} placement="top">
                          <span class="text-text-weak">
                            <Icon name="help" size="small" />
                          </span>
                        </Tooltip>
                      </div>
                    }
                    description={language.t("settings.general.row.wayland.description")}
                  >
                    <div data-action="settings-wayland">
                      <Switch checked={value() === "wayland"} onChange={onChange} />
                    </div>
                  </SettingsRow>
                </SettingsList>
              </div>
            )
          }}
        </Show>
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}
