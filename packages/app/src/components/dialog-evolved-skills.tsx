import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Component, For, Match, Show, Switch as SolidSwitch, createResource, createSignal } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

type ManagedSkill = { name: string; description: string; content: string; enabled?: boolean; file?: string }

export const DialogEvolvedSkills: Component = () => {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const sdk = useSDK()

  const [skills, { refetch }] = createResource<ManagedSkill[]>(async () => {
    const result = await globalSDK.client.config.skills.listEvolution({ directory: sdk.directory })
    return (result.data as unknown as ManagedSkill[]) ?? []
  })

  const [toggling, setToggling] = createSignal<string | null>(null)

  async function handleToggle(file: string, enabled: boolean) {
    setToggling(file)
    try {
      await globalSDK.client.config.skills.toggle({ file, enabled })
      await refetch()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({
        variant: "error",
        icon: "circle-x",
        title: language.t("evolvedSkills.operationFailed"),
        description: message,
      })
    } finally {
      setToggling(null)
    }
  }

  return (
    <Dialog title={language.t("evolvedSkills.title")}>
      <div class="flex flex-col gap-3 min-h-0">
        <SolidSwitch>
          <Match when={skills.loading}>
            <div class="text-12-regular text-text-weak px-1">{language.t("evolvedSkills.loading")}</div>
          </Match>
          <Match when={skills()?.length === 0}>
            <div class="text-12-regular text-text-weak px-1">{language.t("evolvedSkills.empty")}</div>
          </Match>
          <Match when={true}>
            <div class="flex flex-col gap-1.5 overflow-y-auto max-h-80">
              <For each={skills()}>
                {(skill) => (
                  <div class="flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg border border-border-weak-base bg-surface-base hover:border-border-base transition-colors">
                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span class="text-13-medium text-text-strong truncate">{skill.name}</span>
                      <Show when={skill.description}>
                        <span class="text-12-regular text-text-weak line-clamp-2">{skill.description}</span>
                      </Show>
                      <Show when={!skill.description}>
                        <span class="text-12-regular text-text-subtle italic">
                          {language.t("evolvedSkills.noDescription")}
                        </span>
                      </Show>
                    </div>
                    <div class="flex items-center shrink-0">
                      <Switch
                        checked={skill.enabled !== false}
                        disabled={toggling() === skill.file}
                        onChange={(checked) => skill.file && handleToggle(skill.file, checked)}
                      />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Match>
        </SolidSwitch>
      </div>
    </Dialog>
  )
}
