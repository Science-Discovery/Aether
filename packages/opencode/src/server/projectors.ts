import z from "zod"
import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session"
import { SessionPreference } from "@/session/preference"
import { SessionTable, SessionPreferenceTable } from "@/session/session.sql"
import { Database, eq } from "@/storage/db"

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: (type, data) => {
      if (type === "session.updated") {
        const id = (data as z.infer<typeof Session.Event.Updated.schema>).sessionID
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())

        if (!row) return data

        return {
          sessionID: id,
          info: Session.fromRow(row),
        }
      }
      if (type === "session.preference.updated") {
        const id = (data as z.infer<typeof SessionPreference.Event.Updated.schema>).sessionID
        const row = Database.use((db) =>
          db.select().from(SessionPreferenceTable).where(eq(SessionPreferenceTable.session_id, id)).get(),
        )
        if (!row) return data
        return { sessionID: id, preference: SessionPreference.get(id) }
      }
      return data
    },
  })
}

initProjectors()
