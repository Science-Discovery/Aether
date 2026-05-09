import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { ProjectID } from "./schema"
import { Timestamps } from "../storage/schema.sql"

export const GlobalProjectMapTable = sqliteTable("global_project_map", {
  directory: text().primaryKey(),
  project_id: text().$type<ProjectID>().notNull(),
  ...Timestamps,
})
