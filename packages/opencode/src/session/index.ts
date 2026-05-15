import { Slug } from "@opencode-ai/util/slug"
import fs from "fs/promises"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type ProviderMetadata } from "ai"
import { Config } from "../config/config"
import { Flag } from "../flag/flag"
import { Installation } from "../installation"

import {
  Database,
  NotFoundError,
  eq,
  and,
  or,
  ne,
  gte,
  isNull,
  isNotNull,
  desc,
  like,
  inArray,
  lt,
  asc,
} from "../storage/db"
import { SyncEvent } from "../sync"
import type { SQL } from "../storage/db"
import { SessionTable } from "./session.sql"
import { ProjectTable } from "../project/project.sql"
import { Storage } from "@/storage/storage"
import { Log } from "../util/log"
import { updateSchema } from "../util/update-schema"
import { MessageV2 } from "./message-v2"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { SessionPrompt } from "./prompt"
import { fn } from "@/util/fn"
import { Command } from "../command"
import { Snapshot } from "@/snapshot"
import { ProjectID } from "../project/schema"
import { Project } from "../project/project"
import { GlobalProjectMapTable } from "../project/global-project-map.sql"
import { WorkspaceID } from "../control-plane/schema"
import { SessionID, TreeID, MessageID, PartID } from "./schema"

import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Permission } from "@/permission"
import { Global } from "@/global"
import type { LanguageModelV2Usage } from "@ai-sdk/provider"
import { iife } from "@/util/iife"
import type { ReadingMode } from "../reading-mode/types"
import { SessionPreference } from "./preference"
import { PROJECT } from "@/persist/naming"

export namespace Session {
  const log = Log.create({ service: "session" })

