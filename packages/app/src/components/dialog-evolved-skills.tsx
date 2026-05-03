import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Component, For, Match, Show, Switch as SolidSwitch, createMemo, createResource, createSignal } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

type ManagedSkill = { name: string; description: string; content: string; category?: string; enabled?: boolean; evolution_enabled?: boolean; file?: string }
type SortMode = "path" | "category"

function parentDir(file: string): string {
  const normalized = file.replace(/\\/g, "/")
  const idx = normalized.lastIndexOf("/")
  return idx >= 0 ? normalized.slice(0, idx) : file
}

function shortenPath(dir: string): string {
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean)
  if (parts.length <= 4) return dir
  return ".../" + parts.slice(-4).join("/")
}

export const DialogEvolvedSkills: Component = () => {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const sdk = useSDK()

  const [sortMode, setSortMode] = createSignal<SortMode>("path")
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [skills, { refetch }] = createResource<ManagedSkill[]>(async () => {
    const result = await globalSDK.client.config.skills.listEvolution({ directory: sdk.directory })
    return (result.data as unknown as ManagedSkill[]) ?? []
  })
  const [toggling, setToggling] = createSignal<string | null>(null)
  const [togglingEvolution, setTogglingEvolution] = createSignal<string | null>(null)

  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function handleToggleEvolution(file: string, evolutionEnabled: boolean) {
    setTogglingEvolution(file)
    try {
      await globalSDK.client.config.skills.toggleEvolution({ file, evolutionEnabled })
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
      setTogglingEvolution(null)
    }
  }

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

  const groupedByPath = createMemo(() => {
    const list = skills() ?? []
    const map = new Map<string, ManagedSkill[]>()
    for (const skill of list) {
      const key = skill.file ? parentDir(skill.file) : ""
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(skill)
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, items]) => ({
        key: dir,
        label: dir ? shortenPath(dir) : language.t("evolvedSkills.builtIn"),
        fullPath: dir,
        items: [...items].sort((a, b) => a.name.localeCompare(b.name)),
      }))
  })

  const groupedByCategory = createMemo(() => {
    const list = skills() ?? []
    const map = new Map<string, ManagedSkill[]>()
    for (const skill of list) {
      const key = skill.category?.trim() || ""
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(skill)
    }
    const named = [...map.entries()]
      .filter(([k]) => k !== "")
      .sort(([a], [b]) => a.localeCompare(b))
    const uncategorized = map.get("")
    if (uncategorized?.length) named.push(["", uncategorized])
    return named.map(([cat, items]) => ({
      key: cat || "__uncategorized__",
      label: cat || language.t("evolvedSkills.uncategorized"),
      items: [...items].sort((a, b) => a.name.localeCompare(b.name)),
    }))
  })

  const currentGroups = createMemo(() =>
    sortMode() === "path" ? groupedByPath() : groupedByCategory(),
  )

  const SkillCard: Component<{ skill: ManagedSkill }> = (props) => (
    <div class="flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg border border-border-weak-base bg-surface-base hover:border-border-base transition-colors">
      <div class="flex flex-col gap-0.5 min-w-0 flex-1">
        <span class="text-13-medium text-text-strong truncate">{props.skill.name}</span>
        <Show when={props.skill.description}>
          <span class="text-12-regular text-text-weak line-clamp-2">{props.skill.description}</span>
        </Show>
        <Show when={!props.skill.description}>
          <span class="text-12-regular text-text-subtle italic">{language.t("evolvedSkills.noDescription")}</span>
        </Show>
        <Show when={props.skill.file}>
          <span class="text-11-regular text-text-subtle truncate font-mono" title={props.skill.file}>
            {props.skill.file}
          </span>
        </Show>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <Show when={props.skill.file}>
          <button
            class={[
              "px-2 py-0.5 rounded text-11-regular transition-colors disabled:opacity-40",
              props.skill.evolution_enabled !== false
                ? "text-text-weak hover:text-danger hover:bg-danger/10"
                : "text-success hover:bg-success/10",
            ].join(" ")}
            disabled={togglingEvolution() === props.skill.file}
            onClick={() => props.skill.file && handleToggleEvolution(props.skill.file, props.skill.evolution_enabled === false)}
          >
            {props.skill.evolution_enabled !== false
              ? language.t("evolvedSkills.disableEvolution")
              : language.t("evolvedSkills.enableEvolution")}
          </button>
        </Show>
        <Switch
          checked={props.skill.enabled !== false}
          disabled={toggling() === props.skill.file}
          onChange={(checked) => props.skill.file && handleToggle(props.skill.file, checked)}
        />
      </div>
    </div>
  )

  const ModeButton: Component<{ mode: SortMode; label: string }> = (props) => (
    <button
      class={[
        "px-2 py-0.5 rounded text-11-regular transition-colors",
        sortMode() === props.mode
          ? "bg-surface-selected text-text-strong"
          : "text-text-weak hover:text-text-base hover:bg-surface-hover",
      ].join(" ")}
      onClick={() => setSortMode(props.mode)}
    >
      {props.label}
    </button>
  )

  return (
    <Dialog
      title={language.t("evolvedSkills.title")}
      action={
        <div class="flex items-center gap-1 -my-1">
          <ModeButton mode="path" label={language.t("evolvedSkills.sortByPath")} />
          <ModeButton mode="category" label={language.t("evolvedSkills.sortByCategory")} />
        </div>
      }
    >
      <div class="flex flex-col gap-3 min-h-0">
        <SolidSwitch>
          <Match when={skills.loading}>
            <div class="text-12-regular text-text-weak px-1">{language.t("evolvedSkills.loading")}</div>
          </Match>
          <Match when={skills()?.length === 0}>
            <div class="text-12-regular text-text-weak px-1">{language.t("evolvedSkills.empty")}</div>
          </Match>
          <Match when={true}>
            <div class="flex flex-col gap-1 overflow-y-auto max-h-80">
              <For each={currentGroups()}>
                {(group) => {
                  const isOpen = () => expanded().has(group.key)
                  return (
                    <div class="flex flex-col">
                      <button
                        class="flex items-center gap-1.5 px-1 py-1 rounded hover:bg-surface-hover transition-colors text-left w-full"
                        onClick={() => toggleGroup(group.key)}
                      >
                        <Icon
                          name={isOpen() ? "chevron-down" : "chevron-right"}
                          size="small"
                          class="text-text-subtle shrink-0"
                        />
                        <span
                          class="text-11-regular text-text-subtle font-mono truncate flex-1"
                          title={"fullPath" in group ? (group.fullPath as string) : group.label}
                        >
                          {group.label}
                        </span>
                        <span class="text-11-regular text-text-subtle shrink-0">{group.items.length}</span>
                      </button>
                      <Show when={isOpen()}>
                        <div class="flex flex-col gap-1.5 mt-1 ml-4">
                          <For each={group.items}>{(skill) => <SkillCard skill={skill} />}</For>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </Match>
        </SolidSwitch>
      </div>
    </Dialog>
  )
}
