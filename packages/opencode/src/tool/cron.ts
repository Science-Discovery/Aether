import z from "zod"
import path from "path"
import { Config } from "@/config/config"
import { Cron } from "@/cron"
import { Project } from "@/project/project"
import { ProjectID } from "@/project/schema"
import { Session } from "@/session"
import { Tool } from "./tool"

const Mode = z.enum(["direct", "isolated_agent", "session_agent", "agent_message"])
const ScheduleType = z.enum(["cron", "interval", "once"])
const ScheduleValue = z.union([z.string(), z.number().int()])
const Payload = z.record(z.string(), z.unknown())

const DefinitionInput = z
  .object({
    name: z.string().min(1).describe("Single-line human-readable job name."),
    enabled: z.boolean().optional().describe("Whether this job is allowed to run. Defaults to true."),
    mode: Mode.describe("direct runs a registered backend action; isolated_agent/session_agent trigger an agent; agent_message writes an assistant message without LLM inference."),
    project_id: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe("Required for isolated_agent, session_agent, and agent_message. Use 'current' or omit it to target the current session project."),
    session_id: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe("Required for session_agent and agent_message. Use 'current' or omit it to target the current session."),
    schedule_type: ScheduleType.describe("cron and once use a 5-field cron expression; interval uses seconds."),
    schedule_value: ScheduleValue.describe("5-field cron expression for cron/once, or positive integer seconds for interval."),
    timezone: z.string().min(1).nullable().optional().describe("Timezone for cron/once. Defaults to the system timezone."),
    payload: Payload.describe(
      "For direct: { action: string, ... }. For isolated_agent/session_agent: { message: string, ... }. For agent_message: { message: string, agent?: string, model?: { providerID, modelID } }. Extra JSON is preserved.",
    ),
  })
  .passthrough()

const UpdatePatch = z
  .object({
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    mode: Mode.optional(),
    project_id: z.string().min(1).nullable().optional(),
    session_id: z.string().min(1).nullable().optional(),
    schedule_type: ScheduleType.optional(),
    schedule_value: ScheduleValue.optional(),
    timezone: z.string().min(1).nullable().optional(),
    payload: Payload.optional(),
  })
  .passthrough()

function formatTime(input: number | null | undefined) {
  if (!input) return "-"
  return new Date(input).toISOString()
}

function renderDefinition(definition: z.infer<typeof Cron.Definition>) {
  return [
    `ID: ${definition.id}`,
    `Name: ${definition.name}`,
    `Enabled: ${definition.enabled}`,
    `Mode: ${definition.mode}`,
    `Schedule: ${definition.schedule_type} ${definition.schedule_value}`,
    `Timezone: ${definition.timezone ?? "-"}`,
    `Project: ${definition.project_id ?? "-"}`,
    `Session: ${definition.session_id ?? "-"}`,
    `Payload: ${JSON.stringify(definition.payload)}`,
  ].join("\n")
}

function renderState(state: z.infer<typeof Cron.State> | null | undefined) {
  if (!state) return "State: -"
  return [
    `State enabled: ${state.enabled}`,
    `Running: ${state.running}`,
    `Next run: ${formatTime(state.next_run_at)}`,
    `Last run: ${formatTime(state.last_run_at)}`,
    `Last status: ${state.last_status ?? "-"}`,
    `Start at: ${formatTime(state.start_at)}`,
    `Updated at: ${formatTime(state.updated_at)}`,
  ].join("\n")
}

function renderJob(job: { definition: z.infer<typeof Cron.Definition>; state: z.infer<typeof Cron.State> | null }) {
  return `${renderDefinition(job.definition)}\n${renderState(job.state)}`
}

function renderRun(run: z.infer<typeof Cron.Run>) {
  return [
    `Run ID: ${run.run_id}`,
    `Job ID: ${run.job_id}`,
    `Status: ${run.status}`,
    `Trigger: ${run.trigger_reason}`,
    `Mode: ${run.mode}`,
    `Started: ${formatTime(run.started_at)}`,
    `Finished: ${formatTime(run.finished_at)}`,
    `Project: ${run.project_id ?? "-"}`,
    `Session: ${run.session_id ?? "-"}`,
    `Created session: ${run.created_session_id ?? "-"}`,
    `Summary: ${run.output_summary ?? "-"}`,
  ].join("\n")
}

