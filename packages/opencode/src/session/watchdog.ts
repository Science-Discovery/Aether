import { Log } from "@/util/log"
import { NamedError } from "@opencode-ai/util/error"
import { eq } from "drizzle-orm"
import { Bus } from "@/bus"
import { Database, NotFoundError } from "@/storage/db"
import { Instance } from "@/project/instance"
import { Session } from "."
import { MessageID, SessionID } from "./schema"
import { SessionRetryTable } from "./session.sql"
import { SessionStatus } from "./status"
import { SessionPrompt } from "./prompt"
import { SessionRetry } from "./retry"

export namespace SessionWatchdog {
  const log = Log.create({ service: "session.watchdog" })
  const timers = new Map<SessionID, ReturnType<typeof setTimeout>>()

  type Row = typeof SessionRetryTable.$inferSelect

  // Old project DBs never receive migrations added after their creation
  // (initAndSetupProject backfills the drizzle journal as-applied), so the
  // session_retry table may be missing. Every access must ensure it exists
  // first: a missing table here breaks cancel() — the session stays busy
  // forever and the stop button dies with it.
  function ensure(projectID: string) {
    const db = Database.projectClient(projectID)
    const has = db.$client.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_retry'").get()
    if (has) return
    db.$client.exec(`
      CREATE TABLE IF NOT EXISTS \`session_retry\` (
        \`session_id\` text PRIMARY KEY,
        \`message_id\` text NOT NULL,
        \`started_at\` integer NOT NULL,
        \`next_at\` integer NOT NULL,
        \`attempts\` integer NOT NULL,
        \`message\` text NOT NULL,
        \`time_created\` integer NOT NULL,
        \`time_updated\` integer NOT NULL,
        CONSTRAINT \`fk_session_retry_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
      );
    `)
  }

  async function record(sessionID: SessionID) {
    const session = await Session.getGlobal(sessionID)
    ensure(session.projectID)
    return Database.useProject(session.projectID, (db) =>
      db.select().from(SessionRetryTable).where(eq(SessionRetryTable.session_id, sessionID)).get(),
    )
  }

  export async function pending(sessionID: SessionID) {
    return (await record(sessionID)) !== undefined
  }

  function disarm(sessionID: SessionID) {
    const timer = timers.get(sessionID)
    if (!timer) return
    clearTimeout(timer)
    timers.delete(sessionID)
  }

  function arm(sessionID: SessionID, next: number) {
    disarm(sessionID)
    timers.set(
      sessionID,
      setTimeout(
        () => {
          void fire(sessionID).catch((error) => log.error("retry wake crashed", { sessionID, error }))
        },
        Math.max(0, next - Date.now()),
      ),
    )
  }

  // Called when the session loop gives up on a connection-class upstream
  // failure: persist the wait (first failure time is kept across wakes) and
  // arm the wake timer. The session loop releases its busy claim right after,
  // so the session stays usable while the wait is pending.
  export async function defer(input: { sessionID: SessionID; messageID: MessageID; message: string }) {
    const now = Date.now()
    const prev = await record(input.sessionID).catch(() => undefined)
    // Same turn keeps the original window anchor; a different anchor means a
    // new user message turned this into a new task with a fresh 10-day window.
    const same = prev?.message_id === input.messageID
    const started = same ? prev!.started_at : now
    if (SessionRetry.expired(started, now)) {
      await expire(input.sessionID, started)
      return
    }
    const attempts = (same ? prev!.attempts : 0) + 1
    const next = now + SessionRetry.longDelay(now - started)
    const session = await Session.getGlobal(input.sessionID)
    await Database.useProject(session.projectID, (db) =>
      db
        .insert(SessionRetryTable)
        .values({
          session_id: input.sessionID,
          message_id: input.messageID,
          started_at: started,
          next_at: next,
          attempts,
          message: input.message,
        })
        .onConflictDoUpdate({
          target: SessionRetryTable.session_id,
          set: {
            message_id: input.messageID,
            started_at: started,
            next_at: next,
            attempts,
            message: input.message,
            time_updated: now,
          },
        }),
    )
    await SessionStatus.set(input.sessionID, { type: "retry", attempt: attempts, message: input.message, next })
    arm(input.sessionID, next)
    log.info("retry scheduled", { sessionID: input.sessionID, attempts, next, started })
  }

  // Drop the wait and stop the timer. Invoked when the turn resolves (loop
  // finished or was superseded) or the user cancels while waiting.
  export async function clear(sessionID: SessionID) {
    disarm(sessionID)
    const session = await Session.getGlobal(sessionID).catch((error) => {
      if (!NotFoundError.isInstance(error)) throw error
      return undefined
    })
    if (!session) return
    ensure(session.projectID)
    await Database.useProject(session.projectID, (db) =>
      db.delete(SessionRetryTable).where(eq(SessionRetryTable.session_id, sessionID)),
    )
  }

  async function expire(sessionID: SessionID, started: number) {
    await clear(sessionID)
    const session = await Session.getGlobal(sessionID).catch(() => undefined)
    if (!session) return
    await Instance.provide({
      directory: session.directory,
      fn: async () => {
        await SessionStatus.set(sessionID, { type: "idle" })
        Bus.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: "Upstream LLM stayed unreachable for 10 days; automatic retries stopped.",
          }).toObject(),
        })
      },
    })
    log.warn("retry window exhausted", { sessionID, started })
  }

  /** @internal Exported for testing */
  export async function fire(sessionID: SessionID) {
    disarm(sessionID)
    const row = await record(sessionID).catch(() => undefined)
    if (!row) return
    const now = Date.now()
    if (SessionRetry.expired(row.started_at, now)) {
      await expire(sessionID, row.started_at)
      return
    }
    const session = await Session.getGlobal(sessionID).catch(() => undefined)
    if (!session) return
    log.info("retry wake", { sessionID, attempts: row.attempts })
    await Instance.provide({
      directory: session.directory,
      fn: async () => {
        try {
          await SessionPrompt.loop({ sessionID })
        } catch (error) {
          if (error instanceof Session.BusyError) {
            const next = Date.now() + SessionRetry.longDelay(Date.now() - row.started_at)
            arm(sessionID, next)
            log.info("retry wake skipped, session busy", { sessionID, next })
            return
          }
          await clear(sessionID)
          await SessionStatus.set(sessionID, { type: "idle" })
          const message = error instanceof Error ? error.message : String(error)
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({ message: `Retry wake failed: ${message}` }).toObject(),
          })
          log.error("retry wake failed", { sessionID, error })
          return
        }
        // The loop either resolved the turn (cancel() cleared the record) or
        // scheduled the next wake; nothing to do here either way.
      },
    })
  }

  // Re-arm waits persisted before a restart and re-publish their retry status
  // so the UI shows the session as still waiting. Runs inside instance boot.
  export async function recover() {
    ensure(Instance.project.id)
    const rows = Database.useProject(Instance.project.id, (db) => db.select().from(SessionRetryTable).all())
    const now = Date.now()
    for (const row of rows) {
      if (SessionRetry.expired(row.started_at, now)) {
        await clear(row.session_id)
        continue
      }
      const session = await Session.getGlobal(row.session_id).catch(() => undefined)
      if (!session) continue
      await SessionStatus.set(row.session_id, {
        type: "retry",
        attempt: row.attempts,
        message: row.message,
        next: row.next_at,
      })
      arm(row.session_id, row.next_at)
      log.info("retry wait recovered", { sessionID: row.session_id, next: row.next_at })
    }
  }
}
