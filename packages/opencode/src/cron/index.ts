import path from "path"
import fs from "fs/promises"
import { Cron as CronExpression } from "croner"
import z from "zod"
import { ulid } from "ulid"
import { Database, desc, eq } from "@/storage/db"
import { CronJobStateTable, CronRunTable } from "./cron.sql"
import { CronSchema } from "./schema"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import { fn } from "@/util/fn"
import { Config } from "@/config/config"
import { Project } from "@/project/project"
import { ProjectID } from "@/project/schema"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Session } from "@/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Memory } from "@/memory"

const log = Log.create({ service: "cron" })

type Definition = CronSchema.Definition
type State = CronSchema.State
type Run = CronSchema.Run

type StateRow = typeof CronJobStateTable.$inferSelect
type RunRow = typeof CronRunTable.$inferSelect

type DirectResult = {
  output_summary?: string | null
}

type DispatchResult = {
  output_summary?: string | null
  project_id?: string | null
  session_id?: string | null
  created_session_id?: string | null
}

type DirectHandler = (input: {
  definition: Definition
  trigger_reason: CronSchema.TriggerReason
  now: number
}) => Promise<DirectResult> | DirectResult

type AgentDispatcher = {
  isolated(input: {
    definition: Definition
    run_id: string
    now: number
  }): Promise<DispatchResult>
  session(input: {
    definition: Definition
    run_id: string
    now: number
  }): Promise<DispatchResult>
  message(input: {
    definition: Definition
    run_id: string
    now: number
  }): Promise<DispatchResult>
}

type SessionDispatchTarget = {
  project: Project.Info
  existing: Awaited<ReturnType<typeof Session.get>> | undefined
  runtimeDirectory: string
}

const directHandlers = new Map<string, DirectHandler>()
const BUILTIN_MEMORY_REFLECTION_JOB_ID = "builtin-memory-reflection-daily"

const defaultAgentDispatcher: AgentDispatcher = {
  async isolated(input) {
    const projectID = ProjectID.make(String(input.definition.project_id))
    const project = Project.get(projectID)
    if (!project) throw new Error(`Project not found: ${input.definition.project_id}`)

    return Instance.provide({
      directory: project.worktree,
      init: InstanceBootstrap,
      fn: async () => {
        const session = await Session.create({
          title: input.definition.name,
        })
        void SessionPrompt.prompt({
          sessionID: session.id,
          parts: [
            {
              type: "text",
              text: String(input.definition.payload.message),
              metadata: cronMetadata(input.definition.id, input.run_id),
            },
          ],
        }).catch((error) => {
          log.error("isolated cron prompt failed", {
            job_id: input.definition.id,
            run_id: input.run_id,
            error,
          })
        })
        return {
          output_summary: `Queued isolated agent run in session ${session.id}`,
          project_id: project.id,
          session_id: session.id,
          created_session_id: session.id,
        }
      },
    })
  },
  async session(input) {
    const target = await resolveSessionDispatchTarget(input.definition)

    return Instance.provide({
      directory: target.runtimeDirectory,
      init: InstanceBootstrap,
      fn: async () => {
        const wanted = SessionID.make(String(input.definition.session_id))
        let targetID = wanted
        let createdSessionID: string | null = null

        if (!target.existing || target.existing.projectID !== target.project.id) {
          const created = await Session.create({
            title: input.definition.name,
          })
          targetID = created.id
          createdSessionID = created.id
        }

        void SessionPrompt.prompt({
          sessionID: targetID,
          parts: [
            {
              type: "text",
              text: String(input.definition.payload.message),
              metadata: cronMetadata(input.definition.id, input.run_id),
            },
          ],
        }).catch((error) => {
          log.error("session cron prompt failed", {
            job_id: input.definition.id,
            run_id: input.run_id,
            session_id: targetID,
            error,
          })
        })

        return {
          output_summary: `Queued cron message in session ${targetID}`,
          project_id: target.project.id,
          session_id: targetID,
          created_session_id: createdSessionID,
        }
      },
    })
  },
  async message(input) {
    const target = await resolveSessionDispatchTarget(input.definition)

    return Instance.provide({
      directory: target.runtimeDirectory,
      init: InstanceBootstrap,
      fn: async () => {
        const wanted = SessionID.make(String(input.definition.session_id))
        let targetID = wanted
        let createdSessionID: string | null = null

        if (!target.existing || target.existing.projectID !== target.project.id) {
          const created = await Session.create({
            title: input.definition.name,
          })
          targetID = created.id
          createdSessionID = created.id
        }

        await appendAgentMessage({
          definition: input.definition,
          run_id: input.run_id,
          session_id: targetID,
          now: input.now,
        })

        return {
          output_summary: `Created cron agent message in session ${targetID}`,
          project_id: target.project.id,
          session_id: targetID,
          created_session_id: createdSessionID,
        }
      },
    })
  },
}

