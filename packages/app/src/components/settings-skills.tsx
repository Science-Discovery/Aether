import { Component, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { SettingsList } from "./settings-list"

const SKILL_NUDGE_DEFAULT = 10

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
  const [saving, setSaving] = createSignal(false)

  const currentInterval = createMemo(() => {
    const cfg = globalSync.data.config as any
    return (cfg.skills?.creation_nudge_interval as number | undefined) ?? SKILL_NUDGE_DEFAULT
  })

  const evolutionEnabled = createMemo(() => currentInterval() !== 0)

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

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">Skill Evolution</h2>
          <p class="text-14-regular text-text-weak">
            Configure how the AI automatically captures and refines reusable skills.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-6 max-w-[720px]">
        <SettingsList>
          <SettingsRow
            title="Skill Evolution"
            description="Trigger a background skill review after N steps where the AI made tool calls."
          >
            <Switch
              checked={evolutionEnabled()}
              disabled={saving()}
              onChange={(enabled) => updateInterval(enabled ? SKILL_NUDGE_DEFAULT : 0)}
            />
          </SettingsRow>

          <Show when={evolutionEnabled()}>
            <SettingsRow
              title="Review Interval"
              description="Number of tool-calling steps between automatic skill reviews."
            >
              <input
                type="number"
                min={1}
                value={currentInterval()}
                disabled={saving()}
                onBlur={(e) => {
                  const val = parseInt(e.currentTarget.value, 10)
                  if (!isNaN(val) && val >= 1 && val !== currentInterval()) {
                    void updateInterval(val)
                  }
                }}
                class="h-9 w-24 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong focus:outline-none focus:ring-2 focus:ring-border-focus disabled:opacity-50"
              />
            </SettingsRow>
          </Show>
        </SettingsList>
      </div>
    </div>
  )
}
