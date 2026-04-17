import { type Component, type JSXElement, For, Show, createMemo, createResource } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { SettingsList } from "./settings-list"

type MemoryScope = "current_project" | "global"
type UserProfileSource = "explicit" | "inferred"
type UserProfileType = "style" | "workflow" | "preference" | "constraint" | "capability"

type MemoryCfg = {
  cross_session_search_enabled: boolean
  cross_session_search_scope: MemoryScope
  memory_reflection_enabled: boolean
  user_profile_enabled: boolean
  user_profile_include_inferred: boolean
}

type MemoryStore = {
  store: "user" | "memory"
  file: string
  limit: number
  used: number
  usage: number
  entries: string[]
}

type MemoryPayload = {
  settings: MemoryCfg
  user: MemoryStore
  memory: MemoryStore
}

const userProfileTypes = new Set<UserProfileType>(["style", "workflow", "preference", "constraint", "capability"])

function readBool(input: Record<string, unknown>, key: string, fallback: boolean) {
  const value = input[key]
  if (typeof value === "boolean") return value
  return fallback
}

function readCfg(input: Config): MemoryCfg {
  // Defensive defaults keep refactored/new-name configs compatible when memory config is missing.
  const root = input as Record<string, unknown>
  const src = (typeof root.memory === "object" && root.memory ? root.memory : {}) as Record<string, unknown>
  return {
    cross_session_search_enabled: readBool(src, "cross_session_search_enabled", true),
    cross_session_search_scope: src.cross_session_search_scope === "global" ? "global" : "current_project",
    memory_reflection_enabled: readBool(src, "memory_reflection_enabled", true),
    user_profile_enabled: readBool(src, "user_profile_enabled", true),
    user_profile_include_inferred: readBool(src, "user_profile_include_inferred", true),
  }
}

function splitUserEntries(entries: string[]) {
  const grouped: Record<UserProfileSource, string[]> = {
    explicit: [],
    inferred: [],
  }

  for (const raw of entries) {
    const candidate = raw.trim()
    if (!candidate) continue
    const normalized = candidate.replace(/^-+\s*/, "")
    const match = /^([a-z_]+)\[(explicit|inferred)\]\s*:\s*(.+)$/i.exec(normalized)
    if (!match) continue
    if (!userProfileTypes.has(match[1].toLowerCase() as UserProfileType)) continue
    const source = match[2].toLowerCase() as UserProfileSource
    grouped[source].push(normalized)
  }

  return grouped
}

function toMemoryPatch(patch: Partial<MemoryCfg>): Partial<NonNullable<Config["memory"]>> {
  const next: Partial<NonNullable<Config["memory"]>> = {}

  if ("cross_session_search_enabled" in patch) next.cross_session_search_enabled = patch.cross_session_search_enabled
  if ("cross_session_search_scope" in patch) next.cross_session_search_scope = patch.cross_session_search_scope
  if ("memory_reflection_enabled" in patch) next.memory_reflection_enabled = patch.memory_reflection_enabled
  if ("user_profile_enabled" in patch) next.user_profile_enabled = patch.user_profile_enabled
  if ("user_profile_include_inferred" in patch) next.user_profile_include_inferred = patch.user_profile_include_inferred

  return next
}

function asMemoryPayload(input: unknown): MemoryPayload {
  if (!input || typeof input !== "object") throw new Error("Invalid memory response")
  const payload = input as Partial<MemoryPayload>
  const user = payload.user as Partial<MemoryStore> | undefined
  const memory = payload.memory as Partial<MemoryStore> | undefined
  if (!payload.settings || typeof payload.settings !== "object") throw new Error("Invalid memory settings payload")
  if (!user || !Array.isArray(user.entries)) throw new Error("Invalid USER store payload")
  if (!memory || !Array.isArray(memory.entries)) throw new Error("Invalid MEMORY store payload")
  return payload as MemoryPayload
}

