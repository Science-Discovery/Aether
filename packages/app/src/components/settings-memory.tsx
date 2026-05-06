import { type Component, type JSXElement, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { SettingsList } from "./settings-list"

type UserProfileSource = "explicit" | "inferred"
type UserProfileType = "fact" | "preference" | "task"

type MemoryCfg = {
  enabled: boolean
}

type MemoryStore = {
  store: "user" | "memory"
  file: string
  limit: number
  used: number
  usage: number
  entries: string[]
}

type ActiveMemory = {
  session_id: string
  prompt: string
  entries: Array<{
    source: "user" | "daily" | "session" | "inbox"
    store?: "user" | "memory"
    index: number
    text: string
  }>
}

type DailyMemory = {
  root: string
  days: Array<{
    date: string
    file: string
    entries: string[]
    invalid_entries: number
  }>
}

type RefreshScope = "current_project" | "global"
type RefreshState = "pending" | "running" | "completed" | "blocked_by_disabled" | "failed"
type RefreshRunStatus = "running" | "success" | "blocked" | "failed" | "noop"
type RefreshStatus = {
  memory_version: string
  state: RefreshState
  refresh_required: boolean
  noop: boolean
  run_status?: RefreshRunStatus
  candidate_count?: number
  promoted_daily_count?: number
  promoted_user_count?: number
  cache_refresh_error?: string
  error?: string
}
type RefreshRun = {
  run_id: string
  memory_version: string
  scope: RefreshScope
  dry_run: boolean
  status: RefreshRunStatus
  started_at: number
  finished_at?: number
  candidate_count?: number
  promoted_daily_count?: number
  promoted_user_count?: number
  cache_refresh_error?: string
  error?: string
}
type RefreshResult = {
  status: RefreshStatus
  run?: RefreshRun
}
type Summary = {
  status: string
  candidates: number
  daily: number
  user: number
  error?: string
}

type MemoryPayload = {
  settings: MemoryCfg
  user: MemoryStore
  memory: MemoryStore
  daily: DailyMemory
  active?: ActiveMemory
  refresh?: RefreshStatus
}

const [running, setRunning] = createSignal(false)

const userProfileTypes = new Set<UserProfileType>(["fact", "preference", "task"])

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
    enabled: readBool(src, "enabled", true),
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
  const next: Record<string, unknown> = {}

  if ("enabled" in patch) next.enabled = patch.enabled

  return next as Partial<NonNullable<Config["memory"]>>
}

function asMemoryPayload(input: unknown): MemoryPayload {
  if (!input || typeof input !== "object") throw new Error("Invalid memory response")
  const payload = input as Partial<MemoryPayload>
  const user = payload.user as Partial<MemoryStore> | undefined
  const memory = payload.memory as Partial<MemoryStore> | undefined
  if (!payload.settings || typeof payload.settings !== "object") throw new Error("Invalid memory settings payload")
  if (!user || !Array.isArray(user.entries)) throw new Error("Invalid USER store payload")
  if (!memory || !Array.isArray(memory.entries)) throw new Error("Invalid MEMORY store payload")
  if (!payload.daily || !Array.isArray(payload.daily.days)) throw new Error("Invalid daily memory payload")
  return payload as MemoryPayload
}

function asRefreshResult(input: unknown): RefreshResult {
  if (!input || typeof input !== "object") throw new Error("Invalid memory refresh response")
  const payload = input as Partial<RefreshResult>
  if (!payload.status || typeof payload.status !== "object") throw new Error("Invalid memory refresh status payload")
  return payload as RefreshResult
}

function count(input: number | undefined) {
  return input ?? 0
}

function summarize(input: RefreshResult): Summary {
  const run = input.run
  return {
    status: run?.status ?? input.status.run_status ?? input.status.state,
    candidates: count(run?.candidate_count ?? input.status.candidate_count),
    daily: count(run?.promoted_daily_count ?? input.status.promoted_daily_count),
    user: count(run?.promoted_user_count ?? input.status.promoted_user_count),
    error: run?.error ?? run?.cache_refresh_error ?? input.status.error ?? input.status.cache_refresh_error,
  }
}