  const parentTitlePrefix = "New session - "
  const childTitlePrefix = "Child session - "
  const forkTitlePattern = /^(.*) \(fork #(\d+)\)$/

  function isSubagentSession(session: Info) {
    return !!session.parentID && !session.forkParentSessionID
  }

  function createDefaultTitle(isChild = false) {
    return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
  }

  function readingModeDir(sessionID: string) {
    return path.join(Global.Path.data, "reading-mode", sessionID)
  }

  export function isDefaultTitle(title: string) {
    return new RegExp(
      `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
    ).test(title)
  }

  type SessionRow = typeof SessionTable.$inferSelect

  export function fromRow(row: SessionRow): Info {
    const summary =
      row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
        ? {
            additions: row.summary_additions ?? 0,
            deletions: row.summary_deletions ?? 0,
            files: row.summary_files ?? 0,
            diffs: row.summary_diffs ?? undefined,
          }
        : undefined
    const share = row.share_url ? { url: row.share_url } : undefined
    const revert = row.revert ?? undefined
    return {
      id: row.id,
      slug: row.slug,
      projectID: row.project_id,
      workspaceID: row.workspace_id ?? undefined,
      directory: row.directory,
      parentID: row.parent_id ?? undefined,
      treeID: row.tree_id ?? undefined,
      forkIndex: row.fork_index ?? undefined,
      forkParentSessionID: row.fork_parent_session_id ?? undefined,
      forkAfterUserMessageID: row.fork_after_user_message_id ?? undefined,
      title: row.title,
      version: row.version,
      summary,
      share,
      revert,
      permission: row.permission ?? undefined,
      readingMode: row.reading_mode
        ? {
            ...row.reading_mode,
            source: row.reading_mode.source ?? { kind: "upload" },
            firstReadDismissed: row.reading_mode.firstReadDismissed ?? false,
          }
        : undefined,
      time: {
        created: row.time_created,
        updated: row.time_updated,
        compacting: row.time_compacting ?? undefined,
        archived: row.time_archived ?? undefined,
      },
    }
  }

  export function toRow(info: Info) {
    return {
      id: info.id,
      project_id: info.projectID,
      workspace_id: info.workspaceID,
      parent_id: info.parentID,
      tree_id: info.treeID,
      fork_index: info.forkIndex,
      fork_parent_session_id: info.forkParentSessionID,
      fork_after_user_message_id: info.forkAfterUserMessageID,
      slug: info.slug,
      directory: info.directory,
      title: info.title,
      version: info.version,
      share_url: info.share?.url,
      summary_additions: info.summary?.additions,
      summary_deletions: info.summary?.deletions,
      summary_files: info.summary?.files,
      summary_diffs: info.summary?.diffs,
      revert: info.revert ?? null,
      permission: info.permission,
      reading_mode: info.readingMode ?? null,
      time_created: info.time.created,
      time_updated: info.time.updated,
      time_compacting: info.time.compacting,
      time_archived: info.time.archived,
    }
  }

  function getForkTitleBase(title: string): string {
    const match = title.match(forkTitlePattern)
    return match ? match[1] : title
  }

  function parseForkIndexFromTitle(title: string): number | undefined {
    const match = title.match(forkTitlePattern)
    if (!match) return
    const parsed = parseInt(match[2], 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  async function getNextForkIndex(input: { projectID: ProjectID; treeID: TreeID }) {
    const rows = Database.useProject(Instance.project.id, (db) =>
      db
        .select({
          forkIndex: SessionTable.fork_index,
          title: SessionTable.title,
        })
        .from(SessionTable)
        .where(and(eq(SessionTable.project_id, input.projectID), eq(SessionTable.tree_id, input.treeID)))
        .all(),
    )

    let maxForkIndex = 0
    for (const row of rows) {
      if (typeof row.forkIndex === "number") {
        maxForkIndex = Math.max(maxForkIndex, row.forkIndex)
      }
      const fromTitle = parseForkIndexFromTitle(row.title)
      if (typeof fromTitle === "number") {
        maxForkIndex = Math.max(maxForkIndex, fromTitle)
      }
    }

    return maxForkIndex + 1
  }

  function getForkedTitle(title: string, forkIndex: number): string {
    return `${getForkTitleBase(title)} (fork #${forkIndex})`
  }

  function latestSuccessfulAssistantByParent(messages: MessageV2.WithParts[]) {
    const result = new Map<MessageID, MessageV2.Assistant>()
    for (const message of messages) {
      if (message.info.role !== "assistant") continue
      if (message.info.error) continue
      if (typeof message.info.time.completed !== "number") continue
      result.set(message.info.parentID, message.info)
    }
    return result
  }

  function resolveForkAnchorUserMessageID(messages: MessageV2.WithParts[], selectedMessageID?: MessageID) {
    const successfulAssistants = latestSuccessfulAssistantByParent(messages)
    let lastCompletedUserMessageID: MessageID | undefined

    for (const message of messages) {
      if (message.info.role !== "user") continue
      if (selectedMessageID && message.info.id === selectedMessageID) {
        return lastCompletedUserMessageID
      }
      if (successfulAssistants.has(message.info.id)) {
        lastCompletedUserMessageID = message.info.id
      }
    }

    return lastCompletedUserMessageID
  }

  function collectCompletedUserMessageIDs(messages: MessageV2.WithParts[]) {
    const successfulAssistants = latestSuccessfulAssistantByParent(messages)
    const result: MessageID[] = []
    for (const message of messages) {
      if (message.info.role !== "user") continue
      if (!successfulAssistants.has(message.info.id)) continue
      result.push(message.info.id)
    }
    return result
  }

  async function resolveForkParent(input: {
    session: Pick<Info, "id" | "forkParentSessionID" | "forkAfterUserMessageID">
    messages: MessageV2.WithParts[]
    anchorUserMessageID?: MessageID
  }) {
    let resolvedSession = input.session
    let resolvedCompletedUserMessages = collectCompletedUserMessageIDs(input.messages)
    let resolvedAnchorUserMessageID = input.anchorUserMessageID

    const visited = new Set<string>([resolvedSession.id])

    while (resolvedSession.forkParentSessionID) {
      const parentSessionID = resolvedSession.forkParentSessionID
      if (visited.has(parentSessionID)) break
      visited.add(parentSessionID)

      if (!resolvedSession.forkAfterUserMessageID) break

      const parentMessages = await messages({ sessionID: parentSessionID }).catch(() => undefined)
      if (!parentMessages) break
      const parentCompletedUserMessages = collectCompletedUserMessageIDs(parentMessages)
      const sharedAnchorIndex = parentCompletedUserMessages.findIndex(
        (id) => id === resolvedSession.forkAfterUserMessageID,
      )
      if (sharedAnchorIndex < 0) break
      const sharedTurnCount = sharedAnchorIndex + 1

      const anchorIndexInCurrent =
        resolvedAnchorUserMessageID === undefined
          ? -1
          : resolvedCompletedUserMessages.findIndex((id) => id === resolvedAnchorUserMessageID)
      if (resolvedAnchorUserMessageID !== undefined && anchorIndexInCurrent < 0) break
      if (anchorIndexInCurrent >= sharedTurnCount) break

      resolvedAnchorUserMessageID =
        anchorIndexInCurrent >= 0 ? parentCompletedUserMessages[anchorIndexInCurrent] : undefined

      const parentSession = await get(parentSessionID).catch(() => undefined)
      if (!parentSession) {
        return {
          parentSessionID,
          forkAfterUserMessageID: resolvedAnchorUserMessageID,
        } as const
      }

      resolvedSession = parentSession
      resolvedCompletedUserMessages = parentCompletedUserMessages
    }

    return {
      parentSessionID: resolvedSession.id,
      forkAfterUserMessageID: resolvedAnchorUserMessageID,
    } as const
  }

  async function normalizeForkParentLink(input: {
    session: Pick<Info, "forkParentSessionID" | "forkAfterUserMessageID">
    getSession: (sessionID: SessionID) => Promise<Info | undefined>
    getCompletedUserMessages: (sessionID: SessionID) => Promise<MessageID[]>
  }) {
    let parentSessionID = input.session.forkParentSessionID
    let anchorUserMessageID = input.session.forkAfterUserMessageID

    const visited = new Set<string>()

    while (parentSessionID && anchorUserMessageID) {
      if (visited.has(parentSessionID)) break
      visited.add(parentSessionID)

      const parent = await input.getSession(parentSessionID)
      if (!parent?.forkParentSessionID || !parent.forkAfterUserMessageID) break

      const parentCompleted = await input.getCompletedUserMessages(parentSessionID)
      const sharedAnchorIndex = parentCompleted.findIndex((id) => id === parent.forkAfterUserMessageID)
      if (sharedAnchorIndex < 0) break
      const sharedTurnCount = sharedAnchorIndex + 1

      const anchorIndexInParent = parentCompleted.findIndex((id) => id === anchorUserMessageID)
      if (anchorIndexInParent < 0 || anchorIndexInParent >= sharedTurnCount) break

      const grandParentID = parent.forkParentSessionID
      const grandParentCompleted = await input.getCompletedUserMessages(grandParentID)
      parentSessionID = grandParentID
      anchorUserMessageID = grandParentCompleted[anchorIndexInParent]
    }

    return {
      parentSessionID,
      anchorUserMessageID,
    } as const
  }

  async function repairTreeForkParents(input: { projectID: ProjectID; treeID: TreeID }) {
    const rows = Database.useProject(Instance.project.id, (db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.project_id, input.projectID), eq(SessionTable.tree_id, input.treeID)))
        .orderBy(asc(SessionTable.time_created), asc(SessionTable.id))
        .all(),
    )
    if (rows.length === 0) return

    const sessions = rows.map(fromRow)
    const sessionByID = new Map(sessions.map((session) => [session.id, session] as const))
    const completedBySessionID = new Map<SessionID, MessageID[]>()

    const getSession = async (sessionID: SessionID) =>
      sessionByID.get(sessionID) ?? (await get(sessionID).catch(() => undefined))
    const getCompletedUserMessages = async (sessionID: SessionID) => {
      const cached = completedBySessionID.get(sessionID)
      if (cached) return cached
      const history = await messages({ sessionID }).catch(() => [])
      const completed = collectCompletedUserMessageIDs(history)
      completedBySessionID.set(sessionID, completed)
      return completed
    }

    for (const session of sessions) {
      if (!session.forkParentSessionID) continue

      const normalized = await normalizeForkParentLink({
        session,
        getSession,
        getCompletedUserMessages,
      })
      if (!normalized.parentSessionID) continue

      const needsParentFix =
        session.parentID !== normalized.parentSessionID || session.forkParentSessionID !== normalized.parentSessionID
      const needsAnchorFix = session.forkAfterUserMessageID !== normalized.anchorUserMessageID
      if (!needsParentFix && !needsAnchorFix) continue

      const patched: Partial<Info> = {
        parentID: normalized.parentSessionID,
        forkParentSessionID: normalized.parentSessionID,
        forkAfterUserMessageID: normalized.anchorUserMessageID,
      }
      SyncEvent.run(Event.Updated, {
        sessionID: session.id,
        info: patched,
      })
      const current = sessionByID.get(session.id)
      if (current) {
        current.parentID = patched.parentID
        current.forkParentSessionID = patched.forkParentSessionID
        current.forkAfterUserMessageID = patched.forkAfterUserMessageID
      }
    }
  }

  async function collectSessionSubtree(input: { projectID: ProjectID; rootSessionID: SessionID }) {
    const rows = Database.useProject(Instance.project.id, (db) =>
      db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.project_id, input.projectID))
        .orderBy(asc(SessionTable.time_created), asc(SessionTable.id))
        .all(),
    )

