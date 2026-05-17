import { createSessionBackup, SessionBackupSchema, type SessionBackupData } from "@opencode-ai/util/session-backup"
import { Slug } from "@opencode-ai/util/slug"
import { Installation } from "../installation"
import { Instance } from "../project/instance"
import { SyncEvent } from "../sync"
import { fn } from "@/util/fn"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, SessionID, TreeID } from "./schema"

function rewrite(value: unknown, map: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewrite(item, map))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "sourceMessageID" && typeof item === "string") return [key, map.get(item) ?? item]
      return [key, rewrite(item, map)]
    }),
  )
}

function stamp(part: MessageV2.Part, time: number) {
  if (part.type === "text" || part.type === "reasoning") return part.time?.start ?? time
  if (part.type === "tool") {
    if ("time" in part.state) return part.state.time.start
    return time
  }
  return time
}

export function buildSessionBackup(info: Session.Info, messages: MessageV2.WithParts[]): SessionBackupData {
  return createSessionBackup(
    info,
    messages.map((msg) => ({
      info: msg.info,
      parts: msg.parts,
    })),
  )
}

export const importSessionBackup = fn(SessionBackupSchema, async (input) => {
  const data = SessionBackupSchema.parse(input)
  const src = Session.Info.parse(data.info)
  const sid = SessionID.descending()
  const tid = TreeID.descending()
  const now = Date.now()
  const mids = new Map<string, string>()
  const pids = new Map<string, string>()
  const rows = data.messages.map((msg) => ({
    info: MessageV2.Info.parse(msg.info),
    parts: msg.parts.map((part) => MessageV2.Part.parse(part)),
  }))

  for (const row of rows) mids.set(row.info.id, MessageID.ascending())
  for (const row of rows) for (const part of row.parts) pids.set(part.id, PartID.ascending())

  const info = Session.Info.parse({
    ...src,
    id: sid,
    slug: Slug.create(),
    version: Installation.VERSION,
    projectID: Instance.project.id,
    workspaceID: undefined,
    directory: Instance.directory,
    parentID: undefined,
    treeID: tid,
    forkIndex: undefined,
    forkParentSessionID: undefined,
    forkAfterUserMessageID: undefined,
    share: undefined,
    revert: undefined,
    time: {
      created: now,
      updated: now,
    },
  })

  SyncEvent.run(Session.Event.Created, {
    sessionID: sid,
    info,
  })

  for (const row of rows) {
    const id = mids.get(row.info.id)
    if (!id) throw new Error(`Missing imported message id: ${row.info.id}`)
    const msg = (() => {
      if (row.info.role !== "assistant") {
        return MessageV2.Info.parse({
          ...row.info,
          id,
          sessionID: sid,
        })
      }
      const parent = mids.get(row.info.parentID)
      if (!parent) throw new Error(`Missing imported parent message id: ${row.info.parentID}`)
      return MessageV2.Info.parse({
        ...row.info,
        id,
        sessionID: sid,
        parentID: parent,
      })
    })()

    SyncEvent.run(MessageV2.Event.Updated, {
      sessionID: sid,
      info: msg,
    })

    for (const raw of row.parts) {
      const pid = pids.get(raw.id)
      if (!pid) throw new Error(`Missing imported part id: ${raw.id}`)
      const mid = mids.get(raw.messageID)
      if (!mid) throw new Error(`Missing imported part message id: ${raw.messageID}`)
      const part = MessageV2.Part.parse({
        ...raw,
        id: pid,
        sessionID: sid,
        messageID: mid,
        ...("metadata" in raw && raw.metadata ? { metadata: rewrite(raw.metadata, mids) } : {}),
      })

      SyncEvent.run(MessageV2.Event.PartUpdated, {
        sessionID: sid,
        part,
        time: stamp(raw, row.info.time.created),
      })
    }
  }

  return {
    sessionID: sid,
    title: info.title,
  }
})
