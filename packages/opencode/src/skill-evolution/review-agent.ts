import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Spawner } from "./spawner"
import { SKILL_REVIEW_PROMPT_BASE } from "./constants"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/util/log"
import { Database } from "@/storage/db"
import { ProjectIdentity } from "@/project/identity"
import { Project } from "@/project/project"
import { ProjectID } from "@/project/schema"
import { SessionID } from "@/session/schema"

const log = Log.create({ service: "skill-evolution.review-agent" })

/** Directory treated as the skill-sessions project root. */
const SKILL_SESSIONS_ROOT = path.join(Global.Path.home, ".aether", "skill-sessions")

/** Maximum number of review rounds (user messages) per evolution session before rolling over. */
const MAX_REVIEW_ROUNDS = 20

/** Stable project ID for the skill-sessions project, derived from its directory path. */
function skillSessionsProjectId(): ProjectID {
  return ProjectID.fromDirectory(ProjectIdentity.norm(SKILL_SESSIONS_ROOT))
}

/**
 * Find the evolution session for this title in the skill-sessions DB.
 * If the session has reached MAX_REVIEW_ROUNDS user messages, deletes the oldest half to make room.
 * Returns undefined only when no session exists yet.
 */
function findEvolutionSession(projectId: ProjectID, sessionTitle: string): SessionID | undefined {
  const db = Database.projectClient(projectId)
  const row = db.$client
    .prepare(
      "SELECT id FROM session WHERE project_id = ? AND title = ? ORDER BY time_created DESC LIMIT 1",
    )
    .get(projectId, sessionTitle) as { id: string } | undefined

  if (!row) return undefined

  const { cnt } = db.$client
    .prepare(
      "SELECT count(*) as cnt FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.finish') = 'stop'",
    )
    .get(row.id) as { cnt: number }

  if (cnt >= MAX_REVIEW_ROUNDS) {
    // Delete the oldest half of completed rounds to keep the session fresh.
    // A round ends at an assistant message with finish='stop'; deleting up to
    // the Nth such message's timestamp removes whole rounds, never partial ones.
    // Part rows cascade-delete automatically via FK.
    const deleteCount = Math.floor(MAX_REVIEW_ROUNDS / 2)
    const boundary = db.$client
      .prepare(
        `SELECT time_created FROM message
         WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.finish') = 'stop'
         ORDER BY time_created ASC
         LIMIT 1 OFFSET ?`,
      )
      .get(row.id, deleteCount - 1) as { time_created: number } | undefined

    if (boundary) {
      db.$client
        .prepare("DELETE FROM message WHERE session_id = ? AND time_created <= ?")
        .run(row.id, boundary.time_created)
    }
  }

  return row.id as SessionID
}

/** Minimal snapshot of a message part used when serializing conversation history. */
interface PartSnapshot {
  type: string
  text?: string
  tool?: string
  callID?: string
  state?: unknown
}

/** Minimal snapshot of a message used for building the review prompt. */
export interface MessageSnapshot {
  role: "user" | "assistant"
  parts: PartSnapshot[]
}

/**
 * Serialize a conversation history snapshot into an XML block for the review prompt.
 */
export function serializeHistory(messages: ReadonlyArray<MessageSnapshot>): string {
  const lines: string[] = ["<conversation_history>"]
  for (const msg of messages) {
    lines.push(`  <message role="${msg.role}">`)
    for (const part of msg.parts) {
      if (part.type === "text" && part.text) {
        lines.push(`    <text>${escapeXml(part.text)}</text>`)
      } else if (part.type === "tool") {
        lines.push(`    <tool_call name="${escapeXml(part.tool ?? "")}" id="${part.callID ?? ""}"/>`)
      }
    }
    lines.push("  </message>")
  }
  lines.push("</conversation_history>")
  return lines.join("\n")
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/**
 * Scan the shadow directories for existing skill categories by reading SKILL.md frontmatter.
 */
async function collectCategories(folderName: string): Promise<string[]> {
  const categories = new Set<string>()
  const dirsToScan = [
    path.join(Global.Path.home, ".aether", "skills"),
    Spawner.skillSessionsDir(folderName),
  ]
  for (const dir of dirsToScan) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillMd = path.join(dir, entry.name, "SKILL.md")
      try {
        const content = await fs.readFile(skillMd, "utf-8")
        const m = content.match(/^---[\s\S]*?^category:\s*(.+)$/m)
        if (m) categories.add(m[1]!.trim())
      } catch {
        // Skip unreadable files
      }
    }
  }
  return Array.from(categories)
}

