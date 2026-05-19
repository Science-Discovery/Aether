import { type Component, createMemo, type JSX } from "solid-js"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { SettingsList } from "./settings-list"

export const SettingsSkills: Component = () => {
  const globalSync = useGlobalSync()

  const skillsConfig = createMemo(() => {
    const config = globalSync.data.config as Record<string, unknown>
    const skills =
      typeof config.skills === "object" && config.skills ? (config.skills as Record<string, unknown>) : {}
    return {
      creation_nudge_interval:
        typeof skills.creation_nudge_interval === "number" ? skills.creation_nudge_interval : 10,
      max_versions: typeof skills.max_versions === "number" ? skills.max_versions : 100,
    }
  })

  const updateSkillsField = (field: string, next: number, before: number) => {
    if (next === before) return
    globalSync.set("config", (prev: unknown) => ({
      ...(prev as Record<string, unknown>),
      skills: {
        ...(((prev as Record<string, unknown>).skills as Record<string, unknown>) ?? {}),
        [field]: next,
      },
    }))
    globalSync
      .updateConfig({ skills: { [field]: next } } as Parameters<typeof globalSync.updateConfig>[0])
      .catch((err: unknown) => {
        globalSync.set("config", (prev: unknown) => ({
          ...(prev as Record<string, unknown>),
          skills: {
            ...(((prev as Record<string, unknown>).skills as Record<string, unknown>) ?? {}),
            [field]: before,
          },
        }))
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: "Request failed", description: message })
      })
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">Skills</h2>
          <p class="text-14-regular text-text-weak">Configure skill evolution behavior.</p>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Evolution</h3>
          <SettingsList>
            <SettingsRow
              title="Review Interval"
              description="Steps without skill_manage before background skill review triggers. Set to 0 to disable."
            >
              <TextField
                data-action="settings-skills-nudge-interval"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={`${skillsConfig().creation_nudge_interval}`}
                onChange={(value) => {
                  const next = Number.parseInt(value, 10)
                  if (!Number.isInteger(next) || next < 0) return
                  updateSkillsField("creation_nudge_interval", next, skillsConfig().creation_nudge_interval)
                }}
                class="w-24"
              />
            </SettingsRow>
            <SettingsRow
              title="Max Versions"
              description="Maximum number of version snapshots kept per skill before older ones are pruned."
            >
              <TextField
                data-action="settings-skills-max-versions"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={`${skillsConfig().max_versions}`}
                onChange={(value) => {
                  const next = Number.parseInt(value, 10)
                  if (!Number.isInteger(next) || next < 1) return
                  updateSkillsField("max_versions", next, skillsConfig().max_versions)
                }}
                class="w-24"
              />
            </SettingsRow>
          </SettingsList>
        </div>
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string
  description: string
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
