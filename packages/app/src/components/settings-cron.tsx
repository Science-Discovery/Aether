import { type Component, For, Show, createEffect, createMemo, createResource, createSignal, onMount } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { normalizeDir } from "@/context/global-sync/utils"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { decode64 } from "@/utils/base64"

type CronMode = "direct" | "isolated_agent" | "session_agent" | "agent_message"
type CronScheduleType = "cron" | "interval" | "once"
type CronLastStatus = "success" | "failed" | "skipped" | "expired" | null
type CronRunStatus = "success" | "failed" | "skipped"

type CronDefinition = {
  id: string
  name: string
  enabled: boolean
  mode: CronMode
  project_id?: string | null
  session_id?: string | null
  schedule_type: CronScheduleType
  schedule_value: string | number
  timezone?: string | null
  payload: Record<string, unknown>
}

type CronState = {
  job_id: string
  enabled: boolean
  next_run_at: number | null
  last_run_at: number | null
  last_status: CronLastStatus
  running: boolean
  start_at: number | null
  updated_at: number
}

type CronRun = {
  run_id: string
  job_id: string
  started_at: number
  finished_at: number
  status: CronRunStatus
  output_summary: string | null
  mode: CronMode
  project_id: string | null
  session_id: string | null
  created_session_id: string | null
  payload_snapshot: Record<string, unknown>
  trigger_reason: "scheduled" | "manual"
}

type CronJobView = {
  definition: CronDefinition
  state: CronState | null
}

function asJobs(input: unknown): CronJobView[] {
  if (!Array.isArray(input)) throw new Error("Invalid cron jobs response")
  return input as CronJobView[]
}

function asRuns(input: unknown): CronRun[] {
  if (!Array.isArray(input)) throw new Error("Invalid cron runs response")
  return input as CronRun[]
}

function active(definition: CronDefinition, state: CronState | null) {
  return definition.enabled && !!state?.enabled
}

function status(definition: CronDefinition, state: CronState | null) {
  if (state?.running) return "running"
  if (state?.last_status === "expired") return "expired"
  if (!definition.enabled) return "paused"
  if (!state?.enabled) return "blocked"
  return state?.last_status ?? "active"
}

function formatTime(input: number | null | undefined) {
  if (!input) return "-"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(input))
}

function formatPayload(input: Record<string, unknown>) {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return "{}"
  }
}

