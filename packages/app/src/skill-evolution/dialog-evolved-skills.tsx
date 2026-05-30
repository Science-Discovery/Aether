import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import {
  Component,
  For,
  Match,
  Show,
  Suspense,
  Switch as SolidSwitch,
  createMemo,
  createResource,
  createSignal,
} from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

type EvolvedSkill = {
  name: string
  description: string
  content: string
  category?: string
  enabled?: boolean
  evolution_enabled?: boolean
  file?: string
}
type SortMode = "path" | "category"

/**
 * The container directory a skill belongs to, i.e. the `.../skills` folder.
 * A skill file is `.../skills/<name>/SKILL.md`, so we drop both the filename
 * and the per-skill folder to group by the container rather than by each skill.
 */
function containerDir(file: string): string {
  const normalized = file.replace(/\\/g, "/")
  const fileIdx = normalized.lastIndexOf("/")
  const skillDir = fileIdx >= 0 ? normalized.slice(0, fileIdx) : file
  const dirIdx = skillDir.lastIndexOf("/")
  return dirIdx >= 0 ? skillDir.slice(0, dirIdx) : skillDir
}

function shortenPath(dir: string): string {
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean)
  if (parts.length <= 4) return dir
  return ".../" + parts.slice(-4).join("/")
}

// Inner component holds the createResource call. The exported DialogEvolvedSkills
// wraps this in a local <Suspense>, so the first-mount fetch is caught here instead
// of bubbling up to the app-shell Suspense (which would unmount the whole Session
// subtree → full-page flash on open).
const DialogEvolvedSkillsInner: Component = () => {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const sdk = useSDK()

  const [sortMode, setSortMode] = createSignal<SortMode>("path")
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [skills, { mutate }] = createResource<EvolvedSkill[]>(async () => {
    const result = await globalSDK.client.config.skills.listEvolution({ directory: sdk.directory })
    return (result.data as unknown as EvolvedSkill[]) ?? []
  })

  // Optimistic local patch of one skill's flag, returning a rollback fn. We patch
  // the resource's current value via mutate() instead of refetch()-ing, because a
  // refetch puts the resource back into a pending state, which makes the wrapping
  // <Suspense> swap the whole dialog body for its fallback — the visible flash.
  // The backend still applies the change (and its cache refresh); we just avoid
  // re-pulling the list. On failure we call the returned rollback to restore the
  // prior flag value so the UI never shows a state the backend didn't accept.
  function patchSkill(file: string, key: "enabled" | "evolution_enabled", value: boolean): () => void {
    const prevList = skills.latest
    mutate((list) => (list ?? []).map((s) => (s.file === file ? { ...s, [key]: value } : s)))
    return () => mutate(prevList)
  }
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
    // Optimistically flip the UI first (no refetch → no Suspense flash).
    const rollback = patchSkill(file, "evolution_enabled", evolutionEnabled)
    try {
      // Use the directory-scoped client so the backend resolves the same project
      // Instance the skill belongs to (and writes that project's config, not the
      // server's default workdir).
      await sdk.client.config.skills.toggleEvolution({ file, evolutionEnabled })
    } catch (err) {
      rollback() // Backend rejected → restore the prior flag value.
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
    // Optimistically flip the UI first (no refetch → no Suspense flash).
    const rollback = patchSkill(file, "enabled", enabled)
    try {
      // Directory-scoped client: see handleToggleEvolution.
      await sdk.client.config.skills.toggleEvolved({ file, enabled })
    } catch (err) {
      rollback() // Backend rejected → restore the prior flag value.
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
    const map = new Map<string, EvolvedSkill[]>()
    for (const skill of list) {
      const key = skill.file ? containerDir(skill.file) : ""
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
    const map = new Map<string, EvolvedSkill[]>()
    for (const skill of list) {
      const key = skill.category?.trim() || ""
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(skill)
    }
    const named = [...map.entries()].filter(([k]) => k !== "").sort(([a], [b]) => a.localeCompare(b))
    const uncategorized = map.get("")
    if (uncategorized?.length) named.push(["", uncategorized])
    return named.map(([cat, items]) => ({
      key: cat || "__uncategorized__",
      label: cat || language.t("evolvedSkills.uncategorized"),
      items: [...items].sort((a, b) => a.name.localeCompare(b.name)),
    }))
  })

  const currentGroups = createMemo(() => (sortMode() === "path" ? groupedByPath() : groupedByCategory()))

  const SkillCard: Component<{ skill: EvolvedSkill }> = (props) => (
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
            onClick={() =>
              props.skill.file && handleToggleEvolution(props.skill.file, props.skill.evolution_enabled === false)
            }
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
      <div class="flex flex-col gap-3 h-[400px]">
        <SolidSwitch>
          {/* Gate on state === "pending" (first load, no data yet) — NOT .loading,
              which is also true during a refetch (after toggling a switch) and
              would swap the list out for "loading…", causing the flash. Same
              idiom the app shell uses for its startup resource (app.tsx). */}
          <Match when={skills.state === "pending"}>
            <div class="flex-1 flex items-center justify-center text-12-regular text-text-weak px-1">
              {language.t("evolvedSkills.loading")}
            </div>
          </Match>
          {/* "ready" means we have a successful value; show empty only then, and
              only when that value is actually empty. During a refetch the state
              is "refreshing" (not "ready"), so this won't flash "empty" either. */}
          <Match when={skills.state === "ready" && skills()?.length === 0}>
            <div class="flex-1 flex items-center justify-center text-12-regular text-text-weak px-1">
              {language.t("evolvedSkills.empty")}
            </div>
          </Match>
          <Match when={true}>
            <div class="flex flex-col gap-1 overflow-y-auto flex-1">
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

// Fallback shown while the inner Suspense resolves on first mount. Keeps the dialog
// shell (and the same h-[400px] body height) so opening the dialog never flashes the host
// page or jumps in height.
const DialogEvolvedSkillsLoading: Component = () => {
  const language = useLanguage()
  return (
    <Dialog title={language.t("evolvedSkills.title")}>
      <div class="flex flex-col gap-3 h-[400px]">
        <div class="flex-1 flex items-center justify-center text-12-regular text-text-weak px-1">
          {language.t("evolvedSkills.loading")}
        </div>
      </div>
    </Dialog>
  )
}

export const DialogEvolvedSkills: Component = () => (
  <Suspense fallback={<DialogEvolvedSkillsLoading />}>
    <DialogEvolvedSkillsInner />
  </Suspense>
)