/**
 * Build the full review prompt for the background agent.
 */
export async function buildReviewPrompt(
  messages: ReadonlyArray<MessageSnapshot>,
  folderName: string,
): Promise<string> {
  const categories = await collectCategories(folderName)
  const categoryHint =
    categories.length > 0
      ? categories.map((c) => `  - ${c}`).join("\n") + "\n"
      : "  (no existing categories yet)\n"
  return [serializeHistory(messages), "", SKILL_REVIEW_PROMPT_BASE + categoryHint].join("\n")
}

/**
 * Spawn a background review session for the given conversation.
 *
 * All review sessions for a project share a single evolution session in the skill-sessions
 * project (title: "<projectName> / skill-evolution"). When a session reaches MAX_REVIEW_ROUNDS
 * user messages it rolls over to a fresh one. Runs fire-and-forget; errors are logged only.
 */
export async function spawnReview(input: {
  sessionID: SessionID
  projectId: string
  projectDirectory?: string
}): Promise<void> {
  try {
    const folderName = input.projectDirectory
      ? Spawner.skillFolderName(input.projectDirectory, input.projectId)
      : input.projectId

    // Read messages here (deferred) so callers don't pay the DB cost on every session end
    const { MessageV2 } = await import("@/session/message-v2")
    const rawMessages = await MessageV2.filterCompacted(MessageV2.stream(input.sessionID))
    const messages: MessageSnapshot[] = rawMessages.map((m) => ({
      role: m.info.role as "user" | "assistant",
      parts: m.parts.map((p) => ({
        type: p.type,
        text: "text" in p ? (p as any).text : undefined,
        tool: "tool" in p ? (p as any).tool : undefined,
        callID: "callID" in p ? (p as any).callID : undefined,
      })),
    }))

    const prompt = await buildReviewPrompt(messages, folderName)

    await fs.mkdir(SKILL_SESSIONS_ROOT, { recursive: true })
    const skillProjectId = skillSessionsProjectId()
    await Project.fromDirectory(SKILL_SESSIONS_ROOT)

    // Dynamically import to avoid circular deps and keep startup cost low
    const { Instance } = await import("@/project/instance")
    const { SessionPrompt } = await import("@/session/prompt")
    const { ToolRegistry } = await import("@/tool/registry")
    const { createBoundSkillManageTool } = await import("./skill-manage-tool")
    const { Skill } = await import("@/skill")

    const allSkills = await Skill.all()
    const skillLocationMap: Record<string, string> = {}
    for (const skill of allSkills) {
      if (!skill.location.split(path.sep).includes(".aether")) {
        skillLocationMap[skill.name] = skill.location
      }
    }

    const sessionTitle = path.basename(Instance.directory)

    log.info("spawning skill evolution review", {
      parentSessionID: input.sessionID,
      projectId: input.projectId,
      folderName,
      skillProjectId,
      sessionTitle,
    })

    // Run the review agent fire-and-forget inside the skill-sessions Instance context so that
    // Session.get / MessageV2 reads+writes all target the skill-sessions DB.
    let reviewSessionId: SessionID | undefined
    Instance.provide({
      directory: SKILL_SESSIONS_ROOT,
      create: true,
      fn: async () => {
        const { Session } = await import("@/session")
        const existing = findEvolutionSession(skillProjectId, sessionTitle)
        reviewSessionId =
          existing ??
          (await Session.createNext({ title: sessionTitle, directory: SKILL_SESSIONS_ROOT })).id

        log.info(existing ? "reusing evolution session" : "created evolution session", {
          reviewSessionId,
          sessionTitle,
        })

        // Register skill_manage scoped to this review session only, so concurrent
        // reviews for different projects don't overwrite each other's bound tool.
        ToolRegistry.registerForSession(reviewSessionId, createBoundSkillManageTool(folderName, skillLocationMap))
        try {
          return await SessionPrompt.prompt({
            sessionID: reviewSessionId,
            parts: [{ type: "text", text: prompt }],
            tools: {
              "*": false,
              skill_manage: true,
              read: true,
            },
          })
        } finally {
          ToolRegistry.unregisterSession(reviewSessionId)
        }
      },
    }).catch((err) => {
      log.error("review session failed", { error: err, reviewSessionId })
    })
  } catch (err) {
    log.error("failed to spawn review session", { error: err, sessionID: input.sessionID })
  }
}

export function isReviewSession(): boolean {
  try {
    return Instance.directory === Filesystem.resolve(SKILL_SESSIONS_ROOT)
  } catch {
    return false
  }
}
