import { createSessionBackup, SessionBackupSchema, type SessionBackupData } from "@opencode-ai/util/session-backup"
import { NamedError } from "@opencode-ai/util/error"
import { Slug } from "@opencode-ai/util/slug"
import z from "zod"
import { Installation } from "../installation"
import { Instance } from "../project/instance"
import { WorkspaceContext } from "../control-plane/workspace-context"
import { SyncEvent } from "../sync"
import { fn } from "@/util/fn"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, SessionID, TreeID } from "./schema"

export const InvalidSessionBackupError = NamedError.create(
  "InvalidSessionBackupError",
  z.object({ message: z.string() }),
)

function invalid(message: string): never {
  throw new InvalidSessionBackupError({ message })
}

function rewrite(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewrite(item, ids))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "sourceMessageID" && typeof item === "string" ? (ids.get(item) ?? item) : rewrite(item, ids),
    ]),
  )
}

function stamp(part: MessageV2.Part, time: number) {
  if (part.type === "text" || part.type === "reasoning") return part.time?.start ?? time
  if (part.type === "tool" && "time" in part.state) return part.state.time.start
  return time
}

function unique(rows: string[], label: string) {
  if (new Set(rows).size !== rows.length) invalid(`Duplicate ${label} ID in session backup`)
}

export function buildSessionBackup(info: Session.Info, messages: MessageV2.WithParts[]): SessionBackupData {
  return createSessionBackup(
    info,
    messages.map((msg) => ({ info: msg.info, parts: msg.parts })),
  )
}

export const importSessionBackup = fn(SessionBackupSchema, async (input) => {
  const data = SessionBackupSchema.parse(input)
  const parsed = (() => {
    try {
      return {
        src: Session.Info.parse(data.info),
        rows: data.messages.map((msg) => ({
          info: MessageV2.Info.parse(msg.info),
          parts: msg.parts.map((part) => MessageV2.Part.parse(part)),
        })),
      }
    } catch (err) {
      if (err instanceof z.ZodError) invalid(z.prettifyError(err))
      throw err
    }
  })()
  const src = parsed.src
  const rows = parsed.rows
  const mids = new Map(rows.map((row) => [row.info.id, MessageID.ascending()]))
  const parts = rows.flatMap((row) => row.parts)
  const pids = new Map(parts.map((part) => [part.id, PartID.ascending()]))

  unique(
    rows.map((row) => row.info.id),
    "message",
  )
  unique(
    parts.map((part) => part.id),
    "part",
  )

  for (const row of rows) {
    if (row.info.sessionID !== src.id) invalid(`Message ${row.info.id} belongs to another session`)
    if (row.info.role === "assistant" && !mids.has(row.info.parentID)) {
      invalid(`Missing parent message: ${row.info.parentID}`)
    }
    for (const part of row.parts) {
      if (part.sessionID !== src.id) invalid(`Part ${part.id} belongs to another session`)
      if (part.messageID !== row.info.id) invalid(`Part ${part.id} belongs to another message`)
    }
  }

  const sid = SessionID.descending()
  const now = Date.now()
  const info = Session.Info.parse({
    ...src,
    id: sid,
    slug: Slug.create(),
    version: Installation.VERSION,
    projectID: Instance.project.id,
    workspaceID: WorkspaceContext.workspaceID,
    directory: Instance.directory,
    parentID: undefined,
    treeID: TreeID.descending(),
    forkIndex: undefined,
    forkParentSessionID: undefined,
    forkAfterUserMessageID: undefined,
    share: undefined,
    revert: undefined,
    permission: undefined,
    readingMode: undefined,
    time: { created: now, updated: now },
  })

  SyncEvent.run(Session.Event.Created, { sessionID: sid, info })
  try {
    for (const row of rows) {
      const id = mids.get(row.info.id)!
      const msg = MessageV2.Info.parse({
        ...row.info,
        id,
        sessionID: sid,
        ...(row.info.role === "assistant" ? { parentID: mids.get(row.info.parentID)! } : {}),
      })
      SyncEvent.run(MessageV2.Event.Updated, { sessionID: sid, info: msg })

      for (const raw of row.parts) {
        const part = MessageV2.Part.parse({
          ...raw,
          id: pids.get(raw.id)!,
          sessionID: sid,
          messageID: id,
          ...("metadata" in raw && raw.metadata ? { metadata: rewrite(raw.metadata, mids) } : {}),
        })
        SyncEvent.run(MessageV2.Event.PartUpdated, {
          sessionID: sid,
          part,
          time: stamp(raw, row.info.time.created),
        })
      }
    }
    SyncEvent.run(Session.Event.Updated, {
      sessionID: sid,
      info: { projectID: info.projectID, time: { updated: Math.max(Date.now(), now + 1) } },
    })
  } catch (err) {
    SyncEvent.run(Session.Event.Deleted, { sessionID: sid, info })
    SyncEvent.remove(sid)
    throw err
  }

  return { sessionID: sid, title: info.title }
})
