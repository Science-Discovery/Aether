import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { ProjectID } from "./schema"

export const ProjectTable = sqliteTable("project", {
  id: text().$type<ProjectID>().primaryKey(),
  worktree: text().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_color: text(),
  ...Timestamps,
  time_initialized: integer(),
  sandboxes: text({ mode: "json" }).notNull().$type<string[]>(),
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})

export const ProjectRecentTable = sqliteTable("project_recent", {
  key: text().primaryKey(),
  kind: text().notNull().$type<"project" | "directory">(),
  project_id: text().$type<ProjectID | null>(),
  directory: text().notNull(),
  name: text(),
  icon_url: text(),
  icon_color: text(),
  icon_override: text(),
  activity_at: integer().notNull(),
  ...Timestamps,
})
