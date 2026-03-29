import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
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
import { useFile } from "@/context/file"

type DefaultSkill = { name: string; description: string; content: string; enabled?: boolean }

export const DefaultSkillsPanel: Component = () => {
  const globalSDK = useGlobalSDK()
  const sdk = useSDK()
  const file = useFile()

  const [skills, { refetch }] = createResource<DefaultSkill[]>(async () => {
    const result = await globalSDK.client.config.skills.list()
    return ((result.data as unknown) as DefaultSkill[]) ?? []
  })

  const [collapsed, setCollapsed] = createSignal(true)
  const [listHeight, setListHeight] = createSignal(208)
  let resizing = false
  let startY = 0
  let startHeight = 0

  const onResizeStart = (e: MouseEvent) => {
    e.preventDefault()
    resizing = true
    startY = e.clientY
    startHeight = listHeight()
    const onMove = (e: MouseEvent) => {
      if (!resizing) return
      const delta = e.clientY - startY
      setListHeight(Math.max(80, Math.min(600, startHeight - delta)))
    }
    const onUp = () => {
      resizing = false
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }
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
        void file.tree.refresh("")
        showToast({
          variant: "success",
          icon: "circle-check",
          title: "Skills 已复制到项目",
          description: `已复制：${added.join(", ")}`,
        })
      } else {
        showToast({ icon: "check", title: "已是最新", description: "默认 Skills 已全部存在于项目中" })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", icon: "circle-x", title: "添加失败", description: message })
    } finally {
      setAdding(false)
    }
  }

  return (
    <div class="flex flex-col gap-3 w-full">
      {/* Header row */}
      <div
        class="flex items-center justify-between gap-2 cursor-pointer select-none"
        onClick={() => setCollapsed((c) => !c)}
      >
        <div class="flex items-center gap-2">
          <Icon name="brain" size="small" class="text-icon-base shrink-0" />
          <span class="text-13-medium text-text-strong">默认 Skills</span>
          <Show when={skills()}>
            <span class="text-12-regular text-text-weak">({skills()!.length})</span>
          </Show>
        </div>
        <div class="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Show when={!collapsed()}>
            <Button
              variant="primary"
              size="small"
              disabled={adding()}
              onClick={handleAddToProject}
            >
              <Icon name="download" size="small" />
              {adding() ? "添加中..." : "添加到项目"}
            </Button>
          </Show>
          <Icon
            name={collapsed() ? "chevron-right" : "chevron-down"}
            size="small"
            class="text-icon-weak"
          />
        </div>
      </div>

      {/* Skill list */}
      <Show when={!collapsed()}>
      {/* Resize handle */}
      <div
        class="flex items-center justify-center h-4 w-full cursor-ns-resize group -mb-1"
        onMouseDown={onResizeStart}
        title="向上拖动可扩大列表高度"
      >
        <div class="h-1 w-10 rounded-full bg-border-weak-base group-hover:bg-border-base transition-colors" />
      </div>
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
          <div class="flex flex-col gap-1.5 overflow-y-auto pr-0.5" style={{ "max-height": `${listHeight()}px` }}>
            <For each={skills()}>
              {(skill) => (
                <div class="flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg border border-border-weak-base bg-surface-base hover:border-border-base transition-colors">
                  <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                    <span class="text-13-medium text-text-strong truncate">{skill.name}</span>
                    <Show when={skill.description}>
                      <span class="text-12-regular text-text-weak truncate">{skill.description}</span>
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
      </Show>
    </div>
  )
}
