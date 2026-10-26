import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { MessageV2 } from "../session/message-v2"
import type { MessageID, SessionID } from "../session/schema"
import { SessionTable } from "../session/session.sql"

export const NativeStateTable = sqliteTable("native_state", {
  session_id: text()
    .$type<SessionID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  home: text(),
  time_synced: integer(),
})

// Immutable submitted input also owns Aether-only citations and attachment references.
// It is not an independently editable copy of Codex's assistant history.
export const NativeInputTable = sqliteTable(
  "native_input",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    data: text({ mode: "json" }).$type<MessageV2.WithParts>().notNull(),
    context: integer({ mode: "boolean" }).notNull(),
    state: text({ enum: ["pending", "consumed", "failed"] }).notNull(),
    dispatch_id: text().$type<MessageID>(),
    time_created: integer().notNull(),
  },
  (table) => [index("native_input_session_idx").on(table.session_id, table.time_created, table.id)],
)

export const NativeDispatchTable = sqliteTable(
  "native_dispatch",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    assistant_id: text().$type<MessageID>().notNull(),
    assistant: text({ mode: "json" }).$type<MessageV2.Assistant>(),
    thread_id: text().notNull(),
    turn_id: text(),
    reviews: text({ mode: "json" }).$type<MessageV2.ToolPart[]>().notNull().default([]),
    state: text({ enum: ["sending", "accepted", "uncertain"] }).notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("native_dispatch_session_idx").on(table.session_id, table.time_created)],
)
