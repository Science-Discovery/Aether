import { Cron } from "@/cron"
import { Memory } from "."

export const MEMORY_DAILY_REFLECT_ACTION = "memory.reflect.daily"
export const MEMORY_DAILY_REFLECT_JOB_ID = "builtin.memory.daily_reflect"
const MEMORY_DAILY_REFLECT_LEGACY_ACTION = "memory_reflect"
const MEMORY_DAILY_REFLECT_LEGACY_JOB_IDS = ["builtin-memory-reflection-daily"]

export type InstalledMemory = {
  service: typeof Memory
  start(): Promise<void>
  stop(): Promise<void>
  purge(): Promise<void>
}

function scheduleFromTime(time: string | undefined) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time ?? "")
  const hour = match ? Number(match[1]) : 3
  const minute = match ? Number(match[2]) : 0
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return "0 3 * * *"
  }
  return `${minute} ${hour} * * *`
}

function dailyReflectDefinitionPatch(input: { enabled: boolean; schedule: string }) {
  return {
    name: "Daily memory reflection",
    enabled: input.enabled,
    mode: "direct" as const,
    project_id: null,
    session_id: null,
    schedule_type: "cron" as const,
    schedule_value: input.schedule,
    payload: {
      action: MEMORY_DAILY_REFLECT_ACTION,
    },
  }
}

async function disableLegacyDailyReflectJobs(schedule: string) {
  for (const id of MEMORY_DAILY_REFLECT_LEGACY_JOB_IDS) {
    const existing = await Cron.getJob(id).catch(() => undefined)
    if (!existing) continue
    await Cron.updateJob({
      id,
      patch: dailyReflectDefinitionPatch({
        enabled: false,
        schedule,
      }),
    })
  }
}

export async function syncDailyReflectJob(input?: { preserveExisting?: boolean }) {
  const cfg = await Memory.settings()
  const enabled = cfg.enabled && cfg.dailyReflectEnabled
  const schedule = scheduleFromTime(cfg.dailyReflectTime)
  await disableLegacyDailyReflectJobs(schedule)
  const existing = await Cron.getJob(MEMORY_DAILY_REFLECT_JOB_ID).catch(() => undefined)
  if (existing && input?.preserveExisting !== false) return existing
  if (existing) {
    return Cron.updateJob({
      id: MEMORY_DAILY_REFLECT_JOB_ID,
      patch: dailyReflectDefinitionPatch({ enabled, schedule }),
    })
  }
  return Cron.ensureJob({
    id: MEMORY_DAILY_REFLECT_JOB_ID,
    ...dailyReflectDefinitionPatch({ enabled, schedule }),
  })
}

export function registerMemoryDirectActions() {
  const handler = async () => {
    const result = await Memory.reflect({ mode: "daily", reason: "cron" })
    return {
      output_summary: result.summary,
    }
  }
  Cron.registerDirectAction(MEMORY_DAILY_REFLECT_ACTION, handler)
  Cron.registerDirectAction(MEMORY_DAILY_REFLECT_LEGACY_ACTION, handler)
}

export async function installMemory(): Promise<InstalledMemory> {
  registerMemoryDirectActions()
  await syncDailyReflectJob({ preserveExisting: false })
  await Memory.startupCatchup()
  return {
    service: Memory,
    start: async () => {
      await syncDailyReflectJob({ preserveExisting: false })
      await Memory.startupCatchup()
    },
    stop: Memory.stop,
    purge: Memory.purge,
  }
}