let agentDispatcher: AgentDispatcher = defaultAgentDispatcher

type RuntimeRow = {
  job_id: string
  enabled: boolean
  next_run_at: number | null
  last_run_at: number | null
  last_status: CronSchema.LastStatus
  running: boolean
  start_at: number | null
  updated_at: number
  definition_snapshot: Record<string, unknown>
}

const runtimeLockPath = () => path.join(Global.Path.data, "cron", ".runtime.lock")
const jobLockPath = (jobID: string) => path.join(Global.Path.data, "cron", `${jobID}.lock`)

const scheduler = {
  started: false,
  timer: undefined as ReturnType<typeof setInterval> | undefined,
}

function jobsDir() {
  return process.env.OPENCODE_CRON_DIR || path.join(Global.Path.data, "cron", "jobs")
}

function systemTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

function cronMetadata(jobID: string, runID: string) {
  return {
    source: "cron",
    job_id: jobID,
    run_id: runID,
  }
}

async function resolveSessionDispatchTarget(definition: Definition): Promise<SessionDispatchTarget> {
  const projectID = ProjectID.make(String(definition.project_id))
  const project = Project.get(projectID)
  if (!project) throw new Error(`Project not found: ${definition.project_id}`)

  const wanted = SessionID.make(String(definition.session_id))
  const existing = await Session.get(wanted).catch(() => undefined)
  if (existing && existing.projectID === project.id) {
    return {
      project,
      existing,
      runtimeDirectory: existing.directory,
    }
  }

  return {
    project,
    existing,
    runtimeDirectory: project.worktree,
  }
}

function payloadAgent(definition: Definition) {
  const agent = definition.payload.agent
  return typeof agent === "string" && !blank(agent) ? agent : undefined
}

function payloadModel(definition: Definition) {
  const model = definition.payload.model
  if (!model || typeof model !== "object" || Array.isArray(model)) return undefined
  const input = model as Record<string, unknown>
  if (typeof input.providerID !== "string" || blank(input.providerID)) return undefined
  if (typeof input.modelID !== "string" || blank(input.modelID)) return undefined
  return {
    providerID: ProviderID.make(input.providerID),
    modelID: ModelID.make(input.modelID),
  }
}

async function lastUserMessage(sessionID: SessionID) {
  for await (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user") return item.info
  }
  return undefined
}

async function appendAgentMessage(input: {
  definition: Definition
  run_id: string
  session_id: SessionID
  now: number
}) {
  const agentName = payloadAgent(input.definition) ?? (await Agent.defaultAgent())
  const agent = await Agent.get(agentName)
  const lastUser = await lastUserMessage(input.session_id)
  const model = payloadModel(input.definition) ?? agent.model ?? lastUser?.model ?? (await Provider.defaultModel())
  const parentID = lastUser?.id ?? MessageID.ascending()
  const messageID = MessageID.ascending()

  const message = await Session.updateMessage({
    id: messageID,
    role: "assistant",
    sessionID: input.session_id,
    parentID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: agent.name,
    agent: agent.name,
    path: {
      cwd: Instance.directory,
      root: Instance.worktree,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    finish: "stop",
    time: {
      created: input.now,
      completed: Date.now(),
    },
  } satisfies MessageV2.Assistant)

  const part = await Session.updatePart({
    id: PartID.ascending(),
    sessionID: input.session_id,
    messageID,
    type: "text",
    text: String(input.definition.payload.message),
    metadata: cronMetadata(input.definition.id, input.run_id),
    time: {
      start: input.now,
      end: Date.now(),
    },
  } satisfies MessageV2.TextPart)

  await Session.touch(input.session_id)
  return {
    info: message,
    parts: [part],
  }
}

function toState(row: RuntimeRow): State {
  return {
    job_id: row.job_id,
    enabled: row.enabled,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_status: row.last_status,
    running: row.running,
    start_at: row.start_at,
    updated_at: row.updated_at,
  }
}

function toRun(row: RunRow): Run {
  return {
    run_id: row.run_id,
    job_id: row.job_id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status,
    output_summary: row.output_summary ?? null,
    mode: row.mode,
    project_id: row.project_id ?? null,
    session_id: row.session_id ?? null,
    created_session_id: row.created_session_id ?? null,
    payload_snapshot: row.payload_snapshot,
    trigger_reason: row.trigger_reason,
  }
}

function blank(value: string) {
  return value.trim().length === 0
}

function assertString(value: unknown, field: string) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`)
  return value
}

function assertNonBlankString(value: unknown, field: string) {
  const next = assertString(value, field)
  if (blank(next)) throw new Error(`${field} must not be empty`)
  return next
}

function assertName(value: unknown) {
  const next = assertNonBlankString(value, "name")
  if (next.includes("\n") || next.includes("\r")) throw new Error("name must be single-line text")
  return next
}

function asObject(value: unknown, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be a JSON object`)
  return value as Record<string, unknown>
}