function isCurrentRef(value: string | null | undefined) {
  if (value === null || value === undefined) return true
  const normalized = value.trim().toLowerCase()
  return normalized === "" || normalized === "current" || normalized === "current_project" || normalized === "current_session"
}

async function currentSession(ctx: Tool.Context) {
  return Session.get(ctx.sessionID)
}

async function resolveProjectID(value: string | null | undefined, ctx: Tool.Context) {
  if (isCurrentRef(value)) return (await currentSession(ctx)).projectID
  if (typeof value !== "string") return (await currentSession(ctx)).projectID

  const projectRef = value
  const exact = Project.get(ProjectID.make(projectRef))
  if (exact) return exact.id

  const byLabel = Project.list().find((project) => {
    return project.id === projectRef || project.name === projectRef || path.basename(project.worktree) === projectRef
  })
  return byLabel?.id ?? projectRef
}

async function normalizeDefinitionInput(input: z.infer<typeof DefinitionInput>, ctx: Tool.Context) {
  const next = { ...input }
  if (next.mode === "isolated_agent" || next.mode === "session_agent" || next.mode === "agent_message") {
    next.project_id = await resolveProjectID(next.project_id, ctx)
  }
  if ((next.mode === "session_agent" || next.mode === "agent_message") && isCurrentRef(next.session_id)) {
    next.session_id = ctx.sessionID
  }
  return next
}

async function normalizePatch(input: z.infer<typeof UpdatePatch>, ctx: Tool.Context) {
  const next = { ...input }
  const wantsProject =
    next.project_id !== undefined || next.mode === "isolated_agent" || next.mode === "session_agent" || next.mode === "agent_message"
  if (wantsProject) {
    next.project_id = await resolveProjectID(next.project_id, ctx)
  }
  if ((next.session_id !== undefined || next.mode === "session_agent" || next.mode === "agent_message") && isCurrentRef(next.session_id)) {
    next.session_id = ctx.sessionID
  }
  return next
}

async function askCron(ctx: Tool.Context, action: string, pattern = "*", metadata: Record<string, unknown> = {}) {
  await ctx.ask({
    permission: "cron",
    patterns: [pattern],
    always: [pattern],
    metadata: {
      action,
      ...metadata,
    },
  })
}

export const CronListTool = Tool.define("cron_list", {
  description: [
    "List global cron jobs and their runtime state.",
    "Use this before creating a duplicate job or when the user asks what scheduled tasks exist.",
  ].join("\n"),
  parameters: z.object({}),
  async execute() {
    const jobs = await Cron.listJobs()
    return {
      title: `${jobs.length} cron job${jobs.length === 1 ? "" : "s"}`,
      output: jobs.length ? jobs.map(renderJob).join("\n\n---\n\n") : "No cron jobs defined.",
      metadata: {
        count: jobs.length,
        jobs: jobs.map((job) => ({
          id: job.definition.id,
          name: job.definition.name,
          enabled: job.definition.enabled,
          state_enabled: job.state?.enabled ?? null,
          next_run_at: job.state?.next_run_at ?? null,
          last_status: job.state?.last_status ?? null,
        })),
      },
    }
  },
})

export const CronGetTool = Tool.define("cron_get", {
  description: "Get one cron job definition, runtime state, and optionally recent runs.",
  parameters: z.object({
    id: z.string().min(1),
    runs_count: z.number().int().optional().describe("Number of recent runs to include. Defaults to 0."),
  }),
  async execute(input) {
    const job = await Cron.getJob(input.id)
    const runs = input.runs_count && input.runs_count > 0 ? await Cron.listRuns({ id: input.id, count: input.runs_count }) : []
    return {
      title: `Cron job ${job.definition.id}`,
      output: [renderJob(job), runs.length ? `Recent runs:\n\n${runs.map(renderRun).join("\n\n")}` : undefined]
        .filter(Boolean)
        .join("\n\n"),
      metadata: { job, runs },
    }
  },
})

