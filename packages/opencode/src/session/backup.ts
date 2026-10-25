import {
  createSessionBackup,
  parseSessionBackup,
  type SessionBackupData,
  type SessionBackupInput,
} from "@opencode-ai/util/session-backup"
import { NamedError } from "@opencode-ai/util/error"
import { Slug } from "@opencode-ai/util/slug"
import z from "zod"
import { Installation } from "../installation"
import { Instance } from "../project/instance"
import { WorkspaceContext } from "../control-plane/workspace-context"
import { Database, count, eq, sql } from "../storage/db"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, SessionID, TreeID } from "./schema"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import { SessionStatus } from "./status"

const log = Log.create({ service: "session.backup" })

export const InvalidSessionBackupError = NamedError.create(
  "InvalidSessionBackupError",
  z.object({ message: z.string() }),
)

export const SessionImportActiveError = NamedError.create("SessionImportActiveError", z.object({ message: z.string() }))

export type ImportSessionOptions = {
  parentID?: SessionID
  title?: string
}

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

export async function estimateSessionBackup(sessionID: SessionID) {
  const info = await Session.get(sessionID)
  const messages = Database.useProject(Instance.project.id, (db) =>
    db
      .select({
        count: count(),
        bytes: sql<number>`coalesce(sum(length(cast(${MessageTable.data} as blob)) + length(${MessageTable.id}) + length(${MessageTable.session_id})), 0)`,
      })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID))
      .get(),
  )
  const parts = Database.useProject(Instance.project.id, (db) =>
    db
      .select({
        count: count(),
        bytes: sql<number>`coalesce(sum(length(cast(${PartTable.data} as blob)) + length(${PartTable.id}) + length(${PartTable.message_id}) + length(${PartTable.session_id})), 0)`,
      })
      .from(PartTable)
      .where(eq(PartTable.session_id, sessionID))
      .get(),
  )
  return {
    bytes:
      new TextEncoder().encode(JSON.stringify(info)).byteLength +
      Number(messages?.bytes ?? 0) +
      Number(parts?.bytes ?? 0),
    messages: Number(messages?.count ?? 0),
    parts: Number(parts?.count ?? 0),
  }
}

export async function importSessionBackup(
  input: SessionBackupInput,
  signal?: AbortSignal,
  options?: ImportSessionOptions,
) {
  const data = parseSessionBackup(input)
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
  if (src.engine)
    invalid(
      "Native Codex sessions cannot be imported as independent conversations. Resume the original session instead.",
    )
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

  const parent = options?.parentID
    ? await Session.get(options.parentID).catch(() => undefined)
    : undefined
  if (options?.parentID && !parent) invalid("Parent session not found")
  const sid = SessionID.descending()
  const now = Date.now()
  const info = Session.Info.parse({
    ...src,
    id: sid,
    slug: Slug.create(),
    version: Installation.VERSION,
    projectID: Instance.project.id,
    workspaceID: parent?.workspaceID ?? WorkspaceContext.workspaceID,
    directory: parent?.directory ?? Instance.directory,
    parentID: parent?.id,
    treeID: parent?.treeID ?? TreeID.descending(),
    forkIndex: undefined,
    forkParentSessionID: undefined,
    forkAfterUserMessageID: undefined,
    share: undefined,
    revert: undefined,
    permission: undefined,
    readingMode: undefined,
    title: options?.title ?? src.title,
    time: { created: now, updated: Math.max(Date.now(), now + 1) },
  })

  const messages = rows.map((row) => {
    const id = mids.get(row.info.id)!
    return {
      info: MessageV2.Info.parse({
        ...row.info,
        id,
        sessionID: sid,
        ...(row.info.role === "assistant" ? { parentID: mids.get(row.info.parentID)! } : {}),
      }),
      parts: row.parts.map((raw) => ({
        part: MessageV2.Part.parse({
          ...raw,
          id: pids.get(raw.id)!,
          sessionID: sid,
          messageID: id,
          ...("metadata" in raw && raw.metadata ? { metadata: rewrite(raw.metadata, mids) } : {}),
        }),
        time: stamp(raw, row.info.time.created),
      })),
    }
  })

  signal?.throwIfAborted()
  if (await SessionStatus.hasActiveProject()) {
    throw new SessionImportActiveError({ message: "Wait for active sessions to finish before importing" })
  }
  signal?.throwIfAborted()
  Database.transactionProject(
    info.projectID,
    (tx) => {
      tx.insert(SessionTable).values(Session.toRow(info)).run()
      if (messages.length > 0) {
        tx.insert(MessageTable)
          .values(
            messages.map((msg) => {
              const { id, sessionID, ...rest } = msg.info
              return {
                id,
                session_id: sessionID,
                time_created: msg.info.time.created,
                data: rest,
              }
            }),
          )
          .run()
      }
      const parts = messages.flatMap((msg) =>
        msg.parts.map((item) => {
          const { id, messageID, sessionID, ...rest } = item.part
          return {
            id,
            message_id: messageID,
            session_id: sessionID,
            time_created: item.time,
            data: rest,
          }
        }),
      )
      if (parts.length > 0) tx.insert(PartTable).values(parts).run()
    },
    { behavior: "immediate" },
  )
  await Bus.publish(Session.Event.Imported, { sessionID: sid, info }).catch((err) => {
    log.error("failed to publish imported session", { sessionID: sid, error: err })
  })

  return { sessionID: sid, title: info.title }
}

export async function linkSubagent(input: {
  parentID: SessionID
  childID: SessionID
  title: string
  agent?: string
  anchor?: number
}) {
  const messages = await Session.messages({ sessionID: input.parentID })
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "task" || part.state.status !== "completed") continue
      if (part.state.metadata?.sessionId === input.childID) return true
    }
  }
  const last = messages.at(-1)?.info
  const previous =
    last?.role === "assistant" ? (last.time.completed ?? last.time.created) : (last?.time.created ?? 0)
  const requested =
    input.anchor !== undefined && Number.isFinite(input.anchor) ? input.anchor : Math.max(Date.now(), previous + 1)
  const user =
    messages.findLast((message) => message.info.role === "user" && message.info.time.created <= requested) ??
    messages.find((message) => message.info.role === "user")
  if (!user) return false
  const time = Math.max(requested, user.info.time.created + 1)
  const assistant =
    messages.findLast((message) => message.info.role === "assistant" && message.info.time.created <= time) ??
    messages.findLast((message) => message.info.role === "assistant")
  const modelID = assistant?.info.role === "assistant" ? assistant.info.modelID : "unknown"
  const providerID = assistant?.info.role === "assistant" ? assistant.info.providerID : "unknown"
  const messageID = MessageID.ascending()
  await Session.updateMessage(
    MessageV2.Info.parse({
      id: messageID,
      sessionID: input.parentID,
      role: "assistant",
      time: { created: time, completed: time },
      parentID: user.info.id,
      modelID,
      providerID,
      mode: "build",
      agent: input.agent ?? "build",
      path: { cwd: Instance.directory, root: Instance.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "tool-calls",
    }),
  )
  await Session.updatePart(
    MessageV2.Part.parse({
      id: PartID.ascending(),
      sessionID: input.parentID,
      messageID,
      type: "tool",
      callID: `call_import_subagent_${input.childID}`,
      tool: "task",
      state: {
        status: "completed",
        input: {
          description: input.title,
          subagent_type: input.agent ?? "general",
          prompt: input.title,
        },
        output: "Imported subagent session",
        title: input.title,
        metadata: { sessionId: input.childID, imported: true },
        time: { start: time, end: time },
      },
    }),
  )
  return true
}
