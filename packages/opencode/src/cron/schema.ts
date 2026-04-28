import z from "zod"

export namespace CronSchema {
  export const Mode = z.enum(["direct", "isolated_agent", "session_agent", "agent_message"])
  export type Mode = z.infer<typeof Mode>

  export const ScheduleType = z.enum(["cron", "interval", "once"])
  export type ScheduleType = z.infer<typeof ScheduleType>

  export const RunStatus = z.enum(["success", "failed", "skipped"])
  export type RunStatus = z.infer<typeof RunStatus>

  export const LastStatus = z.enum(["success", "failed", "skipped", "expired"]).nullable()
  export type LastStatus = z.infer<typeof LastStatus>

  export const TriggerReason = z.enum(["scheduled", "manual"])
  export type TriggerReason = z.infer<typeof TriggerReason>

  export const Definition = z
    .object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      mode: Mode,
      project_id: z.string().nullable().optional(),
      session_id: z.string().nullable().optional(),
      schedule_type: ScheduleType,
      schedule_value: z.union([z.string(), z.number().int()]),
      timezone: z.string().nullable().optional(),
      payload: z.record(z.string(), z.unknown()),
    })
    .passthrough()
  export type Definition = z.infer<typeof Definition>

  export const State = z.object({
    job_id: z.string(),
    enabled: z.boolean(),
    next_run_at: z.number().int().nullable(),
    last_run_at: z.number().int().nullable(),
    last_status: LastStatus,
    running: z.boolean(),
    start_at: z.number().int().nullable(),
    updated_at: z.number().int(),
  })
  export type State = z.infer<typeof State>

  export const Run = z.object({
    run_id: z.string(),
    job_id: z.string(),
    started_at: z.number().int(),
    finished_at: z.number().int(),
    status: RunStatus,
    output_summary: z.string().nullable(),
    mode: Mode,
    project_id: z.string().nullable(),
    session_id: z.string().nullable(),
    created_session_id: z.string().nullable(),
    payload_snapshot: z.record(z.string(), z.unknown()),
    trigger_reason: TriggerReason,
  })
  export type Run = z.infer<typeof Run>
}