export const CronCreateTool = Tool.define("cron_create", {
  description: [
    "Create a global cron job. The id is generated automatically.",
    "Schedule rules: cron/once require a 5-field cron expression; interval requires positive integer seconds.",
    "Mode rules: direct requires payload.action; isolated_agent requires project_id and payload.message; session_agent requires project_id, session_id, and payload.message; agent_message requires project_id, session_id, and payload.message.",
    "Use enabled=false if the user wants to stage the job without allowing execution yet.",
  ].join("\n"),
  parameters: DefinitionInput,
  async execute(input, ctx) {
    const definition = await normalizeDefinitionInput(input, ctx)
    await askCron(ctx, "create", "*", { name: definition.name, mode: definition.mode, schedule_type: definition.schedule_type })
    const job = await Cron.createJob(definition)
    return {
      title: `Cron job created: ${job.definition.name}`,
      output: renderJob(job),
      metadata: {
        id: job.definition.id,
        job,
      },
    }
  },
})

export const CronUpdateTool = Tool.define("cron_update", {
  description: [
    "Update an existing cron job. id is immutable.",
    "Changing schedule_type, schedule_value, mode, enabled, or relevant mode fields may recompute runtime state.",
    "Pass only fields that should change.",
  ].join("\n"),
  parameters: z.object({
    id: z.string().min(1),
    patch: UpdatePatch,
  }),
  async execute(input, ctx) {
    const patch = await normalizePatch(input.patch, ctx)
    await askCron(ctx, "update", input.id, { id: input.id, patch })
    const job = await Cron.updateJob({ id: input.id, patch })
    return {
      title: `Cron job updated: ${job.definition.name}`,
      output: renderJob(job),
      metadata: {
        id: job.definition.id,
        job,
      },
    }
  },
})

export const CronDeleteTool = Tool.define("cron_delete", {
  description: "Delete a cron job definition. Historical run logs are kept.",
  parameters: z.object({
    id: z.string().min(1),
  }),
  async execute(input, ctx) {
    await askCron(ctx, "delete", input.id, { id: input.id })
    const deleted = await Cron.deleteJob(input)
    return {
      title: `Cron job deleted: ${deleted.job_id}`,
      output: renderDefinition(deleted.definition),
      metadata: deleted,
    }
  },
})

export const CronRunNowTool = Tool.define("cron_run_now", {
  description: [
    "Manually trigger a cron job now.",
    "If global cron execution is disabled, this records a skipped run with a cron-disabled summary.",
    "If another instance of the same job is running, this records a skipped run.",
  ].join("\n"),
  parameters: z.object({
    id: z.string().min(1),
  }),
  async execute(input, ctx) {
    await askCron(ctx, "run_now", input.id, { id: input.id })
    const run = await Cron.runJobNow(input)
    return {
      title: `Cron run ${run.status}: ${run.job_id}`,
      output: renderRun(run),
      metadata: run,
    }
  },
})

export const CronRunsTool = Tool.define("cron_runs", {
  description: "List recent run logs for a cron job. Newer runs are returned first.",
  parameters: z.object({
    id: z.string().min(1),
    count: z.number().int().optional().describe("Defaults to 10. Values <= 0 return no runs."),
  }),
  async execute(input) {
    const runs = await Cron.listRuns(input)
    return {
      title: `${runs.length} cron run${runs.length === 1 ? "" : "s"}`,
      output: runs.length ? runs.map(renderRun).join("\n\n---\n\n") : "No runs recorded.",
      metadata: {
        count: runs.length,
        runs,
      },
    }
  },
})

export const CronSetGlobalEnabledTool = Tool.define("cron_set_global_enabled", {
  description: [
    "Enable or disable global cron execution.",
    "The scheduler always keeps running; this switch only controls whether due jobs execute.",
    "When disabled, scheduled cron/interval jobs silently advance, once jobs expire if missed, and manual run_now records cron_disabled.",
  ].join("\n"),
  parameters: z.object({
    enabled: z.boolean(),
  }),
  async execute(input, ctx) {
    await askCron(ctx, "set_global_enabled", "*", { enabled: input.enabled })
    const config = await Config.updateGlobal({ cron: { enabled: input.enabled } } as any)
    return {
      title: input.enabled ? "Cron execution enabled" : "Cron execution disabled",
      output: `Global cron execution is now ${input.enabled ? "enabled" : "disabled"}.\nScheduler remains running.`,
      metadata: {
        enabled: config.cron?.enabled ?? input.enabled,
      },
    }
  },
})
