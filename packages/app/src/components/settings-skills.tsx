import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch as SolidSwitch,
  type JSX,
} from "solid-js"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { SettingsList } from "./settings-list"

const SKILL_NUDGE_DEFAULT = 80
const SKILL_MAX_VERSIONS_DEFAULT = 100
// Defaults mirror the backend constants in skill-evolution/limits.ts
// (REVIEW_MAX_STEP_CHARS / REVIEW_MAX_TOTAL_CHARS). Kept as local copies because
// the app package can't import the opencode package; the backend remains the
// authoritative default (used whenever config leaves the field unset).
const REVIEW_MAX_STEP_CHARS_DEFAULT = 300_000
const REVIEW_MAX_TOTAL_CHARS_DEFAULT = 1_000_000
// The two char caps are entered/shown in "k" (thousands) so the user types 300
// instead of 300000; config still stores the real character count.
const CHARS_PER_K = 1000

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => (
  <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-14-medium text-text-strong">{props.title}</span>
      <span class="text-12-regular text-text-weak">{props.description}</span>
    </div>
    <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
  </div>
)

export const SettingsSkills: Component = () => {
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const layout = useLayout()
  const navigate = useNavigate()
  const [saving, setSaving] = createSignal(false)

  // Master switch: unset means on, only an explicit false turns it off (mirrors
  // the backend ConfigReader.isEvolutionEnabled default).
  const evolutionEnabled = createMemo(() => {
    const cfg = globalSync.data.config as any
    return cfg.skills?.evolution_enabled !== false
  })

  // Per-project output directories (read-only). Refetched whenever the dialog mounts.
  const [outputDirs] = createResource(async () => {
    const result = await globalSDK.client.config.skills.evolutionDirs()
    return result.data ?? []
  })

  // Copy works everywhere (browser + desktop) via the standard clipboard API.
  async function copyDir(dir: string) {
    try {
      await navigator.clipboard.writeText(dir)
      showToast({ title: language.t("settingsSkills.copiedDir"), variant: "success" })
    } catch {
      showToast({ title: language.t("settingsSkills.copyDirFailed"), variant: "error" })
    }
  }

  // Open goes through the backend (which has OS access), so it works even when
  // the UI is a plain browser tab — unlike platform.openPath which the browser
  // can't provide. Cross-platform + WSL-aware on the server side.
  async function openDir(dir: string) {
    const result = await globalSDK.client.config.skills.evolutionReveal({ dir })
    if (!result.data?.ok) showToast({ title: language.t("settingsSkills.openDirFailed"), variant: "error" })
  }

  // Open the directory as a project inside the app (same effect as picking a
  // project on the home page): register it and navigate to its session view.
  function openAsProject(dir: string) {
    layout.projects.open(dir)
    navigate(`/${base64Encode(dir)}`)
  }

  const currentInterval = createMemo(() => {
    const cfg = globalSync.data.config as any
    return (cfg.skills?.creation_nudge_interval as number | undefined) ?? SKILL_NUDGE_DEFAULT
  })

  const currentMaxVersions = createMemo(() => {
    const cfg = globalSync.data.config as any
    return (cfg.skills?.max_versions as number | undefined) ?? SKILL_MAX_VERSIONS_DEFAULT
  })

  const currentReviewMaxStepChars = createMemo(() => {
    const cfg = globalSync.data.config as any
    return (cfg.skills?.review_max_step_chars as number | undefined) ?? REVIEW_MAX_STEP_CHARS_DEFAULT
  })

  const currentReviewMaxTotalChars = createMemo(() => {
    const cfg = globalSync.data.config as any
    return (cfg.skills?.review_max_total_chars as number | undefined) ?? REVIEW_MAX_TOTAL_CHARS_DEFAULT
  })

  const updateEvolutionEnabled = async (enabled: boolean) => {
    setSaving(true)
    try {
      await globalSync.updateConfig({ skills: { evolution_enabled: enabled } } as any)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: "Request failed", description: message })
    } finally {
      setSaving(false)
    }
  }

  const updateInterval = async (interval: number) => {
    setSaving(true)
    try {
      await globalSync.updateConfig({ skills: { creation_nudge_interval: interval } } as any)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: "Request failed", description: message })
    } finally {
      setSaving(false)
    }
  }

  const updateMaxVersions = async (max: number) => {
    setSaving(true)
    try {
      await globalSync.updateConfig({ skills: { max_versions: max } } as any)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: "Request failed", description: message })
    } finally {
      setSaving(false)
    }
  }

  const updateReviewMaxStepChars = async (max: number) => {
    setSaving(true)
    try {
      await globalSync.updateConfig({ skills: { review_max_step_chars: max } } as any)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: "Request failed", description: message })
    } finally {
      setSaving(false)
    }
  }

  const updateReviewMaxTotalChars = async (max: number) => {
    setSaving(true)
    try {
      await globalSync.updateConfig({ skills: { review_max_total_chars: max } } as any)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: "Request failed", description: message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settingsSkills.pageTitle")}</h2>
          <p class="text-14-regular text-text-weak">{language.t("settingsSkills.pageTitleDescription")}</p>
        </div>
      </div>

      <div class="flex flex-col gap-6 max-w-[720px]">
        <SettingsList>
          <SettingsRow
            title={language.t("settingsSkills.evolutionEnabled")}
            description={language.t("settingsSkills.evolutionEnabledDescription")}
          >
            <Switch
              checked={evolutionEnabled()}
              disabled={saving()}
              onChange={(checked) => void updateEvolutionEnabled(checked)}
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settingsSkills.reviewInterval")}
            description={language.t("settingsSkills.reviewIntervalDescription")}
          >
            <input
              type="number"
              min={0}
              value={currentInterval()}
              disabled={saving() || !evolutionEnabled()}
              onBlur={(e) => {
                const val = parseInt(e.currentTarget.value, 10)
                if (!isNaN(val) && val >= 0 && val !== currentInterval()) {
                  void updateInterval(val)
                }
              }}
              class="h-9 w-24 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong focus:outline-none focus:ring-2 focus:ring-border-focus disabled:opacity-50"
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settingsSkills.maxVersions")}
            description={language.t("settingsSkills.maxVersionsDescription")}
          >
            <input
              type="number"
              min={1}
              value={currentMaxVersions()}
              disabled={saving() || !evolutionEnabled()}
              onBlur={(e) => {
                const val = parseInt(e.currentTarget.value, 10)
                if (!isNaN(val) && val >= 1 && val !== currentMaxVersions()) {
                  void updateMaxVersions(val)
                }
              }}
              class="h-9 w-24 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong focus:outline-none focus:ring-2 focus:ring-border-focus disabled:opacity-50"
            />
          </SettingsRow>

          <SettingsRow
            title={language.t("settingsSkills.reviewMaxStepChars")}
            description={language.t("settingsSkills.reviewMaxStepCharsDescription")}
          >
            <div class="flex items-center gap-1.5">
            <input
              type="number"
              min={0.001}
              step={0.001}
              value={currentReviewMaxStepChars() / CHARS_PER_K}
              disabled={saving() || !evolutionEnabled()}
              onBlur={(e) => {
                // Input is in "k" (thousands); store the real char count (×1000).
                // parseFloat (not parseInt) so fractional k like 0.001 survives;
                // Math.round keeps the stored char count an integer.
                const k = parseFloat(e.currentTarget.value)
                const chars = Math.round(k * CHARS_PER_K)
                if (!isNaN(k) && k >= 0.001 && chars !== currentReviewMaxStepChars()) {
                  void updateReviewMaxStepChars(chars)
                }
              }}
              class="h-9 w-24 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong focus:outline-none focus:ring-2 focus:ring-border-focus disabled:opacity-50"
            />
            <span class="text-14-regular text-text-weak">k</span>
            </div>
          </SettingsRow>

          <SettingsRow
            title={language.t("settingsSkills.reviewMaxTotalChars")}
            description={language.t("settingsSkills.reviewMaxTotalCharsDescription")}
          >
            <div class="flex items-center gap-1.5">
            <input
              type="number"
              min={0.001}
              step={0.001}
              value={currentReviewMaxTotalChars() / CHARS_PER_K}
              disabled={saving() || !evolutionEnabled()}
              onBlur={(e) => {
                // Input is in "k" (thousands); store the real char count (×1000).
                // parseFloat (not parseInt) so fractional k like 0.001 survives;
                // Math.round keeps the stored char count an integer.
                const k = parseFloat(e.currentTarget.value)
                const chars = Math.round(k * CHARS_PER_K)
                if (!isNaN(k) && k >= 0.001 && chars !== currentReviewMaxTotalChars()) {
                  void updateReviewMaxTotalChars(chars)
                }
              }}
              class="h-9 w-24 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong focus:outline-none focus:ring-2 focus:ring-border-focus disabled:opacity-50"
            />
            <span class="text-14-regular text-text-weak">k</span>
            </div>
          </SettingsRow>
        </SettingsList>

        <div class="flex flex-col gap-2">
          <div class="flex flex-col gap-0.5">
            <span class="text-14-medium text-text-strong">{language.t("settingsSkills.outputDirsTitle")}</span>
            <span class="text-12-regular text-text-weak">{language.t("settingsSkills.outputDirsDescription")}</span>
          </div>
          <SolidSwitch>
            {/* Error first: a failed fetch (e.g. backend without the new route)
                must show a message, never re-throw and tear down the page. */}
            <Match when={outputDirs.error}>
              <span class="text-12-regular text-text-weak py-2">{language.t("settingsSkills.outputDirsError")}</span>
            </Match>
            <Match when={outputDirs.loading}>
              <span class="text-12-regular text-text-weak py-2">{language.t("settingsSkills.outputDirsLoading")}</span>
            </Match>
            <Match when={(outputDirs() ?? []).length === 0}>
              <span class="text-12-regular text-text-weak py-2">{language.t("settingsSkills.outputDirsEmpty")}</span>
            </Match>
            <Match when={true}>
              <div class="flex flex-col rounded-lg border border-border-weak-base">
              <For each={outputDirs()}>
                {(item) => (
                  <div class="flex flex-wrap items-center gap-3 px-3 py-2.5 border-b border-border-weak-base last:border-none sm:flex-nowrap">
                    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                      <Show when={item.projectPath}>
                        <span class="text-13-medium text-text-strong truncate" title={item.projectPath}>
                          {item.projectPath}
                        </span>
                      </Show>
                      <span class="text-11-regular text-text-subtle truncate font-mono" title={item.evolutionDir}>
                        {item.evolutionDir}
                      </span>
                    </div>
                    <button
                      class="shrink-0 h-8 px-3 rounded-md border border-border-base text-12-regular text-text-base hover:bg-surface-hover transition-colors"
                      onClick={() => void copyDir(item.evolutionDir)}
                    >
                      {language.t("settingsSkills.copyDir")}
                    </button>
                    <button
                      class="shrink-0 h-8 px-3 rounded-md border border-border-base text-12-regular text-text-base hover:bg-surface-hover transition-colors"
                      onClick={() => void openDir(item.evolutionDir)}
                    >
                      {language.t("settingsSkills.openDir")}
                    </button>
                    <button
                      class="shrink-0 h-8 px-3 rounded-md border border-border-base text-12-regular text-text-base hover:bg-surface-hover transition-colors"
                      onClick={() => openAsProject(item.evolutionDir)}
                    >
                      {language.t("settingsSkills.openAsProject")}
                    </button>
                  </div>
                )}
              </For>
              </div>
            </Match>
          </SolidSwitch>
        </div>
      </div>
    </div>
  )
}
