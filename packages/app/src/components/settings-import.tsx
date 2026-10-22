import { type Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import { formatServerError } from "@/utils/server-errors"
import { SettingsList } from "./settings-list"

type Source = {
  id: string
  name: string
  sessions?: number
}

type Session = {
  source: string
  id: string
  title?: string
  cwd?: string
  parentID?: string
  updated?: number
}

function basename(value: string | undefined) {
  return value?.split(/[\\/]/).filter(Boolean).at(-1)
}

type Task = {
  source: string
  id: string
  label: string
  parentID?: string
}

function order(tasks: Task[]) {
  const byKey = new Map(tasks.map((task) => [`${task.source}:${task.id}`, task]))
  const result: Task[] = []
  const done = new Set<string>()
  const active = new Set<string>()
  const visit = (task: Task) => {
    const key = `${task.source}:${task.id}`
    if (done.has(key) || active.has(key)) return
    active.add(key)
    if (task.parentID) {
      const parent = byKey.get(`${task.source}:${task.parentID}`)
      if (parent) visit(parent)
    }
    active.delete(key)
    done.add(key)
    result.push(task)
  }
  tasks.forEach(visit)
  return result
}

export const SettingsImport: Component = () => {
  const params = useParams()
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const language = useLanguage()

  const directory = createMemo(() => decode64(params.dir))
  const client = createMemo(() => sdk.createClient({ directory: directory(), throwOnError: true }))
  const [sources, actions] = createResource(async () => {
    const result = await client().migrate.sources()
    return result.data ?? []
  })

  const [open, setOpen] = createSignal<Record<string, boolean>>({})
  const [sessions, setSessions] = createSignal<Record<string, Session[]>>({})
  const [selected, setSelected] = createSignal<Record<string, Record<string, boolean>>>({})
  const [loading, setLoading] = createSignal<Record<string, boolean>>({})
  const [busy, setBusy] = createSignal(false)
  const [progress, setProgress] = createSignal({ done: 0, total: 0 })

  const sessionsFor = (id: string) => sessions()[id] ?? []
  const selectedIDs = (id: string) =>
    Object.entries(selected()[id] ?? {})
      .filter(([, value]) => value)
      .map(([key]) => key)
  const total = createMemo(() => (sources() ?? []).reduce((sum, source) => sum + selectedIDs(source.id).length, 0))

  const select = (sourceID: string, sessionID: string, checked: boolean) => {
    setSelected((prev) => ({
      ...prev,
      [sourceID]: {
        ...(prev[sourceID] ?? {}),
        [sessionID]: checked,
      },
    }))
  }

  const selectAll = (sourceID: string, checked: boolean) => {
    setSelected((prev) => ({
      ...prev,
      [sourceID]: Object.fromEntries(sessionsFor(sourceID).map((session) => [session.id, checked])),
    }))
  }

  const toggle = async (source: Source, checked: boolean) => {
    setOpen((prev) => ({ ...prev, [source.id]: checked }))
    if (!checked) {
      setSelected((prev) => ({ ...prev, [source.id]: {} }))
      return
    }
    const loaded = sessionsFor(source.id)
    if (loaded.length) {
      if (!selectedIDs(source.id).length) selectAll(source.id, true)
      return
    }
    setLoading((prev) => ({ ...prev, [source.id]: true }))
    try {
      const result = await client().migrate.sessions({ source: source.id, limit: 100 })
      const list = result.data ?? []
      setSessions((prev) => ({ ...prev, [source.id]: list }))
      setSelected((prev) => ({
        ...prev,
        [source.id]: Object.fromEntries(list.map((session) => [session.id, true])),
      }))
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("settings.import.failed"),
        description: formatServerError(error, language.t),
      })
    } finally {
      setLoading((prev) => ({ ...prev, [source.id]: false }))
    }
  }

  const run = async () => {
    if (busy()) return
    const tasks: Task[] = []
    for (const source of sources() ?? []) {
      for (const id of selectedIDs(source.id)) {
        const session = sessionsFor(source.id).find((item) => item.id === id)
        tasks.push({ source: source.id, id, label: session?.title || id, parentID: session?.parentID })
      }
    }
    if (!tasks.length) return

    setBusy(true)
    setProgress({ done: 0, total: tasks.length })
    let imported = 0
    let fellBack = false
    const directories = new Set<string>()
    const errors: string[] = []
    const importedSessions = new Map<string, string>()
    const ordered = order(tasks)
    for (const [index, task] of ordered.entries()) {
      try {
        const parentSessionID = task.parentID
          ? importedSessions.get(`${task.source}:${task.parentID}`)
          : undefined
        const result = await client().migrate.importSession({
          source: task.source,
          sessionID: task.id,
          parentSessionID,
        })
        imported += 1
        if (result.data?.sessionID) importedSessions.set(`${task.source}:${task.id}`, result.data.sessionID)
        if (result.data?.directory) directories.add(result.data.directory)
        if (result.data?.fallback) fellBack = true
      } catch (error) {
        errors.push(`${task.label}: ${formatServerError(error, language.t)}`)
      }
      setProgress({ done: index + 1, total: ordered.length })
    }
    setBusy(false)
    const dir = directory()
    if (dir) await sync.project.loadSessions(dir).catch(() => undefined)
    void actions.refetch()
    if (errors.length) {
      showToast({
        variant: "error",
        title: language.t("settings.import.partial", { count: imported, failed: errors.length }),
        description: errors.slice(0, 3).join("\n"),
      })
      return
    }
    if (imported) {
      const targets = [...directories]
      const description = targets.length
        ? language.t("settings.import.done.description", { directory: targets.slice(0, 3).join(", ") })
        : undefined
      const fallback = fellBack ? language.t("settings.import.fallback") : ""
      showToast({
        variant: "success",
        title: language.t("settings.import.done", { count: imported }),
        description: [description, fallback].filter(Boolean).join("\n") || undefined,
      })
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="flex flex-col gap-1">
              <h2 class="text-16-medium text-text-strong">{language.t("settings.import.title")}</h2>
              <p class="text-14-regular text-text-weak">{language.t("settings.import.description")}</p>
              <p class="text-12-regular text-text-weak">{language.t("settings.import.targetHint")}</p>
            </div>
            <Button
              size="small"
              variant="secondary"
              disabled={sources.loading || busy()}
              onClick={() => void actions.refetch()}
            >
              {language.t("settings.import.refresh")}
            </Button>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-6 max-w-[720px]">
        <Show when={sources.loading}>
          <div class="text-12-regular text-text-weak">{language.t("settings.import.loading")}</div>
        </Show>
        <Show when={sources.error}>
          <div class="text-12-regular text-text-weak">{formatServerError(sources.error, language.t)}</div>
        </Show>
        <Show when={!sources.loading && !sources.error && (sources() ?? []).length === 0}>
          <div class="text-12-regular text-text-weak">{language.t("settings.import.empty")}</div>
        </Show>

        <Show when={(sources() ?? []).length > 0}>
          <SettingsList>
            <For each={sources() ?? []}>
              {(source) => (
                <div class="border-b border-border-weak-base last:border-none">
                  <div class="flex flex-wrap items-center gap-4 py-3">
                    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span class="text-14-medium text-text-strong">{source.name}</span>
                      <span class="text-12-regular text-text-weak">
                        {language.t("settings.import.sessions", { count: source.sessions ?? 0 })}
                      </span>
                    </div>
                    <Switch
                      checked={open()[source.id] === true}
                      disabled={busy() || source.sessions === 0}
                      onChange={(checked) => void toggle(source, checked)}
                    />
                  </div>

                  <Show when={open()[source.id]}>
                    <div class="flex flex-col gap-2 pb-3">
                      <Show when={loading()[source.id]}>
                        <span class="text-12-regular text-text-weak">
                          {language.t("settings.import.sessions.loading")}
                        </span>
                      </Show>
                      <Show when={!loading()[source.id] && sessionsFor(source.id).length === 0}>
                        <span class="text-12-regular text-text-weak">
                          {language.t("settings.import.sessions.empty")}
                        </span>
                      </Show>
                      <Show when={sessionsFor(source.id).length > 0}>
                        <div class="flex items-center justify-end gap-3">
                          <button
                            type="button"
                            class="text-12-medium text-text-weak transition-colors hover:text-text-strong"
                            onClick={() => selectAll(source.id, true)}
                          >
                            {language.t("settings.import.selectAll")}
                          </button>
                          <button
                            type="button"
                            class="text-12-medium text-text-weak transition-colors hover:text-text-strong"
                            onClick={() => selectAll(source.id, false)}
                          >
                            {language.t("settings.import.clearAll")}
                          </button>
                        </div>
                        <div class="flex max-h-80 flex-col overflow-y-auto rounded-lg border border-border-weak-base bg-surface-base">
                          <For each={sessionsFor(source.id)}>
                            {(session) => (
                              <div class="border-b border-border-weak-base px-3 py-2 last:border-none">
                                <Checkbox
                                  checked={selected()[source.id]?.[session.id] === true}
                                  disabled={busy()}
                                  onChange={(checked) => select(source.id, session.id, checked)}
                                >
                                  <div class="flex min-w-0 flex-col gap-0.5">
                                    <span class="flex min-w-0 items-center gap-2">
                                      <span class="text-13-medium text-text-strong truncate">
                                        {session.title || basename(session.cwd) || language.t("settings.import.untitled")}
                                      </span>
                                      <Show when={session.parentID}>
                                        <span class="shrink-0 rounded bg-surface-raised-base px-1.5 py-0.5 text-10-medium text-text-weak">
                                          {language.t("settings.import.subagent")}
                                        </span>
                                      </Show>
                                    </span>
                                    <Show when={session.cwd}>
                                      <span class="text-11-regular text-text-weak break-all">{session.cwd}</span>
                                    </Show>
                                    <span class="text-11-regular text-text-weak truncate">
                                      {session.id}
                                      {session.updated ? ` · ${new Date(session.updated).toLocaleString()}` : ""}
                                    </span>
                                  </div>
                                </Checkbox>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </SettingsList>

          <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="text-12-regular text-text-weak">
              {busy()
                ? language.t("settings.import.importing", { current: progress().done, total: progress().total })
                : ""}
            </span>
            <Button variant="primary" size="large" disabled={busy() || total() === 0} onClick={() => void run()}>
              {language.t("settings.import.import", { count: total() })}
            </Button>
          </div>
        </Show>
      </div>
    </div>
  )
}
