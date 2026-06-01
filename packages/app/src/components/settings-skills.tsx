import { type Component, createMemo, createSignal, type JSX } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
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
  const language = useLanguage()
  const [saving, setSaving] = createSignal(false)

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
            title={language.t("settingsSkills.reviewInterval")}
            description={language.t("settingsSkills.reviewIntervalDescription")}
          >
            <input
              type="number"
              min={0}
              value={currentInterval()}
              disabled={saving()}
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
              disabled={saving()}
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
              disabled={saving()}
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
              disabled={saving()}
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
      </div>
    </div>
  )
}