function validateCronExpression(expression: string) {
  try {
    new CronExpression(expression)
  } catch (error) {
    throw new Error(
      `invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, next]) => `${JSON.stringify(key)}:${stable(next)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function equivalent(left: Record<string, unknown>, right: Record<string, unknown>) {
  return stable(left) === stable(right)
}

function parseDefinition(raw: Record<string, unknown>, fallbackID?: string): Definition {
  const definition = { ...raw }
  definition.id = fallbackID ?? definition.id ?? ulid()
  definition.enabled = definition.enabled ?? true
  definition.project_id = definition.project_id ?? null
  definition.session_id = definition.session_id ?? null
  definition.payload = definition.payload ?? {}

  definition.id = assertNonBlankString(definition.id, "id")
  definition.name = assertName(definition.name)
  if (typeof definition.enabled !== "boolean") throw new Error("enabled must be a boolean")
  if (!CronSchema.Mode.safeParse(definition.mode).success) throw new Error("mode is invalid")
  if (!CronSchema.ScheduleType.safeParse(definition.schedule_type).success) throw new Error("schedule_type is invalid")

  if (definition.project_id !== null && definition.project_id !== undefined) {
    definition.project_id = assertNonBlankString(definition.project_id, "project_id")
  }
  if (definition.session_id !== null && definition.session_id !== undefined) {
    definition.session_id = assertNonBlankString(definition.session_id, "session_id")
  }

  definition.payload = asObject(definition.payload, "payload")

  switch (definition.schedule_type) {
    case "cron":
    case "once": {
      const scheduleValue = assertNonBlankString(definition.schedule_value, "schedule_value")
      definition.schedule_value = scheduleValue
      validateCronExpression(scheduleValue)
      definition.timezone =
        definition.timezone === null || definition.timezone === undefined
          ? systemTimezone()
          : assertNonBlankString(definition.timezone, "timezone")
      break
    }
    case "interval": {
      if (!Number.isInteger(definition.schedule_value) || Number(definition.schedule_value) <= 0) {
        throw new Error("schedule_value must be a positive integer for interval")
      }
      definition.schedule_value = Number(definition.schedule_value)
      break
    }
  }

  const payload = definition.payload as Record<string, unknown>
  switch (definition.mode) {
    case "direct": {
      const action = payload.action
      assertNonBlankString(action, "payload.action")
      break
    }
    case "isolated_agent": {
      assertNonBlankString(definition.project_id, "project_id")
      const message = payload.message
      assertNonBlankString(message, "payload.message")
      break
    }
    case "session_agent": {
      assertNonBlankString(definition.project_id, "project_id")
      assertNonBlankString(definition.session_id, "session_id")
      const message = payload.message
      assertNonBlankString(message, "payload.message")
      break
    }
    case "agent_message": {
      assertNonBlankString(definition.project_id, "project_id")
      assertNonBlankString(definition.session_id, "session_id")
      const message = payload.message
      assertNonBlankString(message, "payload.message")
      if (payload.agent !== undefined) assertNonBlankString(payload.agent, "payload.agent")
      break
    }
  }

  return CronSchema.Definition.parse(definition)
}

function patchDefinition(input: Definition, patch: Record<string, unknown>) {
  if ("id" in patch) throw new Error("id is immutable")
  const next = { ...input, ...patch }
  return parseDefinition(next, input.id)
}

function nextCronOccurrence(expression: string, timezone: string, now: number) {
  const cron = new CronExpression(expression, { timezone })
  const next = cron.nextRun(new Date(now))
  return next ? next.getTime() : null
}

function scheduleChanged(previous: Definition, current: Definition) {
  return (
    previous.schedule_type !== current.schedule_type ||
    previous.schedule_value !== current.schedule_value ||
    previous.timezone !== current.timezone
  )
}

function modeChanged(previous: Definition, current: Definition) {
  return previous.mode !== current.mode
}

function definitionEnabledChanged(previous: Definition, current: Definition) {
  return previous.enabled !== current.enabled
}

function computeIntervalNext(startAt: number, seconds: number, now: number) {
  const intervalMs = seconds * 1000
  if (now < startAt) return startAt + intervalMs
  const elapsed = now - startAt
  const steps = Math.floor(elapsed / intervalMs) + 1
  return startAt + steps * intervalMs
}

function computeInitialSchedule(definition: Definition, now: number, previousStartAt?: number | null) {
  if (definition.schedule_type === "interval") {
    const startAt = previousStartAt ?? now
    return {
      start_at: startAt,
      next_run_at: computeIntervalNext(startAt, Number(definition.schedule_value), now),
      expired: false,
    }
  }

  const timezone = definition.timezone ?? systemTimezone()
  const next = nextCronOccurrence(String(definition.schedule_value), timezone, now)
  return {
    start_at: null,
    next_run_at: next,
    expired: definition.schedule_type === "once" && next === null,
  }
}

function emptyState(jobID: string): RuntimeRow {
  return {
    job_id: jobID,
    enabled: false,
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    running: false,
    start_at: null,
    updated_at: Date.now(),
    definition_snapshot: {},
  }
}

function reconcileState(input: {
  previous: RuntimeRow | undefined
  previousDefinition?: Definition
  definition: Definition
  now: number
  startupRecovery?: boolean
}): RuntimeRow {
  const current = input.previous ? { ...input.previous } : emptyState(input.definition.id)
  const previousDefinition = input.previousDefinition
  const definition = input.definition
  current.updated_at = input.now
  current.definition_snapshot = definition as unknown as Record<string, unknown>

  if (input.startupRecovery) {
    current.running = false
  }

  if (!input.previous) {
    const schedule = computeInitialSchedule(definition, input.now)
    current.start_at = schedule.start_at
    current.next_run_at = schedule.next_run_at
    current.last_status = schedule.expired ? "expired" : null
    current.enabled = definition.enabled && !schedule.expired
    return current
  }

  const changed = previousDefinition && !equivalent(previousDefinition as unknown as Record<string, unknown>, definition)
  const scheduleRelatedChanged = previousDefinition ? scheduleChanged(previousDefinition, definition) : false
  const modeRelatedChanged = previousDefinition ? modeChanged(previousDefinition, definition) : false
  const enabledRelatedChanged = previousDefinition ? definitionEnabledChanged(previousDefinition, definition) : false

  if (!changed) {
    return current
  }

  if (!definition.enabled) {
    current.enabled = false
    current.definition_snapshot = definition as unknown as Record<string, unknown>
    return current
  }

  const shouldReviveExpired =
    current.last_status === "expired" && (scheduleRelatedChanged || modeRelatedChanged)

  if (current.last_status === "expired" && !shouldReviveExpired) {
    current.enabled = false
    return current
  }

  if (shouldReviveExpired) {
    current.last_status = null
  }

  const shouldRecompute =
    scheduleRelatedChanged || modeRelatedChanged || enabledRelatedChanged || current.enabled === false

  if (shouldRecompute) {
    const resetIntervalAnchor =
      definition.schedule_type === "interval" &&
      (scheduleRelatedChanged || modeRelatedChanged || enabledRelatedChanged || current.start_at === null)
    const schedule = computeInitialSchedule(definition, input.now, resetIntervalAnchor ? input.now : current.start_at)
    current.start_at = schedule.start_at
    current.next_run_at = schedule.next_run_at
    if (schedule.expired) {
      current.enabled = false
      current.last_status = "expired"
      return current
    }
    current.enabled = true
  }

  return current
}

async function ensureJobDir() {
  await fs.mkdir(jobsDir(), { recursive: true })
}

async function listJobFiles() {
  await ensureJobDir()
  const entries = await fs.readdir(jobsDir(), { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(jobsDir(), entry.name))
}

async function readJobFile(filePath: string) {
  using _ = await Lock.read(filePath)
  return Bun.file(filePath).json()
}

async function writeJobFile(definition: Definition) {
  const filePath = path.join(jobsDir(), `${definition.id}.json`)
  using _ = await Lock.write(filePath)
  await Filesystem.writeJson(filePath, definition)
  return filePath
}

async function deleteJobFile(jobID: string) {
  const filePath = path.join(jobsDir(), `${jobID}.json`)
  using _ = await Lock.write(filePath)
  await fs.rm(filePath, { force: true })
}

async function ensureBuiltinMemoryReflectionJob() {
  await ensureJobDir()
  const filePath = path.join(jobsDir(), `${BUILTIN_MEMORY_REFLECTION_JOB_ID}.json`)
  const enabled = (await Config.getGlobal()).memory?.enabled ?? true
  const now = Date.now()
  const fallback = {
    id: BUILTIN_MEMORY_REFLECTION_JOB_ID,
    name: "Daily memory reflection",
    enabled,
    mode: "direct",
    project_id: null,
    session_id: null,
    schedule_type: "cron",
    schedule_value: "0 3 * * *",
    timezone: systemTimezone(),
    payload: {
      action: "memory_reflect",
      scope: "global",
      dry_run: false,
      trigger: "cron",
    },
  } satisfies Record<string, unknown>

  const existing = await readJobFile(filePath).catch(() => undefined)
  const definition = existing
    ? parseDefinition(asObject(existing, "job"), BUILTIN_MEMORY_REFLECTION_JOB_ID)
    : parseDefinition(fallback, BUILTIN_MEMORY_REFLECTION_JOB_ID)
  const synced = definition.enabled === enabled ? definition : { ...definition, enabled }
  if (!existing || synced.enabled !== definition.enabled) await writeJobFile(synced)

  const previous = getState(BUILTIN_MEMORY_REFLECTION_JOB_ID) ?? undefined
  const previousDefinition = (() => {
    if (!previous?.definition_snapshot) return undefined
    try {
      return parseDefinition(previous.definition_snapshot, BUILTIN_MEMORY_REFLECTION_JOB_ID)
    } catch {
      return undefined
    }
  })()
  const state = reconcileState({
    previous,
    previousDefinition,
    definition: synced,
    now,
  })
  upsertState(state)
  return { definition: synced, state: toState(state) }
}

async function globalCronEnabled() {
  const config = await Config.getGlobal()
  return config.cron?.enabled ?? true
}

function getState(jobID: string) {
  const row = Database.use((db) => db.select().from(CronJobStateTable).where(eq(CronJobStateTable.job_id, jobID)).get())
  if (!row) return null
  return row as RuntimeRow
}

function listStates() {
  return Database.use((db) => db.select().from(CronJobStateTable).all()) as RuntimeRow[]
}

function upsertState(row: RuntimeRow) {
  Database.use((db) =>
    db
      .insert(CronJobStateTable)
      .values(row)
      .onConflictDoUpdate({
        target: CronJobStateTable.job_id,
        set: row,
      })
      .run(),
  )
}

function removeState(jobID: string) {
  Database.use((db) => db.delete(CronJobStateTable).where(eq(CronJobStateTable.job_id, jobID)).run())
}

function insertRun(run: Run) {
  const row: RunRow = {
    run_id: run.run_id,
    job_id: run.job_id,
    started_at: run.started_at,
    finished_at: run.finished_at,
    status: run.status,
    output_summary: run.output_summary ?? null,
    mode: run.mode,
    project_id: run.project_id ?? null,
    session_id: run.session_id ?? null,
    created_session_id: run.created_session_id ?? null,
    payload_snapshot: run.payload_snapshot,
    trigger_reason: run.trigger_reason,
  }
  Database.use((db) => db.insert(CronRunTable).values(row).run())
}

function safeInsertRun(run: Run) {
  try {
    insertRun(run)
  } catch (error) {
    log.error("cron run log insert failed", {
      job_id: run.job_id,
      run_id: run.run_id,
      status: run.status,
      error,
    })
  }
}

function queryRuns(jobID: string, count: number) {
  return Database.use((db) =>
    db
      .select()
      .from(CronRunTable)
      .where(eq(CronRunTable.job_id, jobID))
      .orderBy(desc(CronRunTable.started_at))
      .limit(count)
      .all(),
  ).map(toRun)
}

function queryRun(runID: string) {
  const row = Database.use((db) => db.select().from(CronRunTable).where(eq(CronRunTable.run_id, runID)).get())
  return row ? toRun(row) : null
}

function beginRun(input: {
  definition: Definition
  trigger_reason: CronSchema.TriggerReason
  project_id?: string | null
  session_id?: string | null
  created_session_id?: string | null
  output_summary?: string | null
  status: CronSchema.RunStatus
  payload_snapshot: Record<string, unknown>
}) {
  const now = Date.now()
  const run: Run = {
    run_id: ulid(),
    job_id: input.definition.id,
    started_at: now,
    finished_at: now,
    status: input.status,
    output_summary: input.output_summary ?? null,
    mode: input.definition.mode,
    project_id: input.project_id ?? input.definition.project_id ?? null,
    session_id: input.session_id ?? null,
    created_session_id: input.created_session_id ?? null,
    payload_snapshot: input.payload_snapshot,
    trigger_reason: input.trigger_reason,
  }
  safeInsertRun(run)
  const current = getState(input.definition.id)
  if (current) {
    current.last_status = input.status
    current.updated_at = now
    upsertState(current)
  }
  return run
}

async function executeDirect(input: {
  definition: Definition
  trigger_reason: CronSchema.TriggerReason
  now: number
}) {
  const action = String(input.definition.payload.action)
  const handler = directHandlers.get(action)
  if (!handler) {
    return {
      status: "failed" as const,
      output_summary: `Unknown direct action: ${action}`,
      project_id: null,
      session_id: null,
      created_session_id: null,
    }
  }
  const result = await handler(input)
  return {
    status: "success" as const,
    output_summary: result?.output_summary ?? null,
    project_id: null,
    session_id: null,
    created_session_id: null,
  }
}

async function executeAgentMode(input: {
  definition: Definition
  trigger_reason: CronSchema.TriggerReason
  run_id: string
  now: number
}) {
  if (input.definition.mode === "agent_message") {
    const result = await agentDispatcher.message({
      definition: input.definition,
      run_id: input.run_id,
      now: input.now,
    })
    return {
      status: "success" as const,
      output_summary: result.output_summary ?? null,
      project_id: result.project_id ?? input.definition.project_id ?? null,
      session_id: result.session_id ?? null,
      created_session_id: result.created_session_id ?? null,
    }
  }

  if (input.definition.mode === "isolated_agent") {
    const result = await agentDispatcher.isolated({
      definition: input.definition,
      run_id: input.run_id,
      now: input.now,
    })
    return {
      status: "success" as const,
      output_summary: result.output_summary ?? null,
      project_id: result.project_id ?? input.definition.project_id ?? null,
      session_id: result.session_id ?? null,
      created_session_id: result.created_session_id ?? null,
    }
  }

  const result = await agentDispatcher.session({
    definition: input.definition,
    run_id: input.run_id,
    now: input.now,
  })
  return {
    status: "success" as const,
    output_summary: result.output_summary ?? null,
    project_id: result.project_id ?? input.definition.project_id ?? null,
    session_id: result.session_id ?? null,
    created_session_id: result.created_session_id ?? null,
  }
}

function shouldParticipate(definition: Definition, state: RuntimeRow) {
  return definition.enabled && state.enabled
}

function scheduledSkipDisabled(definition: Definition, state: RuntimeRow, now: number) {
  if (definition.schedule_type === "once") {
    state.enabled = false
    state.next_run_at = null
    state.last_status = "expired"
    state.updated_at = now
    upsertState(state)
    return
  }

  if (state.next_run_at === null) return
  const schedule = computeInitialSchedule(definition, now, state.start_at)
  state.start_at = schedule.start_at
  state.next_run_at = schedule.next_run_at
  state.updated_at = now
  upsertState(state)
}

function updateStateOnStart(definition: Definition, state: RuntimeRow, trigger: CronSchema.TriggerReason, now: number) {
  state.running = true
  state.updated_at = now
  if (trigger === "scheduled" && definition.schedule_type !== "once") {
    const schedule = computeInitialSchedule(definition, now, state.start_at)
    state.start_at = schedule.start_at
    state.next_run_at = schedule.next_run_at
  }
  upsertState(state)
}

function updateStateOnFinish(
  definition: Definition,
  state: RuntimeRow,
  status: "success" | "failed",
  now: number,
) {
  state.running = false
  state.last_run_at = now
  state.last_status = status
  state.updated_at = now
  if (definition.schedule_type === "once") {
    state.enabled = false
    state.next_run_at = null
  }
  upsertState(state)
}

function skip(definition: Definition, state: RuntimeRow | null, trigger: CronSchema.TriggerReason, output: string) {
  const run = beginRun({
    definition,
    trigger_reason: trigger,
    status: "skipped",
    output_summary: output,
    payload_snapshot: definition.payload,
  })
  if (state) {
    state.last_status = "skipped"
    state.updated_at = run.finished_at
    upsertState(state)
  }
  return run
}

async function execute(definition: Definition, trigger: CronSchema.TriggerReason) {
  using _ = await Lock.write(jobLockPath(definition.id))
  const current = getState(definition.id)
  if (!current) throw new Error(`Missing cron state for job ${definition.id}`)

  if (!(await globalCronEnabled())) {
    return skip(definition, current, trigger, "Skipped because cron is disabled")
  }

  if (!definition.enabled || !current.enabled) {
    const summary =
      current.last_status === "expired"
        ? "Skipped because once job has expired"
        : "Skipped because job is disabled"
    return skip(definition, current, trigger, summary)
  }

  if (current.running) {
    return skip(definition, current, trigger, "Skipped because another run is already in progress")
  }

  const startedAt = Date.now()
  updateStateOnStart(definition, current, trigger, startedAt)
  const runID = ulid()

  try {
    const result =
      definition.mode === "direct"
        ? await executeDirect({ definition, trigger_reason: trigger, now: startedAt })
        : await executeAgentMode({ definition, trigger_reason: trigger, run_id: runID, now: startedAt })
    const finishedAt = Date.now()
    const run: Run = {
      run_id: runID,
      job_id: definition.id,
      started_at: startedAt,
      finished_at: finishedAt,
      status: result.status,
      output_summary: result.output_summary ?? null,
      mode: definition.mode,
      project_id: result.project_id ?? definition.project_id ?? null,
      session_id: result.session_id ?? null,
      created_session_id: result.created_session_id ?? null,
      payload_snapshot: definition.payload,
      trigger_reason: trigger,
    }
    safeInsertRun(run)
    updateStateOnFinish(definition, current, result.status, finishedAt)
    return run
  } catch (error) {
    const finishedAt = Date.now()
    const message = error instanceof Error ? error.message : String(error)
    const run: Run = {
      run_id: runID,
      job_id: definition.id,
      started_at: startedAt,
      finished_at: finishedAt,
      status: "failed",
      output_summary: message,
      mode: definition.mode,
      project_id: definition.project_id ?? null,
      session_id: null,
      created_session_id: null,
      payload_snapshot: definition.payload,
      trigger_reason: trigger,
    }
    safeInsertRun(run)
    updateStateOnFinish(definition, current, "failed", finishedAt)
    return run
  }
}

async function scanDefinitions(input: { startupRecovery?: boolean; now?: number } = {}) {
  const now = input.now ?? Date.now()
  const files = await listJobFiles()
  const presentIDs = new Set<string>()
  const valid: Definition[] = []

  for (const filePath of files) {
    const jobID = path.basename(filePath, ".json")
    presentIDs.add(jobID)
    try {
      const raw = asObject(await readJobFile(filePath), "job")
      const parsed = parseDefinition(raw, jobID)
      if (parsed.id !== jobID) {
        log.warn("cron job id does not match filename", { filePath, file_id: jobID, definition_id: parsed.id })
        continue
      }
      valid.push(parsed)

      const previous = getState(parsed.id) ?? undefined
      const previousDefinition = (() => {
        if (!previous?.definition_snapshot) return undefined
        try {
          return parseDefinition(previous.definition_snapshot, parsed.id)
        } catch {
          return undefined
        }
      })()
      const next = reconcileState({
        previous,
        previousDefinition,
        definition: parsed,
        now,
        startupRecovery: input.startupRecovery,
      })
      upsertState(next)
    } catch (error) {
      log.warn("invalid cron job definition", { filePath, error })
    }
  }

  for (const row of listStates()) {
    if (!presentIDs.has(row.job_id)) removeState(row.job_id)
  }

  return valid
}

async function handleScheduledTick(definitions: Definition[], now: number) {
  const enabled = await globalCronEnabled()
  await Promise.all(
    definitions.map(async (definition) => {
      const state = getState(definition.id)
      if (!state) return
      if (!shouldParticipate(definition, state)) return
      if (state.next_run_at === null || state.next_run_at > now) return

      if (!enabled) {
        scheduledSkipDisabled(definition, state, now)
        return
      }

      await execute(definition, "scheduled")
    }),
  )
}

function initSchedulerTimer() {
  if (scheduler.timer) return
  scheduler.timer = setInterval(async () => {
    try {
      const now = Date.now()
      const definitions = await scanDefinitions({ now })
      await handleScheduledTick(definitions, now)
    } catch (error) {
      log.error("cron tick failed", { error })
    }
  }, 60_000)
  scheduler.timer.unref?.()
}

const CreateInput = z.record(z.string(), z.unknown())
const UpdateInput = z.record(z.string(), z.unknown())

export namespace Cron {
  export const Definition = CronSchema.Definition
  export const State = CronSchema.State
  export const Run = CronSchema.Run

  export function registerDirectAction(action: string, handler: DirectHandler) {
    directHandlers.set(action, handler)
  }

  export function unregisterDirectAction(action: string) {
    directHandlers.delete(action)
  }

  export function setAgentDispatcher(next: AgentDispatcher) {
    agentDispatcher = next
  }

  export function resetAgentDispatcher() {
    agentDispatcher = defaultAgentDispatcher
  }

  export async function syncBuiltinMemoryReflectionJob() {
    return ensureBuiltinMemoryReflectionJob()
  }

  export const createJob = fn(CreateInput, async (input) => {
    await ensureJobDir()
    if ("id" in input) throw new Error("id is generated automatically")
    const definition = parseDefinition(input)
    await writeJobFile(definition)
    const now = Date.now()
    const state = reconcileState({
      previous: undefined,
      definition,
      now,
    })
    upsertState(state)
    return {
      definition,
      state: toState(state),
    }
  })

  export const updateJob = fn(
    z.object({
      id: z.string(),
      patch: UpdateInput,
    }),
    async ({ id, patch }) => {
      const filePath = path.join(jobsDir(), `${id}.json`)
      const existing = parseDefinition(asObject(await readJobFile(filePath), "job"), id)
      const definition = patchDefinition(existing, patch)
      await writeJobFile(definition)
      const previous = getState(id) ?? undefined
      const now = Date.now()
      const state = reconcileState({
        previous,
        previousDefinition: existing,
        definition,
        now,
      })
      upsertState(state)
      return {
        definition,
        state: toState(state),
      }
    },
  )

  export const deleteJob = fn(z.object({ id: z.string() }), async ({ id }) => {
    const filePath = path.join(jobsDir(), `${id}.json`)
    const definition = parseDefinition(asObject(await readJobFile(filePath), "job"), id)
    await deleteJobFile(id)
    removeState(id)
    return {
      ok: true as const,
      job_id: id,
      definition,
    }
  })

  export async function listJobs() {
    const definitions = await scanDefinitions({ now: Date.now() })
    return definitions.map((definition) => ({
      definition,
      state: getState(definition.id) ? toState(getState(definition.id)!) : null,
    }))
  }

  export async function getJob(id: string) {
    const filePath = path.join(jobsDir(), `${id}.json`)
    const definition = parseDefinition(asObject(await readJobFile(filePath), "job"), id)
    const state = getState(id)
    return {
      definition,
      state: state ? toState(state) : null,
    }
  }

  export const runJobNow = fn(z.object({ id: z.string() }), async ({ id }) => {
    await scanDefinitions({ now: Date.now() })
    const filePath = path.join(jobsDir(), `${id}.json`)
    const definition = parseDefinition(asObject(await readJobFile(filePath), "job"), id)
    const state = getState(id)
    if (!state) throw new Error(`Missing cron state for job ${id}`)
    return execute(definition, "manual")
  })

  export const listRuns = fn(
    z.object({
      id: z.string(),
      count: z.number().int().optional(),
    }),
    async ({ id, count }) => {
      const size = count === undefined ? 10 : count <= 0 ? 0 : Math.min(count, 100)
      if (size === 0) return [] as Run[]
      return queryRuns(id, size)
    },
  )

  export const getRun = fn(z.object({ run_id: z.string() }), async ({ run_id }) => {
    return queryRun(run_id)
  })

  export async function recover() {
    await Lock.write(runtimeLockPath()).then(async (lock) => {
      using _ = lock
      await ensureBuiltinMemoryReflectionJob()
      await scanDefinitions({ startupRecovery: true, now: Date.now() })
    })
  }

  export async function catchUpMissedMemoryReflection() {
    return Lock.write(runtimeLockPath()).then(async (lock) => {
      using _ = lock
      const now = Date.now()
      const { definition } = await ensureBuiltinMemoryReflectionJob()
      const state = getState(BUILTIN_MEMORY_REFLECTION_JOB_ID)
      if (!state) return null
      if (!shouldParticipate(definition, state)) return null
      if (state.next_run_at === null || state.next_run_at > now) return null

      if (!(await globalCronEnabled())) {
        scheduledSkipDisabled(definition, state, now)
        return null
      }

      return execute(definition, "scheduled")
    })
  }

  export async function tick() {
    await Lock.write(runtimeLockPath()).then(async (lock) => {
      using _ = lock
      const now = Date.now()
      await ensureBuiltinMemoryReflectionJob()
      const definitions = await scanDefinitions({ now })
      await handleScheduledTick(definitions, now)
    })
  }

  export async function start() {
    if (scheduler.started) return
    scheduler.started = true
    try {
      await recover()
    } catch (error) {
      log.error("cron recovery failed", { error })
    }
    void catchUpMissedMemoryReflection().catch((error) => {
      log.error("memory reflection catch-up failed", { error })
    })
    initSchedulerTimer()
  }

  export async function stop() {
    if (scheduler.timer) {
      clearInterval(scheduler.timer)
      scheduler.timer = undefined
    }
    scheduler.started = false
  }
}

Cron.registerDirectAction("memory_reflect", async ({ definition }) => {
  const payload = definition.payload as Record<string, unknown>
  const scope = Memory.ReflectionScope.catch("global").parse(payload.scope)
  const trigger = Memory.ReflectionTrigger.catch("cron").parse(payload.trigger)
  const dryRun = typeof payload.dry_run === "boolean" ? payload.dry_run : false
  const result = await Instance.provide({
    directory: typeof payload.directory === "string" ? payload.directory : Global.Path.data,
    init: InstanceBootstrap,
    fn: () =>
      Memory.reflect({
        scope,
        dry_run: dryRun,
        trigger,
      }),
  })
  return {
    output_summary: result.summary || `memory_reflect ${result.status}`,
  }
})

if (process.env.NODE_ENV !== "production") {
  Cron.registerDirectAction("debug_noop", async () => ({
    output_summary: "debug_noop executed",
  }))
}