export const SettingsCron: Component = () => {
  const params = useParams()
  const navigate = useNavigate()
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const server = useServer()
  const [selectedID, setSelectedID] = createSignal<string>()
  const [busyID, setBusyID] = createSignal<string>()
  const [updatingGlobal, setUpdatingGlobal] = createSignal(false)
  const [assistantText, setAssistantText] = createSignal("")
  const [assistantBusy, setAssistantBusy] = createSignal(false)
  const [currentProjectID, setCurrentProjectID] = createSignal<string>()

  onMount(() => {
    void sdk.client.project
      .current()
      .then((result) => {
        if (result.data?.id) setCurrentProjectID(result.data.id)
      })
      .catch(() => undefined)
  })

  const cronEnabled = createMemo(() => {
    const config = globalSync.data.config as Record<string, unknown>
    const cron = typeof config.cron === "object" && config.cron ? (config.cron as Record<string, unknown>) : {}
    return cron.enabled !== false
  })

  const setGlobalCronEnabled = async (enabled: boolean) => {
    setUpdatingGlobal(true)
    ;(globalSync.set as (...input: unknown[]) => unknown)("config", (prev: unknown) => ({
      ...(prev as Record<string, unknown>),
      cron: {
        ...(((prev as Record<string, unknown>).cron as Record<string, unknown> | undefined) ?? {}),
        enabled,
      },
    }))

    await globalSync
      .updateConfig({ cron: { enabled } } as Parameters<typeof globalSync.updateConfig>[0])
      .then(async () => {
        showToast({
          title: enabled
            ? language.t("settings.cron.toast.globalEnabled")
            : language.t("settings.cron.toast.globalDisabled"),
        })
        await refresh()
      })
      .catch((error: unknown) => {
        void globalSync.bootstrap().catch(() => undefined)
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => setUpdatingGlobal(false))
  }

  const [jobs, jobActions] = createResource(async () => {
    const result = await sdk.client.cron.jobs.list()
    return asJobs(result.data)
  })

  const selected = createMemo(() => jobs()?.find((job) => job.definition.id === selectedID()))
  const assistantContext = createMemo(() => {
    const directory = decode64(params.dir)
    const project = directory
      ? globalSync.data.project.find((item) => normalizeDir(item.worktree) === normalizeDir(directory))
      : undefined
    return {
      projectID: project?.id ?? currentProjectID(),
      sessionID: params.id || undefined,
    }
  })
  const assistantHint = createMemo(() => {
    const job = selected()
    if (!job) return language.t("settings.cron.assistant.create")
    return language.t("settings.cron.assistant.update", { name: job.definition.name })
  })
  const sessionTarget = (projectID: string | null | undefined, sessionID: string | null | undefined) => {
    if (!projectID || !sessionID) return
    const project = globalSync.data.project.find((item) => item.id === projectID)
    if (!project?.worktree) return
    return {
      directory: project.worktree,
      href: `/${base64Encode(project.worktree)}/session/${sessionID}`,
    }
  }
  const openSession = async (projectID: string | null | undefined, sessionID: string | null | undefined) => {
    const target = sessionTarget(projectID, sessionID)
    if (!target) return
    server.projects.open(target.directory)
    globalSync.peek(target.directory, { bootstrap: true })
    await globalSync.project.loadSessions(target.directory, { force: true }).catch(() => undefined)
    navigate(target.href)
  }
  const [runs, runActions] = createResource(selectedID, async (id) => {
    if (!id) return [] as CronRun[]
    const result = await sdk.client.cron.jobs.runs({ id, count: 10 })
    return asRuns(result.data)
  })

  createEffect(() => {
    const list = jobs()
    if (!list?.length) {
      setSelectedID(undefined)
      return
    }
    const current = selectedID()
    if (current && !list.some((job) => job.definition.id === current)) {
      setSelectedID(undefined)
    }
  })

  const counts = createMemo(() => {
    const list = jobs() ?? []
    return {
      total: list.length,
      active: list.filter((job) => active(job.definition, job.state)).length,
      expired: list.filter((job) => job.state?.last_status === "expired").length,
      running: list.filter((job) => job.state?.running).length,
    }
  })

  const refresh = async () => {
    await jobActions.refetch()
    await runActions.refetch()
  }

  const submitAssistant = async () => {
    const instruction = assistantText().trim()
    if (!instruction) return

    setAssistantBusy(true)
    await sdk.client.cron.jobs
      .assistant({
        instruction,
        selectedID: selected()?.definition.id,
        projectID: assistantContext().projectID,
        sessionID: assistantContext().sessionID,
      })
      .then(async (result) => {
        const data = result.data
        if (data?.action === "reject") {
          showToast({
            title: language.t("settings.cron.assistant.toast.rejected"),
            description: data.summary,
          })
          return
        }
        if (data?.job?.definition.id) setSelectedID(data.job.definition.id)
        setAssistantText("")
        showToast({
          title: data?.summary ?? language.t("settings.cron.assistant.toast.done"),
        })
        await refresh()
      })
      .catch((error: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => setAssistantBusy(false))
  }

  const runNow = async (id: string) => {
    setBusyID(id)
    await sdk.client.cron.jobs
      .run({ id })
      .then(async (result) => {
        const run = result.data
        showToast({
          title: language.t("settings.cron.toast.runQueued"),
          description: run?.output_summary ?? run?.status ?? id,
        })
        await refresh()
      })
      .catch((error: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => setBusyID(undefined))
  }

  const deleteJob = async (id: string) => {
    if (typeof window !== "undefined" && !window.confirm(language.t("settings.cron.confirm.delete"))) return
    setBusyID(id)
    await sdk.client.cron.jobs
      .delete({ id })
      .then(async () => {
        if (selectedID() === id) setSelectedID(undefined)
        showToast({ title: language.t("settings.cron.toast.deleted") })
        await refresh()
      })
      .catch((error: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => setBusyID(undefined))
  }

  const clearSelectionOnBlankClick = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest("[data-cron-interactive]")) return
    setSelectedID(undefined)
  }

  return (
    <div
      data-testid="settings-cron-root"
      class="flex h-full flex-col overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10"
      onClick={clearSelectionOnBlankClick}
    >
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.cron.title")}</h2>
          <p class="text-14-regular text-text-weak">{language.t("settings.cron.description")}</p>
        </div>
      </div>

      <div class="flex w-full max-w-[920px] flex-col gap-5">
        <div data-cron-interactive class="rounded-lg border border-border-weak-base bg-surface-raised-base p-4">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <h3 class="text-14-medium text-text-strong">{language.t("settings.cron.global.title")}</h3>
              <p class="text-12-regular text-text-weak">{language.t("settings.cron.global.description")}</p>
            </div>
            <Switch
              checked={cronEnabled()}
              disabled={updatingGlobal()}
              onChange={(value) => void setGlobalCronEnabled(value)}
            />
          </div>
          <Show when={!cronEnabled()}>
            <div class="mt-3 rounded-md border border-border-weak-base bg-surface-base px-3 py-2 text-12-regular text-text-weak">
              {language.t("settings.cron.global.disabledHint")}
            </div>
          </Show>
        </div>

        <div data-cron-interactive class="grid gap-3 sm:grid-cols-4">
          <Metric title={language.t("settings.cron.metric.scheduler")} value={language.t("settings.cron.scheduler.running")} />
          <Metric
            title={language.t("settings.cron.metric.execution")}
            value={cronEnabled() ? language.t("settings.cron.execution.enabled") : language.t("settings.cron.execution.disabled")}
          />
          <Metric title={language.t("settings.cron.metric.jobs")} value={`${counts().active}/${counts().total}`} />
          <Metric title={language.t("settings.cron.metric.running")} value={`${counts().running}`} />
        </div>

        <div data-cron-interactive class="rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-text-strong">{assistantHint()}</div>
            <div class="flex flex-col gap-2 sm:flex-row">
              <textarea
                data-testid="settings-cron-assistant-input"
                class="min-h-9 flex-1 resize-none rounded-md border border-border-weak-base bg-surface-base px-3 py-2 text-12-regular text-text-strong outline-none placeholder:text-text-dim"
                rows={2}
                value={assistantText()}
                placeholder={language.t("settings.cron.assistant.placeholder")}
                onInput={(event) => setAssistantText(event.currentTarget.value)}
              />
              <Button
                data-testid="settings-cron-assistant-submit"
                size="small"
                variant="secondary"
                disabled={assistantBusy() || !assistantText().trim()}
                onClick={() => void submitAssistant()}
              >
                {assistantBusy()
                  ? language.t("settings.cron.assistant.submitting")
                  : language.t("settings.cron.assistant.submit")}
              </Button>
            </div>
          </div>
        </div>

        <div data-cron-interactive class="flex items-center justify-between">
          <div class="flex flex-col gap-0.5">
            <h3 class="text-14-medium text-text-strong">{language.t("settings.cron.section.jobs")}</h3>
            <span class="text-12-regular text-text-weak">
              {language.t("settings.cron.jobs.summary", {
                total: String(counts().total),
                expired: String(counts().expired),
              })}
            </span>
          </div>
          <Button size="small" variant="secondary" onClick={() => void refresh()}>
            {language.t("settings.cron.action.refresh")}
          </Button>
        </div>

        <Show when={jobs.loading}>
          <div class="text-12-regular text-text-weak">{language.t("settings.cron.loading")}</div>
        </Show>
        <Show when={jobs.error}>
          <div class="text-12-regular text-text-danger">
            {language.t("settings.cron.error.loadFailed", {
              message: jobs.error instanceof Error ? jobs.error.message : String(jobs.error),
            })}
          </div>
        </Show>
        <Show when={!jobs.loading && !jobs.error && (jobs()?.length ?? 0) === 0}>
          <div data-cron-interactive class="rounded-lg border border-border-weak-base bg-surface-raised-base p-4 text-12-regular text-text-weak">
            {language.t("settings.cron.empty")}
          </div>
        </Show>

        <Show when={(jobs()?.length ?? 0) > 0}>
          <div class="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
            <div data-cron-interactive class="flex flex-col gap-2">
              <For each={jobs() ?? []}>
                {(job) => (
                  <button
                    type="button"
                    data-action="settings-cron-select"
                    class="flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors"
                    classList={{
                      "border-border-active bg-surface-raised-base": selectedID() === job.definition.id,
                      "border-border-weak-base bg-surface-base hover:bg-surface-raised-base": selectedID() !== job.definition.id,
                    }}
                    onClick={() => setSelectedID(job.definition.id)}
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <div class="truncate text-13-medium text-text-strong">{job.definition.name}</div>
                        <div class="text-11-regular text-text-weak">
                          {job.definition.mode} / {job.definition.schedule_type}
                        </div>
                      </div>
                      <Badge value={status(job.definition, job.state)} />
                    </div>
                    <div class="grid gap-1 text-11-regular text-text-weak">
                      <span>
                        {language.t("settings.cron.field.nextRun")}: {formatTime(job.state?.next_run_at)}
                      </span>
                      <span>
                        {language.t("settings.cron.field.lastRun")}: {formatTime(job.state?.last_run_at)}
                      </span>
                    </div>
                  </button>
                )}
              </For>
            </div>

            <Show when={selected()}>
              {(job) => (
                <div data-cron-interactive class="flex min-w-0 flex-col gap-4 rounded-lg border border-border-weak-base bg-surface-base p-4">
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="text-15-medium text-text-strong">{job().definition.name}</div>
                      <div class="text-12-regular text-text-weak break-all">{job().definition.id}</div>
                    </div>
                    <div class="flex gap-2">
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={busyID() === job().definition.id}
                        onClick={() => void runNow(job().definition.id)}
                      >
                        {language.t("settings.cron.action.runNow")}
                      </Button>
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={busyID() === job().definition.id}
                        onClick={() => void deleteJob(job().definition.id)}
                      >
                        {language.t("settings.cron.action.delete")}
                      </Button>
                    </div>
                  </div>

                  <div class="grid gap-2 sm:grid-cols-2">
                    <Field label={language.t("settings.cron.field.mode")} value={job().definition.mode} />
                    <Field label={language.t("settings.cron.field.schedule")} value={`${job().definition.schedule_type}: ${job().definition.schedule_value}`} />
                    <Field label={language.t("settings.cron.field.project")} value={job().definition.project_id ?? "-"} />
                    <Field label={language.t("settings.cron.field.session")} value={job().definition.session_id ?? "-"} />
                    <Field label={language.t("settings.cron.field.execution")} value={active(job().definition, job().state) ? language.t("settings.cron.execution.enabled") : language.t("settings.cron.execution.disabled")} />
                    <Field label={language.t("settings.cron.field.status")} value={status(job().definition, job().state)} />
                    <Field label={language.t("settings.cron.field.nextRun")} value={formatTime(job().state?.next_run_at)} />
                    <Field label={language.t("settings.cron.field.lastRun")} value={formatTime(job().state?.last_run_at)} />
                  </div>

                  <div class="flex flex-col gap-2">
                    <span class="text-12-medium text-text-weak uppercase tracking-[0.04em]">
                      {language.t("settings.cron.section.recentRuns")}
                    </span>
                    <Show when={runs.loading}>
                      <div class="text-12-regular text-text-weak">{language.t("settings.cron.runs.loading")}</div>
                    </Show>
                    <Show when={!runs.loading && (runs()?.length ?? 0) === 0}>
                      <div class="text-12-regular text-text-weak">{language.t("settings.cron.runs.empty")}</div>
                    </Show>
                    <div class="flex flex-col gap-2">
                      <For each={runs() ?? []}>
                        {(run) => (
                          <div class="rounded-md border border-border-weak-base bg-surface-raised-base p-3">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                              <div class="flex items-center gap-2">
                                <Badge value={run.status} />
                                <span class="text-12-regular text-text-weak">{run.trigger_reason}</span>
                              </div>
                              <span class="text-11-regular text-text-dim">{formatTime(run.started_at)}</span>
                            </div>
                            <Show when={run.output_summary}>
                              <div class="pt-2 text-12-regular text-text-base">{run.output_summary}</div>
                            </Show>
                            <div class="pt-2 grid gap-1 text-11-regular text-text-weak">
                              <span>
                                {language.t("settings.cron.field.session")}: {run.session_id ?? "-"}
                              </span>
                              <span>
                                {language.t("settings.cron.field.createdSession")}: {run.created_session_id ?? "-"}
                              </span>
                              <Show when={sessionTarget(run.project_id, run.created_session_id ?? run.session_id)}>
                                <Button
                                  size="small"
                                  variant="secondary"
                                  onClick={() => void openSession(run.project_id, run.created_session_id ?? run.session_id)}
                                >
                                  {language.t("settings.cron.action.openSession")}
                                </Button>
                              </Show>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>

                  <details class="rounded-md border border-border-weak-base bg-surface-raised-base p-3">
                    <summary class="cursor-pointer text-12-medium text-text-weak">
                      {language.t("settings.cron.section.payload")}
                    </summary>
                    <pre class="mt-3 overflow-x-auto whitespace-pre-wrap text-11-regular text-text-base">
                      {formatPayload(job().definition.payload)}
                    </pre>
                  </details>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

const Metric: Component<{ title: string; value: string }> = (props) => (
  <div class="rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
    <div class="text-11-medium text-text-weak uppercase tracking-[0.04em]">{props.title}</div>
    <div class="pt-1 text-15-medium text-text-strong">{props.value}</div>
  </div>
)

const Field: Component<{ label: string; value: string }> = (props) => (
  <div class="rounded-md border border-border-weak-base bg-surface-raised-base p-3">
    <div class="text-11-medium text-text-weak uppercase tracking-[0.04em]">{props.label}</div>
    <div class="pt-1 break-all text-12-regular text-text-strong">{props.value}</div>
  </div>
)

const Badge: Component<{ value: string }> = (props) => (
  <span
    class="rounded-full border px-2 py-0.5 text-11-medium capitalize"
    classList={{
      "border-border-weak-base text-text-success": props.value === "success" || props.value === "active",
      "border-border-weak-base text-text-danger": props.value === "failed" || props.value === "expired",
      "border-border-weak-base text-text-weak":
        props.value === "skipped" ||
        props.value === "paused" ||
        props.value === "running" ||
        props.value !== "success" &&
        props.value !== "active" &&
        props.value !== "failed" &&
        props.value !== "expired",
    }}
  >
    {props.value}
  </span>
)
