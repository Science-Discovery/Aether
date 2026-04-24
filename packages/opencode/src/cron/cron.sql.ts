import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core"

export const CronJobStateTable = sqliteTable(
  "cron_job_state",
  {
    job_id: text().primaryKey(),
    enabled: integer({ mode: "boolean" }).notNull(),
    next_run_at: integer(),
    last_run_at: integer(),
    last_status: text().$type<"success" | "failed" | "skipped" | "expired" | null>(),
    running: integer({ mode: "boolean" }).notNull().default(false),
    start_at: integer(),
    definition_snapshot: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
    updated_at: integer().notNull(),
  },
  (table) => [index("cron_job_state_next_run_idx").on(table.next_run_at)],
)

export const CronRunTable = sqliteTable(
  "cron_run",
  {
    run_id: text().primaryKey(),
    job_id: text().notNull(),
    started_at: integer().notNull(),
    finished_at: integer().notNull(),
    status: text().$type<"success" | "failed" | "skipped">().notNull(),
    output_summary: text(),
    mode: text().$type<"direct" | "isolated_agent" | "session_agent" | "agent_message">().notNull(),
    project_id: text(),
    session_id: text(),
    created_session_id: text(),
    payload_snapshot: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
    trigger_reason: text().$type<"scheduled" | "manual">().notNull(),
  },
  (table) => [index("cron_run_job_started_idx").on(table.job_id, table.started_at)],
)