    const sessions = rows.map(fromRow)
    const sessionsByID = new Map(sessions.map((session) => [session.id, session] as const))
    const childrenByParent = new Map<SessionID, Info[]>()

    for (const session of sessions) {
      if (!session.parentID) continue
      const siblings = childrenByParent.get(session.parentID)
      if (siblings) siblings.push(session)
      else childrenByParent.set(session.parentID, [session])
    }

    const root = sessionsByID.get(input.rootSessionID)
    if (!root) throw new NotFoundError({ message: `Session not found: ${input.rootSessionID}` })

    const subtree: Info[] = []
    const queue: SessionID[] = [input.rootSessionID]
    const visited = new Set<SessionID>()

    while (queue.length > 0) {
      const sessionID = queue.shift()
      if (!sessionID || visited.has(sessionID)) continue
      visited.add(sessionID)

      const session = sessionsByID.get(sessionID)
      if (!session) continue
      subtree.push(session)

      for (const child of childrenByParent.get(sessionID) ?? []) {
        if (visited.has(child.id)) continue
        queue.push(child.id)
      }
    }

    return subtree
  }

  export const Info = z
    .object({
      id: SessionID.zod,
      slug: z.string(),
      projectID: ProjectID.zod,
      workspaceID: WorkspaceID.zod.optional(),
      directory: z.string(),
      parentID: SessionID.zod.optional(),
      treeID: TreeID.zod.optional(),
      forkIndex: z.number().int().positive().optional(),
      forkParentSessionID: SessionID.zod.optional(),
      forkAfterUserMessageID: MessageID.zod.optional(),
      summary: z
        .object({
          additions: z.number(),
          deletions: z.number(),
          files: z.number(),
          diffs: Snapshot.FileDiff.array().optional(),
        })
        .optional(),
      share: z
        .object({
          url: z.string(),
        })
        .optional(),
      title: z.string(),
      version: z.string(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
      }),
      permission: Permission.Ruleset.optional(),
      revert: z
        .object({
          messageID: MessageID.zod,
          partID: PartID.zod.optional(),
          snapshot: z.string().optional(),
          diff: z.string().optional(),
        })
        .optional(),
      readingMode: z
        .object({
          pdfFileName: z.string(),
          pdfStorePath: z.string(),
          lastReadPage: z.number(),
          annotationsPath: z.string(),
          source: z.object({
            kind: z.union([z.literal("workspace-file"), z.literal("upload")]),
            path: z.string().optional(),
          }),
          settings: z.object({
            translatePrompt: z.string(),
            questionPrompt: z.string(),
            firstReadPrompt: z.string(),
            contextPageRange: z.union([z.literal(0), z.literal(1), z.literal(2)]),
            autoFirstRead: z.boolean(),
          }),
          firstReadCompleted: z.boolean(),
          firstReadDismissed: z.boolean(),
        })
        .optional(),
    })
    .meta({
      ref: "Session",
    })
  export type Info = z.output<typeof Info>

  export const TreeResult = z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("tree"),
        treeID: TreeID.zod,
        sessions: Info.array(),
      }),
      z.object({
        kind: z.literal("legacy"),
        message: z.string(),
      }),
    ])
    .meta({
      ref: "SessionTreeResult",
    })
  export type TreeResult = z.output<typeof TreeResult>

  export const GraphNode = z
    .object({
      id: z.string(),
      kind: z.union([z.literal("turn"), z.literal("bud")]),
      sessionID: SessionID.zod,
      lane: z.number().int().min(0),
      row: z.number().int().min(0),
      time: z.number(),
      label: z.string(),
      userMessageID: MessageID.zod.optional(),
      providerID: ProviderID.zod.optional(),
      modelID: ModelID.zod.optional(),
      mode: z.string().optional(),
      origin: z.union([z.literal("tree"), z.literal("external")]),
    })
    .meta({
      ref: "SessionGraphNode",
    })
  export type GraphNode = z.output<typeof GraphNode>

  export const GraphEdge = z
    .object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      kind: z.union([z.literal("continuation"), z.literal("branch"), z.literal("bud")]),
      style: z.union([z.literal("solid"), z.literal("dashed")]),
    })
    .meta({
      ref: "SessionGraphEdge",
    })
  export type GraphEdge = z.output<typeof GraphEdge>

  export const GraphCurrent = z
    .object({
      sessionID: SessionID.zod,
      pathNodeIDs: z.string().array(),
      latestNodeID: z.string().optional(),
      targetNodeID: z.string().optional(),
    })
    .meta({
      ref: "SessionGraphCurrent",
    })
  export type GraphCurrent = z.output<typeof GraphCurrent>

  export const GraphResult = z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("graph"),
        treeID: TreeID.zod,
        current: GraphCurrent,
        nodes: GraphNode.array(),
        edges: GraphEdge.array(),
      }),
      z.object({
        kind: z.literal("legacy"),
        message: z.string(),
      }),
    ])
    .meta({
      ref: "SessionGraphResult",
    })
  export type GraphResult = z.output<typeof GraphResult>

  export const ProjectInfo = z
    .object({
      id: ProjectID.zod,
      name: z.string().optional(),
      worktree: z.string(),
    })
    .meta({
      ref: "ProjectSummary",
    })
  export type ProjectInfo = z.output<typeof ProjectInfo>

  export const GlobalInfo = Info.extend({
    project: ProjectInfo.nullable(),
  }).meta({
    ref: "GlobalSession",
  })
  export type GlobalInfo = z.output<typeof GlobalInfo>

  export const Event = {
    Created: SyncEvent.define({
      type: "session.created",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        info: Info,
      }),
    }),
    Updated: SyncEvent.define({
      type: "session.updated",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        info: updateSchema(Info).extend({
          share: updateSchema(Info.shape.share.unwrap()).optional(),
          time: updateSchema(Info.shape.time).optional(),
        }),
      }),
      busSchema: z.object({
        sessionID: SessionID.zod,
        info: Info,
      }),
    }),
    Deleted: SyncEvent.define({
      type: "session.deleted",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        info: Info,
      }),
    }),
    Diff: BusEvent.define(
      "session.diff",
      z.object({
        sessionID: SessionID.zod,
        diff: Snapshot.FileDiff.array(),
      }),
    ),
    Error: BusEvent.define(
      "session.error",
      z.object({
        sessionID: SessionID.zod.optional(),
        error: MessageV2.Assistant.shape.error,
      }),
    ),
    PreferenceUpdated: SessionPreference.PreferenceUpdated,
  }

  export const create = fn(
    z
      .object({
        parentID: SessionID.zod.optional(),
        title: z.string().optional(),
        permission: Info.shape.permission,
        workspaceID: WorkspaceID.zod.optional(),
      })
      .optional(),
    async (input) => {
      return createNext({
        parentID: input?.parentID,
        directory: Instance.directory,
        title: input?.title,
        permission: input?.permission,
        workspaceID: input?.workspaceID,
      })
    },
  )

  export const fork = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod.optional(),
    }),
    async (input) => {
      const original = await get(input.sessionID)
      if (!original) throw new Error("session not found")
      if (original.treeID) {
        await repairTreeForkParents({
          projectID: original.projectID,
          treeID: original.treeID,
        })
      }
      const source = (await get(input.sessionID).catch(() => undefined)) ?? original
      const targetTreeID = source.treeID ?? TreeID.descending()
      const forkIndex = await getNextForkIndex({
        projectID: source.projectID,
        treeID: targetTreeID,
      })
      const title = getForkedTitle(source.title, forkIndex)
      const msgs = await messages({ sessionID: input.sessionID })
      const forkAnchorUserMessageID = resolveForkAnchorUserMessageID(msgs, input.messageID)
      const resolvedForkParent = await resolveForkParent({
        session: source,
        messages: msgs,
        anchorUserMessageID: forkAnchorUserMessageID,
      })
      const session = await createNext({
        directory: Instance.directory,
        workspaceID: source.workspaceID,
        parentID: resolvedForkParent.parentSessionID,
        treeID: targetTreeID,
        forkIndex,
        forkParentSessionID: resolvedForkParent.parentSessionID,
        forkAfterUserMessageID: resolvedForkParent.forkAfterUserMessageID,
        title,
      })
      const pref = SessionPreference.get(input.sessionID)
      if (pref) {
        const { sessionID: _, ...prefData } = pref
        await SessionPreference.update({ sessionID: session.id, ...prefData })
      }
      const idMap = new Map<string, MessageID>()
      const copyIDs = new Set<string>()
      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        copyIDs.add(msg.info.id)
      }
      const completedCompactionTriggers = new Set<string>()
      for (const msg of msgs) {
        if (!copyIDs.has(msg.info.id)) continue
        if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
          completedCompactionTriggers.add(msg.info.parentID)
      }
      const orphanedCompactionTriggers = new Set<string>()
      for (const msg of msgs) {
        if (!copyIDs.has(msg.info.id)) continue
        if (
          msg.info.role === "user" &&
          msg.parts.some((part) => part.type === "compaction") &&
          !completedCompactionTriggers.has(msg.info.id)
        )
          orphanedCompactionTriggers.add(msg.info.id)
      }

      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        if (orphanedCompactionTriggers.has(msg.info.id)) continue
        const newID = MessageID.ascending()
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const cloned = await updateMessage({
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          const next =
            part.type === "tool" && part.state.status === "completed" && part.state.time.compacted
              ? (() => {
                  const time = { ...part.state.time }
                  delete time.compacted
                  return { ...part, state: { ...part.state, time } }
                })()
              : part
          await updatePart({
            ...next,
            id: PartID.ascending(),
            messageID: cloned.id,
            sessionID: session.id,
          })
        }
      }
      return session
    },
  )

  export const touch = fn(SessionID.zod, async (sessionID) => {
    const time = Date.now()
    SyncEvent.run(Event.Updated, { sessionID, info: { time: { updated: time } } })
  })

  export async function createNext(input: {
    id?: SessionID
    title?: string
    parentID?: SessionID
    treeID?: TreeID
    forkIndex?: number
    forkParentSessionID?: SessionID
    forkAfterUserMessageID?: MessageID
    workspaceID?: WorkspaceID
    directory: string
    permission?: Permission.Ruleset
  }) {
    const treeID = await (async () => {
      if (input.treeID) return input.treeID
      if (!input.parentID) return TreeID.descending()
      const parent = await get(input.parentID)
      return parent.treeID ?? TreeID.descending()
    })()

    const result: Info = {
      id: SessionID.descending(input.id),
      slug: Slug.create(),
      version: Installation.VERSION,
      projectID: Instance.project.id,
      directory: input.directory,
      workspaceID: input.workspaceID,
      parentID: input.parentID,
      treeID,
      forkIndex: input.forkIndex,
      forkParentSessionID: input.forkParentSessionID,
      forkAfterUserMessageID: input.forkAfterUserMessageID,
      title: input.title ?? createDefaultTitle(!!input.parentID),
      permission: input.permission,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    }
    log.info("created", result)

    // Ensure project db exists and has the project row before writing session data
    const project = Instance.project
    if (!Database.hasProject(project.id)) {
      Database.attach(project.id)
    }
    Database.useProject(project.id, (d) =>
      d
        .insert(ProjectTable)
        .values({
          id: project.id,
          worktree: project.worktree,
          vcs: project.vcs ?? null,
          name: project.name ?? null,
          icon_url: project.icon?.url ?? null,
          icon_color: project.icon?.color ?? null,
          time_created: project.time.created,
          time_updated: project.time.updated,
          time_initialized: project.time.initialized ?? null,
          sandboxes: project.sandboxes ?? [],
          commands: project.commands ?? null,
        })
        .onConflictDoUpdate({
          target: ProjectTable.id,
          set: {
            worktree: project.worktree,
            vcs: project.vcs ?? null,
            name: project.name ?? null,
            time_updated: project.time.updated,
            sandboxes: project.sandboxes ?? [],
            commands: project.commands ?? null,
          },
        })
        .run(),
    )

    SyncEvent.run(Event.Created, { sessionID: result.id, info: result })

    const cfg = await Config.get()
    if (!result.parentID && (Flag.OPENCODE_AUTO_SHARE || cfg.share === "auto")) {
      share(result.id).catch(() => {
        // Silently ignore sharing errors during session creation
      })
    }

    if (!Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
      // This only exist for backwards compatibility. We should not be
      // manually publishing this event; it is a sync event now
      Bus.publish(Event.Updated, {
        sessionID: result.id,
        info: result,
      })
    }

    // Record a baseline snapshot so that human edits made before any AI
    // processing are captured by the review panel diff.
    const baseline = await Snapshot.track().catch(() => undefined)
    if (baseline) await Storage.write(["session_diff_from", result.id], baseline).catch(() => {})
    return result
  }

  export function plan(input: { slug: string; time: { created: number } }) {
    const base = Instance.project.vcs
      ? path.join(Instance.worktree, PROJECT, "plans")
      : path.join(Global.Path.data, "plans")
    return path.join(base, [input.time.created, input.slug].join("-") + ".md")
  }

  export const get = fn(SessionID.zod, async (id) => {
    const row = Database.useProject(Instance.project.id, (db) =>
      db.select().from(SessionTable).where(eq(SessionTable.id, id)).get(),
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
    return fromRow(row)
  })

  export const share = fn(SessionID.zod, async (id) => {
    const cfg = await Config.get()
    if (cfg.share === "disabled") {
      throw new Error("Sharing is disabled in configuration")
    }
    const { ShareNext } = await import("@/share/share-next")
    const share = await ShareNext.create(id)

    SyncEvent.run(Event.Updated, { sessionID: id, info: { share: { url: share.url } } })

    return share
  })

  export const unshare = fn(SessionID.zod, async (id) => {
    // Use ShareNext to remove the share (same as share function uses ShareNext to create)
    const { ShareNext } = await import("@/share/share-next")
    await ShareNext.remove(id)

    SyncEvent.run(Event.Updated, { sessionID: id, info: { share: { url: null } } })
  })

  export const setTitle = fn(
    z.object({
      sessionID: SessionID.zod,
      title: z.string(),
    }),
    async (input) => {
      SyncEvent.run(Event.Updated, { sessionID: input.sessionID, info: { title: input.title } })
    },
  )

  export const setArchived = fn(
    z.object({
      sessionID: SessionID.zod,
      time: z.number().optional(),
    }),
    async (input) => {
      const archived = typeof input.time === "number" && input.time <= 0 ? null : input.time
      SyncEvent.run(Event.Updated, { sessionID: input.sessionID, info: { time: { archived } } })
    },
  )

  export const archive = fn(SessionID.zod, async (sessionID) => {
    const session = await get(sessionID)
    const archivedAt = Date.now()
    const subtree = await collectSessionSubtree({
      projectID: session.projectID,
      rootSessionID: sessionID,
    })

    if (!session.parentID) {
      for (const item of subtree) {
        SyncEvent.run(Event.Updated, {
          sessionID: item.id,
          info: {
            time: {
              archived: archivedAt,
              updated: archivedAt,
            },
          },
        })
      }
      return get(sessionID)
    }

    const subtreeIDs = new Set(subtree.map((item) => item.id))
    const detachedTreeID = TreeID.descending()

    for (const item of subtree) {
      const patch = {
        treeID: detachedTreeID,
        time: {
          archived: archivedAt,
          updated: archivedAt,
        },
      } as any

      if (item.id === sessionID) {
        patch.parentID = null
        patch.forkParentSessionID = null
        patch.forkAfterUserMessageID = null
      } else if (item.forkParentSessionID && !subtreeIDs.has(item.forkParentSessionID)) {
        patch.forkParentSessionID = null
        patch.forkAfterUserMessageID = null
      }

      SyncEvent.run(Event.Updated, {
        sessionID: item.id,
        info: patch,
      })
    }

    return get(sessionID)
  })

  export const unarchive = fn(SessionID.zod, async (sessionID) => {
    const session = await get(sessionID)
    if (session.parentID) {
      throw new Error("Only archived subtree roots can be unarchived")
    }

    const updatedAt = Date.now()
    const subtree = await collectSessionSubtree({
      projectID: session.projectID,
      rootSessionID: sessionID,
    })

    for (const item of subtree) {
      SyncEvent.run(Event.Updated, {
        sessionID: item.id,
        info: {
          time: {
            archived: null,
            updated: updatedAt,
          },
        },
      })
    }

    return get(sessionID)
  })

  export const setPermission = fn(
    z.object({
      sessionID: SessionID.zod,
      permission: Permission.Ruleset,
    }),
    async (input) => {
      SyncEvent.run(Event.Updated, {
        sessionID: input.sessionID,
        info: { permission: input.permission, time: { updated: Date.now() } },
      })
    },
  )

  export const setRevert = fn(
    z.object({
      sessionID: SessionID.zod,
      revert: Info.shape.revert,
      summary: Info.shape.summary,
    }),
    async (input) => {
      SyncEvent.run(Event.Updated, {
        sessionID: input.sessionID,
        info: {
          summary: input.summary,
          time: { updated: Date.now() },
          revert: input.revert,
        },
      })
    },
  )

  export const clearRevert = fn(SessionID.zod, async (sessionID) => {
    SyncEvent.run(Event.Updated, {
      sessionID,
      info: {
        time: { updated: Date.now() },
        revert: null,
      },
    })
  })

  export const setReadingMode = fn(
    z.object({
      sessionID: SessionID.zod,
      readingMode: Info.shape.readingMode,
    }),
    async (input) => {
      SyncEvent.run(Event.Updated, {
        sessionID: input.sessionID,
        info: {
          readingMode: input.readingMode,
          time: { updated: Date.now() },
        },
      })
    },
  )

  export const setSummary = fn(
    z.object({
      sessionID: SessionID.zod,
      summary: Info.shape.summary,
    }),
    async (input) => {
      SyncEvent.run(Event.Updated, {
        sessionID: input.sessionID,
        info: {
          time: { updated: Date.now() },
          summary: input.summary,
        },
      })
    },
  )

  export const diff = fn(SessionID.zod, async (sessionID) => {
    try {
      return await Storage.read<Snapshot.FileDiff[]>(["session_diff", sessionID])
    } catch {
      return []
    }
  })

  export const messages = fn(
    z.object({
      sessionID: SessionID.zod,
      limit: z.number().optional(),
    }),
    async (input) => {
      const result = [] as MessageV2.WithParts[]
      for await (const msg of MessageV2.stream(input.sessionID)) {
        if (input.limit && result.length >= input.limit) break
        result.push(msg)
      }
      result.reverse()
      return result
    },
  )

  export function* list(input?: {
    directory?: string
    workspaceID?: WorkspaceID
    roots?: boolean
    start?: number
    search?: string
    limit?: number
  }) {
    const limit = input?.limit ?? 100
    let projectID: ProjectID = Instance.project.id
    if (input?.directory) {
      const dir = Project.norm(input.directory)
      const row = Database.use((d) =>
        d.select().from(GlobalProjectMapTable).where(eq(GlobalProjectMapTable.directory, dir)).get(),
      )
      if (row) projectID = row.project_id as ProjectID
    }
    const conditions = [eq(SessionTable.project_id, projectID)]
    if (input?.directory) {
      conditions.push(eq(SessionTable.directory, Filesystem.resolve(input.directory)))
    }
    if (input?.roots) {
      conditions.push(isNull(SessionTable.parent_id))
    }
    if (input?.start) {
      conditions.push(gte(SessionTable.time_updated, input.start))
    }
    if (input?.search) {
      conditions.push(like(SessionTable.title, `%${input.search}%`))
    }
    const rows = Database.useProject(projectID, (db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(...conditions))
        .orderBy(desc(SessionTable.time_updated))
        .limit(limit)
        .all(),
    )
    for (const row of rows) {
      yield fromRow(row)
    }
  }

  export function* listGlobal(input?: {
    directory?: string
    roots?: boolean
    start?: number
    cursor?: number
    search?: string
    limit?: number
    archivedMode?: "exclude" | "include" | "only"
    archived?: boolean
  }) {
    const conditions: SQL[] = []
    const archivedMode = input?.archivedMode ?? (input?.archived === true ? ("include" as const) : ("exclude" as const))

    if (input?.directory) {
      conditions.push(eq(SessionTable.directory, Filesystem.resolve(input.directory)))
    }
    if (input?.roots) {
      conditions.push(isNull(SessionTable.parent_id))
    }
    if (input?.start) {
      conditions.push(gte(SessionTable.time_updated, input.start))
    }
    if (input?.cursor) {
      conditions.push(lt(SessionTable.time_updated, input.cursor))
    }
    if (input?.search) {
      conditions.push(like(SessionTable.title, `%${input.search}%`))
    }
    if (archivedMode === "exclude") {
      conditions.push(or(isNull(SessionTable.time_archived), eq(SessionTable.time_archived, 0))!)
    } else if (archivedMode === "only") {
      conditions.push(and(isNotNull(SessionTable.time_archived), ne(SessionTable.time_archived, 0))!)
    }

    const limit = input?.limit ?? 100

    const hexPattern = /^aether-([0-9a-f]+)\.db$/

    const allSessions: (typeof SessionTable.$inferSelect)[] = []
    for (const pPath of Database.projectPaths()) {
      const fileName = path.basename(pPath)
      const match = hexPattern.exec(fileName)
      if (!match) continue
      const pid = match[1]
      const rows = Database.useProject(pid, (db) =>
        conditions.length > 0
          ? db
              .select()
              .from(SessionTable)
              .where(and(...conditions))
              .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
              .limit(limit)
              .all()
          : db
              .select()
              .from(SessionTable)
              .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
              .limit(limit)
              .all(),
      )
      allSessions.push(...rows)
    }
    allSessions.sort((a, b) => b.time_updated - a.time_updated || b.id.localeCompare(a.id))
    const rows = allSessions.slice(0, limit)

    const ids = [...new Set(rows.map((row) => row.project_id))]
    const projects = new Map<string, ProjectInfo>()

    for (const pid of ids) {
      const projectRow = Database.useProject(pid, (db) =>
        db.select().from(ProjectTable).where(eq(ProjectTable.id, pid)).get(),
      )
      if (projectRow) {
        projects.set(pid, {
          id: projectRow.id,
          name: projectRow.name ?? undefined,
          worktree: projectRow.worktree,
        })
      }
    }

    for (const row of rows) {
      const project = projects.get(row.project_id) ?? null
      yield { ...fromRow(row), project }
    }
  }

  export const children = fn(SessionID.zod, async (parentID) => {
    const project = Instance.project
    const rows = Database.useProject(project.id, (db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.project_id, project.id), eq(SessionTable.parent_id, parentID)))
        .all(),
    )
    return rows.map(fromRow).filter((s) => !isSubagentSession(s))
  })

  export const tree = fn(SessionID.zod, async (sessionID): Promise<TreeResult> => {
    const session = await get(sessionID)
    if (!session.treeID) {
      return {
        kind: "legacy",
        message: "This session predates the branch tree system and does not expose a branch tree.",
      }
    }
    await repairTreeForkParents({
      projectID: session.projectID,
      treeID: session.treeID,
    })
    const treeID = session.treeID

    const rows = Database.useProject(session.projectID, (db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.project_id, session.projectID), eq(SessionTable.tree_id, treeID)))
        .orderBy(asc(SessionTable.time_created), asc(SessionTable.id))
        .all(),
    )

    return {
      kind: "tree",
      treeID,
      sessions: rows.map(fromRow).filter((s) => !isSubagentSession(s)),
    }
  })

  type CompletedTurn = {
    sessionID: SessionID
    userMessageID: MessageID
    time: number
    label: string
    providerID?: ProviderID
    modelID?: ModelID
    mode?: string
  }

  function extractUserLabel(message: MessageV2.WithParts) {
    const text = message.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")
      .trim()
    return text || "(no text)"
  }

  function collectCompletedTurns(messages: MessageV2.WithParts[]): CompletedTurn[] {
    const assistantsByParent = new Map<MessageID, MessageV2.Assistant>()
    for (const message of messages) {
      if (message.info.role !== "assistant") continue
      if (message.info.error) continue
      if (typeof message.info.time.completed !== "number") continue
      assistantsByParent.set(message.info.parentID, message.info)
    }

    const result: CompletedTurn[] = []
    for (const message of messages) {
      if (message.info.role !== "user") continue
      const assistant = assistantsByParent.get(message.info.id)
      if (!assistant) continue
      result.push({
        sessionID: message.info.sessionID,
        userMessageID: message.info.id,
        time: message.info.time.created,
        label: extractUserLabel(message),
        providerID: assistant.providerID,
        modelID: assistant.modelID,
        mode: assistant.mode,
      })
    }
    return result
  }

  function turnKey(sessionID: SessionID, userMessageID: MessageID) {
    return `${sessionID}:${userMessageID}`
  }

  function turnNodeID(sessionID: SessionID, userMessageID: MessageID) {
    return `turn:${sessionID}:${userMessageID}`
  }

  function budNodeID(sessionID: SessionID) {
    return `bud:${sessionID}`
  }

  export const graph = fn(SessionID.zod, async (sessionID): Promise<GraphResult> => {
    const currentSession = await get(sessionID)
    if (!currentSession.treeID) {
      return {
        kind: "legacy",
        message: "This session predates the conversation graph system and does not expose a graph.",
      }
    }
    await repairTreeForkParents({
      projectID: currentSession.projectID,
      treeID: currentSession.treeID,
    })
    const treeID = currentSession.treeID

    const allTreeSessions = Database.useProject(currentSession.projectID, (db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.project_id, currentSession.projectID), eq(SessionTable.tree_id, treeID)))
        .orderBy(asc(SessionTable.time_created), asc(SessionTable.id))
        .all()
        .map(fromRow),
    )

    const treeSessions = allTreeSessions.filter((s) => !isSubagentSession(s))

    const treeSessionIDs = new Set(treeSessions.map((session) => session.id))
    const sessionsByID = new Map(treeSessions.map((session) => [session.id, session] as const))
    const externalSessions = new Map<SessionID, Info>()

    for (const session of treeSessions) {
      const parentID = session.forkParentSessionID
      if (!parentID || treeSessionIDs.has(parentID) || externalSessions.has(parentID)) continue
      try {
        externalSessions.set(parentID, await get(parentID))
      } catch {
        // Ignore missing external parents. The graph will degrade to the child path only.
      }
    }

    const messagesBySession = new Map<SessionID, MessageV2.WithParts[]>()
    const turnsBySession = new Map<SessionID, CompletedTurn[]>()

    const loadTurns = async (targetSessionID: SessionID) => {
      if (turnsBySession.has(targetSessionID)) return turnsBySession.get(targetSessionID)!
      const history = await messages({ sessionID: targetSessionID })
      messagesBySession.set(targetSessionID, history)
      const turns = collectCompletedTurns(history)
      turnsBySession.set(targetSessionID, turns)
      return turns
    }

    await Promise.all([...treeSessionIDs].map(loadTurns))
    await Promise.all([...externalSessions.keys()].map(loadTurns))

    const childrenByParent = new Map<SessionID, Info[]>()
    for (const session of treeSessions) {
      const parentID = session.forkParentSessionID
      if (!parentID || !treeSessionIDs.has(parentID)) continue
      const siblings = childrenByParent.get(parentID)
      if (siblings) siblings.push(session)
      else childrenByParent.set(parentID, [session])
    }
    for (const [parentID, siblings] of childrenByParent) {
      siblings.sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
      childrenByParent.set(parentID, siblings)
    }

    const laneBySessionID = new Map<SessionID, number>()
    let nextLane = 0
    const rootLikeSessions = treeSessions.filter(
      (session) => !session.forkParentSessionID || !treeSessionIDs.has(session.forkParentSessionID),
    )
    const assignLane = (targetSessionID: SessionID) => {
      if (!laneBySessionID.has(targetSessionID)) {
        laneBySessionID.set(targetSessionID, nextLane++)
      }
      for (const child of childrenByParent.get(targetSessionID) ?? []) {
        assignLane(child.id)
      }
    }
    for (const session of rootLikeSessions) assignLane(session.id)

    const nodes = new Map<string, GraphNode>()
    const edges = new Map<string, GraphEdge>()
    const pathBySessionID = new Map<SessionID, string[]>()
    const nodeByTurnKey = new Map<string, string>()
    const turnByNodeID = new Map<string, CompletedTurn>()
    const externalPrefixCache = new Map<string, string[]>()

    const upsertNode = (node: Omit<GraphNode, "row">) => {
      const existing = nodes.get(node.id)
      if (existing) return existing
      const next: GraphNode = { ...node, row: -1 }
      nodes.set(node.id, next)
      return next
    }

    const upsertEdge = (edge: GraphEdge) => {
      if (!edges.has(edge.id)) edges.set(edge.id, edge)
    }

    const compareTurnsForEdge = (fromNodeID: string | undefined, nextTurn: CompletedTurn) => {
      if (!fromNodeID) return "solid" as const
      const previousTurn = turnByNodeID.get(fromNodeID)
      if (!previousTurn?.providerID || !previousTurn.modelID || !nextTurn.providerID || !nextTurn.modelID) {
        return "solid" as const
      }
      return previousTurn.providerID === nextTurn.providerID && previousTurn.modelID === nextTurn.modelID
        ? ("solid" as const)
        : ("dashed" as const)
    }

    const materializeExternalPrefix = async (parentSessionID: SessionID, lane: number, count: number) => {
      const cacheKey = `${parentSessionID}:${lane}:${count}`
      const cached = externalPrefixCache.get(cacheKey)
      if (cached) return cached

      const turns = (await loadTurns(parentSessionID)).slice(0, count)
      const result: string[] = []

      for (const turn of turns) {
        const nodeID = turnNodeID(turn.sessionID, turn.userMessageID)
        upsertNode({
          id: nodeID,
          kind: "turn",
          sessionID: turn.sessionID,
          userMessageID: turn.userMessageID,
          lane,
          time: turn.time,
          label: turn.label,
          providerID: turn.providerID,
          modelID: turn.modelID,
          mode: turn.mode,
          origin: "external",
        })
        nodeByTurnKey.set(turnKey(turn.sessionID, turn.userMessageID), nodeID)
        turnByNodeID.set(nodeID, turn)

        const previous = result.at(-1)
        if (previous) {
          upsertEdge({
            id: `${previous}->${nodeID}`,
            from: previous,
            to: nodeID,
            kind: "continuation",
            style: compareTurnsForEdge(previous, turn),
          })
        }
        result.push(nodeID)
      }

      externalPrefixCache.set(cacheKey, result)
      return result
    }

    const materializeSession = async (targetSessionID: SessionID): Promise<string[]> => {
      const existing = pathBySessionID.get(targetSessionID)
      if (existing) return existing

      const session = sessionsByID.get(targetSessionID)
      if (!session) return []

      const lane = laneBySessionID.get(targetSessionID) ?? 0
      const turns = await loadTurns(targetSessionID)

      let prefixNodeIDs: string[] = []
      let anchorNodeID: string | undefined
      let sharedTurnCount = 0

      if (session.forkParentSessionID) {
        if (treeSessionIDs.has(session.forkParentSessionID)) {
          const parentPath = await materializeSession(session.forkParentSessionID)
          const parentTurns = await loadTurns(session.forkParentSessionID)
          const anchorIndex = session.forkAfterUserMessageID
            ? parentTurns.findIndex((turn) => turn.userMessageID === session.forkAfterUserMessageID)
            : -1
          sharedTurnCount = anchorIndex >= 0 ? anchorIndex + 1 : 0
          prefixNodeIDs = parentPath.slice(0, sharedTurnCount)
          anchorNodeID = prefixNodeIDs.at(-1)
        } else {
          const parentTurns = await loadTurns(session.forkParentSessionID)
          const anchorIndex = session.forkAfterUserMessageID
            ? parentTurns.findIndex((turn) => turn.userMessageID === session.forkAfterUserMessageID)
            : -1
          sharedTurnCount = anchorIndex >= 0 ? anchorIndex + 1 : 0
          prefixNodeIDs = await materializeExternalPrefix(session.forkParentSessionID, lane, sharedTurnCount)
          anchorNodeID = prefixNodeIDs.at(-1)
        }
      }

      const ownTurns = turns.slice(sharedTurnCount)
      const ownNodeIDs: string[] = []
      let previousNodeID = anchorNodeID

      for (const turn of ownTurns) {
        const nodeID = turnNodeID(turn.sessionID, turn.userMessageID)
        upsertNode({
          id: nodeID,
          kind: "turn",
          sessionID: turn.sessionID,
          userMessageID: turn.userMessageID,
          lane,
          time: turn.time,
          label: turn.label,
          providerID: turn.providerID,
          modelID: turn.modelID,
          mode: turn.mode,
          origin: "tree",
        })
        nodeByTurnKey.set(turnKey(turn.sessionID, turn.userMessageID), nodeID)
        turnByNodeID.set(nodeID, turn)

        if (previousNodeID) {
          upsertEdge({
            id: `${previousNodeID}->${nodeID}`,
            from: previousNodeID,
            to: nodeID,
            kind: previousNodeID === anchorNodeID && !!session.forkParentSessionID ? "branch" : "continuation",
            style: compareTurnsForEdge(previousNodeID, turn),
          })
        }

        ownNodeIDs.push(nodeID)
        previousNodeID = nodeID
      }

      const path =
        session.forkParentSessionID && ownNodeIDs.length === 0
          ? (() => {
              if (!anchorNodeID) return prefixNodeIDs
              const budID = budNodeID(targetSessionID)
              const node = upsertNode({
                id: budID,
                kind: "bud",
                sessionID: targetSessionID,
                lane,
                time: session.time.created,
                label: "",
                origin: "tree",
              })
              upsertEdge({
                id: `${anchorNodeID}->${budID}`,
                from: anchorNodeID,
                to: budID,
                kind: "bud",
                style: "solid",
              })
              return [...prefixNodeIDs, node.id]
            })()
          : [...prefixNodeIDs, ...ownNodeIDs]

      pathBySessionID.set(targetSessionID, path)
      return path
    }

    for (const session of rootLikeSessions) {
      await materializeSession(session.id)
    }
    for (const session of treeSessions) {
      await materializeSession(session.id)
    }

    const sortedNodes = [...nodes.values()].sort((a, b) => {
      if (a.time !== b.time) return a.time - b.time
      if (a.lane !== b.lane) return a.lane - b.lane
      return a.id.localeCompare(b.id)
    })
    sortedNodes.forEach((node, index) => {
      node.row = index
    })

    const currentPathNodeIDs = pathBySessionID.get(currentSession.id) ?? []
    const currentTargetNodeID = currentPathNodeIDs.at(-1)
    const currentLatestNodeID =
      currentTargetNodeID && nodes.get(currentTargetNodeID)?.kind === "turn" ? currentTargetNodeID : undefined

    return {
      kind: "graph",
      treeID,
      current: {
        sessionID: currentSession.id,
        pathNodeIDs: currentPathNodeIDs,
        latestNodeID: currentLatestNodeID,
        targetNodeID: currentTargetNodeID,
      },
      nodes: sortedNodes,
      edges: [...edges.values()],
    }
  })

  export const remove = fn(SessionID.zod, async (sessionID) => {
    try {
      const session = await get(sessionID)
      for (const child of await children(sessionID)) {
        await remove(child.id)
      }

      if (session.readingMode) {
        const dir = readingModeDir(sessionID)
        await fs.rm(dir, { recursive: true, force: true }).catch((error) => {
          log.error("failed to remove reading mode session directory", {
            sessionID,
            dir,
            error,
          })
        })
      }

      await unshare(sessionID).catch(() => {})

      SyncEvent.run(Event.Deleted, { sessionID, info: session })

      // Eagerly remove event sourcing data to free up space
      SyncEvent.remove(sessionID)
    } catch (e) {
      log.error(e)
    }
  })

  export const updateMessage = fn(MessageV2.Info, async (msg) => {
    SyncEvent.run(MessageV2.Event.Updated, {
      sessionID: msg.sessionID,
      info: msg,
    })

    return msg
  })

  export const removeMessage = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
    }),
    async (input) => {
      SyncEvent.run(MessageV2.Event.Removed, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    },
  )

  export const removePart = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
    }),
    async (input) => {
      SyncEvent.run(MessageV2.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    },
  )

  const UpdatePartInput = MessageV2.Part

  export const updatePart = fn(UpdatePartInput, async (part) => {
    SyncEvent.run(MessageV2.Event.PartUpdated, {
      sessionID: part.sessionID,
      part: structuredClone(part),
      time: Date.now(),
    })
    return part
  })

  export const updatePartDelta = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
      field: z.string(),
      delta: z.string(),
    }),
    async (input) => {
      Bus.publish(MessageV2.Event.PartDelta, input)
    },
  )

  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      usage: z.custom<LanguageModelV2Usage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const safe = (value: number) => {
        if (!Number.isFinite(value)) return 0
        return value
      }
      const inputTokens = safe(input.usage.inputTokens ?? 0)
      const outputTokens = safe(input.usage.outputTokens ?? 0)
      const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

      const cacheReadInputTokens = safe(input.usage.cachedInputTokens ?? 0)
      const cacheWriteInputTokens = safe(
        (input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
          // @ts-expect-error
          input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
          // @ts-expect-error
          input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
          0) as number,
      )

      // OpenRouter provides inputTokens as the total count of input tokens (including cached).
      // AFAIK other providers (OpenRouter/OpenAI/Gemini etc.) do it the same way e.g. vercel/ai#8794 (comment)
      // Anthropic does it differently though - inputTokens doesn't include cached tokens.
      // It looks like OpenCode's cost calculation assumes all providers return inputTokens the same way Anthropic does (I'm guessing getUsage logic was originally implemented with anthropic), so it's causing incorrect cost calculation for OpenRouter and others.
      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const adjustedInputTokens = safe(
        excludesCachedTokens ? inputTokens : inputTokens - cacheReadInputTokens - cacheWriteInputTokens,
      )

      const total = iife(() => {
        // Anthropic doesn't provide total_tokens, also ai sdk will vastly undercount if we
        // don't compute from components
        if (
          input.model.api.npm === "@ai-sdk/anthropic" ||
          input.model.api.npm === "@ai-sdk/amazon-bedrock" ||
          input.model.api.npm === "@ai-sdk/google-vertex/anthropic"
        ) {
          return adjustedInputTokens + outputTokens + cacheReadInputTokens + cacheWriteInputTokens
        }
        return input.usage.totalTokens
      })

      const tokens = {
        total,
        input: adjustedInputTokens,
        output: outputTokens,
        reasoning: reasoningTokens,
        cache: {
          write: cacheWriteInputTokens,
          read: cacheReadInputTokens,
        },
      }

      const costInfo =
        input.model.cost?.experimentalOver200K && tokens.input + tokens.cache.read > 200_000
          ? input.model.cost.experimentalOver200K
          : input.model.cost
      return {
        cost: safe(
          new Decimal(0)
            .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
            .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
            // TODO: update models.dev to have better pricing model, for now:
            // charge reasoning tokens at the same rate as output tokens
            .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
            .toNumber(),
        ),
        tokens,
      }
    },
  )

  export class BusyError extends Error {
    constructor(public readonly sessionID: string) {
      super(`Session ${sessionID} is busy`)
    }
  }

  export const initialize = fn(
    z.object({
      sessionID: SessionID.zod,
      modelID: ModelID.zod,
      providerID: ProviderID.zod,
      messageID: MessageID.zod,
    }),
    async (input) => {
      await SessionPrompt.command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: Command.Default.INIT,
        arguments: "",
      })
    },
  )
}
