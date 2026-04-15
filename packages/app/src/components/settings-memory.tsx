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

type MemoryCfg = {
  cross_session_search_enabled: boolean
  cross_session_search_scope: "current_project" | "global"
  memory_reflection_enabled: boolean
}

function readCfg(input: Config): MemoryCfg {
  // Defensive defaults keep older configs compatible when the memory block is missing.
  const root = input as Record<string, unknown>
  const src = (typeof root.memory === "object" && root.memory ? root.memory : {}) as Record<string, unknown>
  return {
    cross_session_search_enabled: src.cross_session_search_enabled !== false,
    cross_session_search_scope: src.cross_session_search_scope === "global" ? "global" : "current_project",
    memory_reflection_enabled: src.memory_reflection_enabled !== false,
  }
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
      return result.data
    },
  )

  const scope = createMemo(
    () =>
      [
        { value: "current_project", label: language.t("settings.memory.scope.currentProject") },
        { value: "global", label: language.t("settings.memory.scope.global") },
      ] satisfies Array<{ value: MemoryCfg["cross_session_search_scope"]; label: string }>,
  )

  const update = async (patch: Partial<MemoryCfg>) => {
    const next = { ...cfg(), ...patch }
    const mergedConfig = {
      ...sync.data.config,
      memory: next,
    }
    await sync
      .updateConfig(mergedConfig)
      .then(() => actions.refetch())
      .catch((err: unknown) => {
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
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.memory.section.settings")}</h3>
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
        </div>

        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between pb-2">
            <h3 class="text-14-medium text-text-strong">{language.t("settings.memory.section.stores")}</h3>
            <Button size="small" variant="secondary" onClick={() => actions.refetch()}>
              {language.t("settings.memory.action.refresh")}
            </Button>
          </div>
          <Show when={data.loading}>
            <div class="text-12-regular text-text-weak">{language.t("settings.memory.loading")}</div>
          </Show>
          <Show when={!data.loading && !data()}>
            <div class="text-12-regular text-text-weak">{language.t("settings.memory.empty")}</div>
          </Show>
          <Show when={data()}>
            {(value) => (
              <div class="flex flex-col gap-3">
                <StoreCard
                  title={language.t("settings.memory.store.user")}
                  used={value().user.used}
                  limit={value().user.limit}
                  file={value().user.file}
                  entries={value().user.entries}
                />
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
  entries: string[]
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
      <div class="flex flex-col gap-2">
        <Show when={props.entries.length === 0}>
          <span class="text-12-regular text-text-weak">- (empty)</span>
        </Show>
        <For each={props.entries}>
          {(entry, idx) => (
            <div class="text-12-regular text-text-base">
              {idx() + 1}. {entry}
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