function statusKey(input: string) {
  switch (input) {
    case "success":
      return "settings.memory.backfill.result.status.success"
    case "noop":
      return "settings.memory.backfill.result.status.noop"
    case "blocked":
      return "settings.memory.backfill.result.status.blocked"
    case "blocked_by_disabled":
      return "settings.memory.backfill.result.status.blockedByDisabled"
    case "failed":
      return "settings.memory.backfill.result.status.failed"
    case "running":
      return "settings.memory.backfill.result.status.running"
    case "pending":
      return "settings.memory.backfill.result.status.pending"
    case "completed":
      return "settings.memory.backfill.result.status.completed"
  }
  return "settings.memory.backfill.result.status.unknown"
}

export const SettingsMemory: Component = () => {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const params = useParams()
  const language = useLanguage()
  const dialog = useDialog()

  const cfg = createMemo(() => readCfg(globalSync.data.config))
  const blocked = createMemo(() => running() || !cfg().enabled)
  const activeSessionID = createMemo(() => {
    const value = params.id?.trim()
    return value || undefined
  })
  const activeWorkspaceID = createMemo(() => {
    const sessionID = activeSessionID()
    if (!sessionID) return undefined
    const directory = globalSync.data.path.directory
    if (!directory) return undefined
    const [child] = globalSync.peek(directory, { bootstrap: false })
    const value = child.session.find((item) => item.id === sessionID)?.workspaceID
    if (typeof value !== "string") return undefined
    const normalized = value.trim()
    return normalized || undefined
  })

  const [data, actions] = createResource(
    () => ({
      directory: globalSync.data.path.directory,
      sessionID: activeSessionID(),
      workspaceID: activeWorkspaceID(),
    }),
    async ({ directory, sessionID, workspaceID }) => {
      const client = sdk.createClient({ directory, experimental_workspaceID: workspaceID, throwOnError: true })
      const result = await client.memory.get({ sessionID })
      return asMemoryPayload(result.data)
    },
  )

  const profileEntries = createMemo(() => splitUserEntries(data()?.user.entries ?? []))

  const backfill = async () => {
    if (running()) return
    setRunning(true)
    try {
      const client = sdk.createClient({
        directory: globalSync.data.path.directory,
        experimental_workspaceID: activeWorkspaceID(),
        throwOnError: true,
      })
      const result = await client.memory.refresh.run({ scope: "global" })
      const payload = asRefreshResult(result.data)
      await Promise.resolve(actions.refetch()).catch(() => undefined)
      dialog.show(() => <BackfillDialog summary={summarize(payload)} />)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("settings.memory.error.backfillFailed", { message }),
      })
    } finally {
      setRunning(false)
    }
  }

  let updateSeq = 0
  const update = async (patch: Partial<MemoryCfg>) => {
    const seq = ++updateSeq
    const memory = toMemoryPatch(patch)
    if (!Object.keys(memory).length) return
    globalSync.set("config", "memory", (prev) => ({ ...(prev ?? {}), ...memory }))

    await globalSync
      .updateConfig({ memory })
      .then(async () => {
        if (seq !== updateSeq) return
        await actions.refetch()
      })
      .catch((err: unknown) => {
        if (seq !== updateSeq) return
        void globalSync.bootstrap().catch(() => undefined)
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
              title={language.t("settings.memory.row.enabled.title")}
              description={language.t("settings.memory.row.enabled.description")}
            >
              <Switch checked={cfg().enabled} onChange={(value) => void update({ enabled: value })} />
            </Row>
            <Row
              title={language.t("settings.memory.row.backfill.title")}
              description={language.t("settings.memory.row.backfill.description")}
            >
              <div class="flex flex-col items-end gap-1">
                <span
                  class="inline-flex"
                  title={running() ? language.t("settings.memory.backfill.runningTooltip") : undefined}
                >
                  <Button
                    size="small"
                    variant="secondary"
                    icon="reset"
                    disabled={blocked()}
                    onClick={() => void backfill()}
                  >
                    {language.t(
                      running() ? "settings.memory.action.backfilling" : "settings.memory.action.backfill",
                    )}
                  </Button>
                </span>
                <Show when={running()}>
                  <span class="text-12-regular text-text-weak" role="status" aria-live="polite">
                    {language.t("settings.memory.backfill.runningHint")}
                  </span>
                </Show>
              </div>
            </Row>
          </SettingsList>
          <Show when={data()?.active}>
            {(active) => (
              <div class="pt-3">
                <ActiveMemoryCard
                  title={language.t("settings.memory.store.activeSession")}
                  description={language.t("settings.memory.store.activeSession.description")}
                  sessionID={active().session_id}
                  prompt={active().prompt}
                  entries={active().entries}
                />
              </div>
            )}
          </Show>
          <Show when={data()}>
            {(value) => (
              <div class="pt-3">
                <DailyMemoryCard title={language.t("settings.memory.store.daily")} daily={value().daily} />
              </div>
            )}
          </Show>
        </div>

        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.memory.section.userProfile")}</h3>
          <Show when={data()}>
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

const BackfillDialog: Component<{ summary: Summary }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const label = createMemo(() => language.t(statusKey(props.summary.status)))

  return (
    <Dialog
      title={<span class="block w-full text-center">{language.t("settings.memory.backfill.result.title")}</span>}
    >
      <div class="mx-auto flex w-full min-w-0 max-w-[560px] flex-col items-center gap-4 text-center">
        <div class="text-12-regular text-text-weak">
          {language.t("settings.memory.backfill.result.status", { status: label() })}
        </div>
        <div class="grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
          <Metric label={language.t("settings.memory.backfill.result.candidates")} value={props.summary.candidates} />
          <Metric label={language.t("settings.memory.backfill.result.daily")} value={props.summary.daily} />
          <Metric label={language.t("settings.memory.backfill.result.user")} value={props.summary.user} />
        </div>
        <Show when={props.summary.error}>
          {(err) => <div class="text-12-regular text-text-danger">{err()}</div>}
        </Show>
        <div class="flex justify-center">
          <Button size="small" variant="primary" icon="check" onClick={() => dialog.close()}>
            {language.t("settings.memory.backfill.result.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const Metric: Component<{ label: string; value: number }> = (props) => {
  return (
    <div class="flex min-h-[76px] flex-col items-center justify-between rounded-md border border-border-weak-base bg-surface-base p-3 text-center">
      <span class="text-12-regular text-text-weak">{props.label}</span>
      <span class="text-20-medium text-text-strong">{props.value}</span>
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

const DailyMemoryCard: Component<{
  title: string
  daily: DailyMemory
}> = (props) => {
  return (
    <div class="rounded-lg border border-border-weak-base bg-surface-raised-base p-4">
      <div class="flex flex-col gap-0.5 pb-3">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">Recent {props.daily.days.length} active day(s)</span>
        <span class="text-12-regular text-text-dim truncate">{props.daily.root}</span>
      </div>
      <Show
        when={props.daily.days.length > 0}
        fallback={<span class="text-12-regular text-text-weak">- (empty)</span>}
      >
        <div class="flex flex-col gap-4">
          <For each={props.daily.days}>
            {(day) => (
              <div class="flex flex-col gap-2">
                <div class="flex flex-col gap-0.5">
                  <span class="text-12-medium text-text-weak uppercase tracking-[0.04em]">{day.date}</span>
                  <span class="text-12-regular text-text-dim truncate">{day.file}</span>
                </div>
                <For each={day.entries}>
                  {(entry, idx) => (
                    <div class="text-12-regular text-text-base">
                      {idx() + 1}. {entry}
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

const ActiveMemoryCard: Component<{
  title: string
  description: string
  sessionID: string
  prompt: string
  entries: ActiveMemory["entries"]
}> = (props) => {
  return (
    <div class="rounded-lg border border-border-weak-base bg-surface-raised-base p-4">
      <div class="flex flex-col gap-0.5 pb-3">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
        <span class="text-12-regular text-text-dim truncate">session: {props.sessionID}</span>
      </div>
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-2">
          <span class="text-12-medium text-text-weak uppercase tracking-[0.04em]">Active entries</span>
          <Show
            when={props.entries.length > 0}
            fallback={<span class="text-12-regular text-text-weak">- (empty)</span>}
          >
            <For each={props.entries}>
              {(entry, idx) => (
                <div class="text-12-regular text-text-base">
                  {idx() + 1}. [{entry.source}] {entry.text}
                </div>
              )}
            </For>
          </Show>
        </div>
        <details class="rounded-md border border-border-weak-base bg-surface-base p-3">
          <summary class="cursor-pointer text-12-medium text-text-weak">Prompt preview</summary>
          <pre class="mt-2 whitespace-pre-wrap break-words text-12-regular text-text-base">{props.prompt}</pre>
        </details>
      </div>
    </div>
  )
}
