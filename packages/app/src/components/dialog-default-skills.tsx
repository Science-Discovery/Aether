import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import {
  Component,
  For,
  Match,
  Show,
  Switch as SolidSwitch,
  createResource,
  createSignal,
} from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSDK } from "@/context/sdk"
import { DialogFindSkills } from "@/components/dialog-find-skills"

type DefaultSkill = { name: string; description: string; content: string; enabled?: boolean }

export const DialogDefaultSkills: Component = () => {
  const globalSDK = useGlobalSDK()
  const sdk = useSDK()
  const dialog = useDialog()

  const [skills, { refetch }] = createResource<DefaultSkill[]>(async () => {
    const result = await globalSDK.client.config.skills.list()
    return ((result.data as unknown) as DefaultSkill[]) ?? []
  })

  const [adding, setAdding] = createSignal(false)
  const [toggling, setToggling] = createSignal<string | null>(null)

  async function handleToggle(name: string, enabled: boolean) {
    setToggling(name)
    try {
      await globalSDK.client.config.skills.toggle({ name, enabled })
      await refetch()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", icon: "circle-x", title: "操作失败", description: message })
    } finally {
      setToggling(null)
    }
  }

  async function handleAddToProject() {
    setAdding(true)
    try {
      const result = await globalSDK.client.config.skills.addDefaults({ directory: sdk.directory })
      const added = ((result.data as unknown) as { added: string[] }).added
      if (added.length > 0) {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: "Skills 已复制到项目",
          description: `已复制：${added.join(", ")}`,
        })
      } else {
        showToast({ icon: "check", title: "已是最新", description: "默认 Skills 已全部存在于项目中" })
      }
      dialog.close()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", icon: "circle-x", title: "添加失败", description: message })
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog
      title="默认 Skills"
      action={
        <div class="flex items-center gap-1.5 -my-1">
          <Button
            variant="secondary"
            size="small"
            onClick={() => dialog.show(() => <DialogFindSkills directory={sdk.directory} />)}
          >
            <Icon name="brain" size="small" />
            Find Skills
          </Button>
          <Button variant="primary" size="small" disabled={adding()} onClick={handleAddToProject}>
            <Icon name="download" size="small" />
            {adding() ? "添加中..." : "添加到项目"}
          </Button>
        </div>
      }
    >
      <div class="flex flex-col gap-3 min-h-0">
        {/* Skill list */}
        <SolidSwitch>
          <Match when={skills.loading}>
            <div class="text-12-regular text-text-weak px-1">加载中...</div>
          </Match>
          <Match when={skills()?.length === 0}>
            <div class="text-12-regular text-text-weak px-1">
              暂无默认 Skills
            </div>
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
                        <span class="text-12-regular text-text-subtle italic">暂无描述</span>
                      </Show>
                    </div>
                    <div class="flex items-center shrink-0">
                      <Switch
                        checked={skill.enabled !== false}
                        disabled={toggling() === skill.name}
                        onChange={(checked) => handleToggle(skill.name, checked)}
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
