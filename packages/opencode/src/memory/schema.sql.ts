import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const MemoryEventTable = sqliteTable(
  "memory_event",
  {
    id: text().primaryKey(),
    created_at: integer().notNull(),
    op: text().$type<"remember" | "forget">().notNull(),
    type: text().$type<"preference" | "fact" | "task" | null>(),
    intent: text().$type<"explicit" | "observed">().notNull(),
    raw_text: text().notNull(),
    channel_id: text(),
    project_id: text(),
    session_id: text(),
    message_id: text(),
    role: text().$type<"user" | "assistant" | "system" | "tool" | null>(),
    source_json: text().notNull(),
    candidate_key: text(),
    candidate_summary: text(),
    confidence_hint: real(),
    status: text()
      .$type<"new" | "pending_important" | "applied" | "ignored" | "deleted" | "forgot" | "deprecated" | "superseded">()
      .notNull()
      .default("new"),
    reflected_at: integer(),
    result_json: text(),
  },
  (table) => [
    index("memory_event_created_idx").on(table.created_at),
    index("memory_event_status_idx").on(table.status),
    index("memory_event_candidate_key_idx").on(table.candidate_key),
    index("memory_event_project_created_idx").on(table.project_id, table.created_at),
    index("memory_event_session_created_idx").on(table.session_id, table.created_at),
  ],
)

export const ReflectionRunTable = sqliteTable("reflection_run", {
  id: text().primaryKey(),
  mode: text().$type<"quick" | "daily" | "manual">().notNull(),
  started_at: integer().notNull(),
  completed_at: integer(),
  model: text(),
  input_event_ids_json: text(),
  md_before_hash: text(),
  md_after_hash: text(),
  summary_json: text(),
  error: text(),
})

export const MemorySettingTable = sqliteTable("memory_setting", {
  key: text().primaryKey(),
  value: text().notNull(),
})