export const SettingsMemory: Component = () => {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()

  const cfg = createMemo(() => readCfg(sync.data.config))

  const [data, actions] = createResource(
    () => sync.data.path.directory,
    async (directory) => {
      const client = sdk.createClient({ directory, throwOnError: true })
      const result = await client.memory.get()
      return asMemoryPayload(result.data)
    },
  )

  const scope = createMemo(
    () =>
      [
        { value: "current_project", label: language.t("settings.memory.scope.currentProject") },
        { value: "global", label: language.t("settings.memory.scope.global") },
      ] satisfies Array<{ value: MemoryScope; label: string }>,
  )

  const profileEnabled = createMemo(() => cfg().user_profile_enabled)

  const profileEntries = createMemo(() => splitUserEntries(data()?.user.entries ?? []))

  let updateSeq = 0
  const update = async (patch: Partial<MemoryCfg>) => {
    const seq = ++updateSeq
    const memory = toMemoryPatch(patch)
    if (!Object.keys(memory).length) return
    sync.set("config", "memory", (prev) => ({ ...(prev ?? {}), ...memory }))

    await sync
      .updateConfig({ memory })
      .then(async () => {
        if (seq !== updateSeq) return
        await actions.refetch()
      })
      .catch((err: unknown) => {
        if (seq !== updateSeq) return
        void sync.bootstrap().catch(() => undefined)
        void Promise.resolve(actions.refetch()).catch(() => undefined)
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.memory.title")}</h2>
          <p class="text-14-regular text-text-weak">{language.t("settings.memory.description")}</p>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full max-w-[760px]">
        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between pb-2">
            <h3 class="text-14-medium text-text-strong">{language.t("settings.memory.section.memory")}</h3>
            <Button size="small" variant="secondary" onClick={() => actions.refetch()}>
              {language.t("settings.memory.action.refresh")}
            </Button>
          </div>
          <SettingsList>
            <Row
              title={language.t("settings.memory.row.crossSessionEnabled.title")}
              description={language.t("settings.memory.row.crossSessionEnabled.description")}
            >
              <Switch
                checked={cfg().cross_session_search_enabled}
                onChange={(value) => void update({ cross_session_search_enabled: value })}
              />
            </Row>
            <Row
              title={language.t("settings.memory.row.scope.title")}
              description={language.t("settings.memory.row.scope.description")}
            >
              <Select
                data-action="settings-memory-scope"
                options={scope()}
                value={(item) => item.value}
                label={(item) => item.label}
                current={scope().find((item) => item.value === cfg().cross_session_search_scope)}
                onSelect={(item) => item && void update({ cross_session_search_scope: item.value })}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </Row>
            <Row
              title={language.t("settings.memory.row.reflection.title")}
              description={language.t("settings.memory.row.reflection.description")}
            >
              <Switch
                checked={cfg().memory_reflection_enabled}
                onChange={(value) => void update({ memory_reflection_enabled: value })}
              />
            </Row>
          </SettingsList>
          <Show when={data()}>
            {(value) => (
              <div class="pt-3">
                <StoreCard
                  title={language.t("settings.memory.store.memory")}
                  used={value().memory.used}
                  limit={value().memory.limit}
                  file={value().memory.file}
                  entries={value().memory.entries}
                />
              </div>
            )}
          </Show>
        </div>

        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.memory.section.userProfile")}</h3>
          <SettingsList>
            <Row
              title={language.t("settings.memory.row.userProfileEnabled.title")}
              description={language.t("settings.memory.row.userProfileEnabled.description")}
            >
              <Switch checked={profileEnabled()} onChange={(value) => void update({ user_profile_enabled: value })} />
            </Row>
            <Row
              title={language.t("settings.memory.row.includeInferred.title")}
              description={language.t("settings.memory.row.includeInferred.description")}
            >
              <Switch
                disabled={!profileEnabled()}
                checked={cfg().user_profile_include_inferred}
                onChange={(value) => void update({ user_profile_include_inferred: value })}
              />
            </Row>
          </SettingsList>

          <Show when={!profileEnabled()}>
            <div class="pt-3 text-12-regular text-text-weak">{language.t("settings.memory.userProfile.disabledHint")}</div>
          </Show>
          <Show when={profileEnabled() && data()}>
            {(value) => (
              <div class="pt-3">
                <StoreCard
                  title={language.t("settings.memory.store.userProfile")}
                  used={value().user.used}
                  limit={value().user.limit}
                  file={value().user.file}
                  groups={[
                    {
                      title: language.t("settings.memory.userProfile.group.explicit"),
                      entries: profileEntries().explicit,
                    },
                    {
                      title: language.t("settings.memory.userProfile.group.inferred"),
                      entries: profileEntries().inferred,
                    },
                  ]}
                  emptyText={language.t("settings.memory.userProfile.emptyValid")}
                />
              </div>
            )}
          </Show>
        </div>

        <Show when={data.loading}>
          <div class="text-12-regular text-text-weak">{language.t("settings.memory.loading")}</div>
        </Show>
        <Show when={data.error}>
          <div class="text-12-regular text-text-danger">
            {language.t("settings.memory.error.loadFailed", {
              message: data.error instanceof Error ? data.error.message : String(data.error),
            })}
          </div>
        </Show>
        <Show when={!data.loading && !data() && !data.error}>
          <div class="text-12-regular text-text-weak">{language.t("settings.memory.empty")}</div>
        </Show>
      </div>
    </div>
  )
}

const Row: Component<{ title: string; description: string; children: JSXElement }> = (props) => {
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

const StoreCard: Component<{
  title: string
  used: number
  limit: number
  file: string
  entries?: string[]
  groups?: Array<{ title: string; entries: string[] }>
  emptyText?: string
}> = (props) => {
  return (
    <div class="rounded-lg border border-border-weak-base bg-surface-raised-base p-4">
      <div class="flex flex-col gap-0.5 pb-3">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">
          {props.used}/{props.limit}
        </span>
        <span class="text-12-regular text-text-dim truncate">{props.file}</span>
      </div>
      <Show
        when={props.groups}
        fallback={
          <div class="flex flex-col gap-2">
            <Show when={(props.entries?.length ?? 0) === 0}>
              <span class="text-12-regular text-text-weak">{props.emptyText ?? "- (empty)"}</span>
            </Show>
            <For each={props.entries ?? []}>
              {(entry, idx) => (
                <div class="text-12-regular text-text-base">
                  {idx() + 1}. {entry}
                </div>
              )}
            </For>
          </div>
        }
      >
        {(groups) => (
          <div class="flex flex-col gap-3">
            <For each={groups()}>
              {(group) => (
                <div class="flex flex-col gap-2">
                  <span class="text-12-medium text-text-weak uppercase tracking-[0.04em]">{group.title}</span>
                  <Show when={group.entries.length > 0}>
                    <For each={group.entries}>
                      {(entry, idx) => (
                        <div class="text-12-regular text-text-base">
                          {idx() + 1}. {entry}
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              )}
            </For>
            <Show when={groups().every((group) => group.entries.length === 0)}>
              <span class="text-12-regular text-text-weak">{props.emptyText ?? "- (empty)"}</span>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
