import { type Component, For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"

type MemorySearchResult = {
  id: string
  type: "preference" | "fact" | "task"
  scope: string
  memory: string
  confidence: number
  weight: number
  score: number
  ranking_note: string
}

function numberValue(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : 0
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input : ""
}

export const SettingsMemory: Component = () => {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const [searchText, setSearchText] = createSignal("")
  const [searching, setSearching] = createSignal(false)
  const [reflecting, setReflecting] = createSignal(false)
  const [initializing, setInitializing] = createSignal(false)
  const [stoppingInitialize, setStoppingInitialize] = createSignal(false)
  const [results, setResults] = createSignal<MemorySearchResult[]>([])

  const [status, statusActions] = createResource(async () => {
    const result = await sdk.client.memory.status()
    return result.data ?? {}
  })
  let progressTimer: ReturnType<typeof setInterval> | undefined

  const stopProgressPolling = () => {
    if (!progressTimer) return
    clearInterval(progressTimer)
    progressTimer = undefined
  }

  const startProgressPolling = () => {
    stopProgressPolling()
    progressTimer = setInterval(() => {
      void statusActions.refetch()
    }, 1500)
  }

  onCleanup(stopProgressPolling)

  const configMemory = createMemo(() => {
    const config = globalSync.data.config as Record<string, unknown>
    return typeof config.memory === "object" && config.memory ? (config.memory as Record<string, unknown>) : {}
  })

  const memoryEnabled = createMemo(() => configMemory().enabled !== false)
  const dailyReflect = createMemo(() => {
    const daily = configMemory().dailyReflect
    return typeof daily === "object" && daily ? (daily as Record<string, unknown>) : {}
  })
  const dailyEnabled = createMemo(() => dailyReflect().enabled !== false)
  const dailyTime = createMemo(() => stringValue(dailyReflect().time) || "03:00")
  const initialization = createMemo(() => {
    const value = status()?.initialization
    return typeof value === "object" && value ? (value as Record<string, unknown>) : {}
  })
  const initializationStatus = createMemo(() => stringValue(initialization().status) || "idle")
  const initializationStarted = createMemo(() => initializationStatus() !== "idle")
  const initializationRunning = createMemo(
    () => initializing() || initializationStatus() === "running" || initializationStatus() === "reflecting",
  )

  const updateMemoryConfig = async (patch: Record<string, unknown>) => {
    ;(globalSync.set as (...input: unknown[]) => unknown)("config", (prev: unknown) => ({
      ...(prev as Record<string, unknown>),
      memory: {
        ...(((prev as Record<string, unknown>).memory as Record<string, unknown> | undefined) ?? {}),
        ...patch,
      },
    }))
    await globalSync.updateConfig({ memory: patch } as Parameters<typeof globalSync.updateConfig>[0])
    await statusActions.refetch()
  }

  const updateDailyConfig = async (patch: Record<string, unknown>) => {
    const next = {
      ...dailyReflect(),
      ...patch,
    }
    await updateMemoryConfig({ dailyReflect: next })
    await sdk.client.memory.dailyReflect.sync()
  }

  const runSearch = async () => {
    const query = searchText().trim()
    if (!query) return
    setSearching(true)
    await sdk.client.memory
      .search({ query, limit: 5 })
      .then((result) => {
        setResults(((result.data?.results as MemorySearchResult[] | undefined) ?? []) as MemorySearchResult[])
      })
      .catch((error: unknown) => {
        showToast({
          title: language.t("memory.search.failed"),
          description: formatServerError(error, language.t),
        })
      })
      .finally(() => setSearching(false))
  }

  const runReflect = async (mode: "quick" | "daily") => {
    setReflecting(true)
    await sdk.client.memory
      .reflect({ mode, reason: "settings-memory" })
      .then((result) => {
        showToast({ title: language.t("memory.reflect.finished"), description: String(result.data?.summary ?? "") })
        void statusActions.refetch()
      })
      .catch((error: unknown) => {
        showToast({
          title: "Memory reflection failed",
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => setReflecting(false))
  }

  const startInitialize = async () => {
    setInitializing(true)
    setStoppingInitialize(false)
    startProgressPolling()
    showToast({ title: language.t("memory.init.start"), description: language.t("memory.init.startDescription") })
    await sdk.client.memory.initialize
      .start()
      .then((result) => {
        const scanned = numberValue(result.data?.scanned)
        const imported = numberValue(result.data?.imported)
        showToast({
          title: language.t("memory.init.finished"),
          description: language.t("memory.init.finishedDescription", { scanned, imported }),
        })
        void statusActions.refetch()
      })
      .catch((error: unknown) => {
        showToast({
          title: language.t("memory.init.failed"),
          description: formatServerError(error, language.t),
        })
      })
      .finally(() => {
        stopProgressPolling()
        setInitializing(false)
        setStoppingInitialize(false)
        void statusActions.refetch()
      })
  }

  const stopInitialize = async () => {
    setStoppingInitialize(true)
    await sdk.client.memory.initialize
      .cancel()
      .then(() => {
        showToast({
          title: language.t("memory.init.stopping"),
          description: language.t("memory.init.stoppingDescription"),
        })
        void statusActions.refetch()
      })
      .catch((error: unknown) => {
        setStoppingInitialize(false)
        showToast({
          title: language.t("memory.init.stopFailed"),
          description: formatServerError(error, language.t),
        })
      })
  }

  return (
    <div class="flex h-full flex-col overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex items-start justify-between gap-4 pt-6 pb-8 max-w-[920px]">
          <div>
            <h2 class="text-16-medium text-text-strong">Memory</h2>
            <p class="text-14-regular text-text-weak mt-1">
              Manage Aether long-term memory, daily reflection, and real search behavior.
            </p>
          </div>
          <Button size="small" variant="secondary" onClick={() => statusActions.refetch()}>
            Refresh
          </Button>
        </div>
      </div>

      <div class="flex w-full max-w-[920px] flex-col gap-5">
        <div class="rounded-lg border border-border-weak-base bg-surface-raised-base p-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <div class="text-14-medium text-text-strong">Import previous conversations</div>
            <div class="text-12-regular text-text-weak">
              Scan old sessions serially and extract useful long-term memories. This is visible even after
              initialization so you can recover from a failed or empty import.
            </div>
            <div class="mt-2 text-11-regular text-text-dim">
              {status()?.markdown_exists
                ? "Current memory file exists; imported items will be merged through reflection."
                : status()?.has_history_sessions
                  ? "Historical sessions detected."
                  : "No historical sessions were detected yet; running import is safe and will report zero if none exist."}
            </div>
            <Show when={initializationStarted()}>
              <div class="mt-3 rounded-md border border-border-weak-base bg-surface-base px-3 py-2 text-12-regular text-text-weak">
                <div class="flex flex-wrap gap-x-4 gap-y-1">
                  <span>Status: {initializationStatus()}</span>
                  <span>Scanned: {numberValue(initialization().scanned)}</span>
                  <span>Imported: {numberValue(initialization().imported)}</span>
                </div>
                <Show when={stringValue(initialization().current_session_id)}>
                  <div class="mt-1 truncate">Current session: {stringValue(initialization().current_session_id)}</div>
                </Show>
              </div>
            </Show>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button size="small" disabled={initializing()} onClick={startInitialize}>
              {initializing() ? "Importing..." : "Import memories"}
            </Button>
            <Show when={initializationRunning()}>
              <Button size="small" variant="secondary" disabled={stoppingInitialize()} onClick={stopInitialize}>
                {stoppingInitialize() ? "Stopping..." : "Stop import"}
              </Button>
            </Show>
          </div>
        </div>

        <section class="rounded-lg border border-border-weak-base bg-surface-raised-base p-4 flex flex-col gap-3">
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="text-14-medium text-text-strong">Memory enabled</div>
              <div class="text-12-regular text-text-weak">
                Disable this to stop memory hooks, tools, and reflection.
              </div>
            </div>
            <Switch checked={memoryEnabled()} onChange={(enabled) => updateMemoryConfig({ enabled })} />
          </div>
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="text-14-medium text-text-strong">Daily reflection</div>
              <div class="text-12-regular text-text-weak">
                Scheduled daily reflection can be disabled without disabling manual reflection.
              </div>
            </div>
            <Switch checked={dailyEnabled()} onChange={(enabled) => updateDailyConfig({ enabled })} />
          </div>
          <label class="flex items-center justify-between gap-4">
            <span class="text-13-regular text-text-weak">Daily time</span>
            <input
              class="h-9 w-32 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong focus:outline-none focus:ring-2 focus:ring-border-focus"
              type="time"
              value={dailyTime()}
              onChange={(event) => updateDailyConfig({ time: event.currentTarget.value })}
            />
          </label>
        </section>

        <section class="grid grid-cols-2 gap-3">
          <div class="rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
            <div class="text-11-medium text-text-weak uppercase tracking-[0.04em]">Long-term memories</div>
            <div class="pt-1 text-15-medium text-text-strong">{numberValue(status()?.memory_count)}</div>
          </div>
          <div class="rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
            <div class="text-11-medium text-text-weak uppercase tracking-[0.04em]">Shortcuts</div>
            <div class="pt-1 text-15-medium text-text-strong">{numberValue(status()?.shortcut_count)}</div>
          </div>
        </section>

        <section class="rounded-lg border border-border-weak-base bg-surface-raised-base p-4 flex flex-col gap-3">
          <div>
            <div class="text-14-medium text-text-strong">Search test</div>
            <div class="text-12-regular text-text-weak">
              This calls the same memory_search logic available to agents.
            </div>
          </div>
          <div class="flex gap-2">
            <input
              class="h-9 flex-1 rounded-md border border-border-base bg-surface-base px-3 text-14-regular text-text-strong placeholder:text-text-weak focus:outline-none focus:ring-2 focus:ring-border-focus"
              value={searchText()}
              placeholder="Search memory..."
              onInput={(event) => setSearchText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void runSearch()
              }}
            />
            <Button size="small" disabled={searching()} onClick={runSearch}>
              {searching() ? "Searching..." : "Search"}
            </Button>
          </div>
          <div class="flex flex-col gap-2">
            <For each={results()}>
              {(item) => (
                <div class="rounded-md border border-border-weak-base bg-surface-base p-3">
                  <div class="text-12-medium text-text-strong">
                    {item.id} · {item.type} · {item.scope}
                  </div>
                  <div class="text-13-regular text-text-base mt-1">{item.memory}</div>
                  <div class="text-11-regular text-text-weak mt-1">{item.ranking_note}</div>
                </div>
              )}
            </For>
          </div>
        </section>

        <section class="rounded-lg border border-border-weak-base bg-surface-raised-base p-4 flex items-center justify-between gap-4">
          <div>
            <div class="text-14-medium text-text-strong">Manual reflection</div>
            <div class="text-12-regular text-text-weak">
              Quick is lightweight. Daily-style performs global organization.
            </div>
          </div>
          <div class="flex gap-2">
            <Button size="small" variant="secondary" disabled={reflecting()} onClick={() => runReflect("quick")}>
              Quick reflect
            </Button>
            <Button size="small" disabled={reflecting()} onClick={() => runReflect("daily")}>
              Daily reflect
            </Button>
          </div>
        </section>
      </div>
    </div>
  )
}
