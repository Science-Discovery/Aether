import z from "zod"
import { Database, eq, inArray } from "../storage/db"
import { SyncEvent } from "../sync"
import { SessionPreferenceTable } from "./session.sql"
import { SessionID } from "./schema"
import { ProviderID, ModelID } from "../provider/schema"
import { fn } from "@/util/fn"
import { Log } from "../util/log"

const log = Log.create({ service: "session.preference" })

export namespace SessionPreference {
  export const Info = z
    .object({
      sessionID: SessionID.zod,
      agent: z.string().nullable(),
      model: z
        .object({
          providerID: ProviderID.zod,
          modelID: ModelID.zod,
        })
        .nullable(),
      variant: z.string().nullable(),
      autoAccept: z.boolean().nullable(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
    })
    .meta({ ref: "SessionPreference" })
  export type Info = z.output<typeof Info>

  export const Patch = z.object({
    sessionID: SessionID.zod,
    agent: z.string().nullable().optional(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .nullable()
      .optional(),
    variant: z.string().nullable().optional(),
    autoAccept: z.boolean().nullable().optional(),
  })
  export type Patch = z.output<typeof Patch>

  export const Event = {
    Updated: SyncEvent.define({
      type: "session.preference.updated",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        preference: Info,
      }),
    }),
  }

  function fromRow(row: typeof SessionPreferenceTable.$inferSelect): Info {
    return {
      sessionID: row.session_id,
      agent: row.agent ?? null,
      model:
        row.model_provider_id && row.model_id
          ? { providerID: ProviderID.make(row.model_provider_id), modelID: ModelID.make(row.model_id) }
          : null,
      variant: row.variant ?? null,
      autoAccept: row.auto_accept ?? null,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  function empty(sessionID: SessionID): Info {
    const now = Date.now()
    return {
      sessionID,
      agent: null,
      model: null,
      variant: null,
      autoAccept: null,
      time: { created: now, updated: now },
    }
  }

  export const get = fn(SessionID.zod, (sessionID): Info => {
    try {
      const row = Database.use((db) =>
        db.select().from(SessionPreferenceTable).where(eq(SessionPreferenceTable.session_id, sessionID)).get(),
      )
      return row ? fromRow(row) : empty(sessionID)
    } catch (err) {
      log.error("get failed", err as Record<string, unknown>)
      return empty(sessionID)
    }
  })

  export const list = fn(z.array(SessionID.zod), (ids): Info[] => {
    if (ids.length === 0) return []
    try {
      const rows = Database.use((db) =>
        db.select().from(SessionPreferenceTable).where(inArray(SessionPreferenceTable.session_id, ids)).all(),
      )
      const map = new Map(rows.map((r) => [r.session_id, fromRow(r)]))
      return ids.map((id) => map.get(id) ?? empty(id))
    } catch (err) {
      log.error("list failed", err as Record<string, unknown>)
      return ids.map((id) => empty(id))
    }
  })

  export const set = fn(Patch, (patch): Info => {
    const current = get(patch.sessionID)

    const agent = patch.agent === undefined ? current.agent : patch.agent
    const model = patch.model === undefined ? current.model : patch.model
    const variant = patch.variant === undefined ? current.variant : patch.variant
    const autoAccept = patch.autoAccept === undefined ? current.autoAccept : patch.autoAccept

    const resolvedVariant = model === null ? null : variant
    const now = Date.now()

    const preference: Info = {
      sessionID: patch.sessionID,
      agent,
      model,
      variant: resolvedVariant,
      autoAccept,
      time: {
        created: current.time.created,
        updated: now,
      },
    }

    try {
      SyncEvent.run(Event.Updated, { sessionID: patch.sessionID, preference })
    } catch (err) {
      log.error("set sync failed", err as Record<string, unknown>)
    }
    return preference
  })
}
