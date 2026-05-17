import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Spawner } from "./spawner"
import { SKILL_REVIEW_PROMPT_BASE } from "./constants"
import { Log } from "@/util/log"
import { Database } from "@/storage/db"
import { ProjectIdentity } from "@/project/identity"
import { Project } from "@/project/project"
import { ProjectID } from "@/project/schema"
import { SessionID, TreeID } from "@/session/schema"
import { Slug } from "@opencode-ai/util/slug"
import { Installation } from "@/installation"

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
 * Insert a new session row directly into the skill-sessions DB.
 * Bypasses Session.createNext intentionally — review sessions need no share/snapshot/bus events.
 */
function insertEvolutionSession(projectId: ProjectID, sessionTitle: string): SessionID {
  const db = Database.projectClient(projectId)
  const sessionId = SessionID.descending()
  const treeId = TreeID.descending()
  const now = Date.now()
  db.$client
    .prepare(
      `INSERT INTO session (id, project_id, slug, directory, title, version, tree_id, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, projectId, Slug.create(), SKILL_SESSIONS_ROOT, sessionTitle, Installation.VERSION, treeId, now, now)
  return sessionId as SessionID
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
      "SELECT count(*) as cnt FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user'",
    )
    .get(row.id) as { cnt: number }

  if (cnt >= MAX_REVIEW_ROUNDS) {
    // Delete the oldest half of messages to keep the session fresh.
    // Part rows cascade-delete automatically via FK.
    const deleteCount = Math.floor(MAX_REVIEW_ROUNDS / 2)
    db.$client
      .prepare(
        `DELETE FROM message WHERE id IN (
           SELECT id FROM message WHERE session_id = ? ORDER BY time_created ASC LIMIT ?
         )`,
      )
      .run(row.id, deleteCount)
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
  sessionID: string
  messages: ReadonlyArray<MessageSnapshot>
  projectId: string
  projectDirectory?: string
}): Promise<void> {
  try {
    const folderName = input.projectDirectory
      ? Spawner.skillFolderName(input.projectDirectory, input.projectId)
      : input.projectId

    const prompt = await buildReviewPrompt(input.messages, folderName)

    await fs.mkdir(SKILL_SESSIONS_ROOT, { recursive: true })
    const skillProjectId = skillSessionsProjectId()
    await Project.fromDirectory(SKILL_SESSIONS_ROOT)

    // Dynamically import to avoid circular deps and keep startup cost low
    const { Instance } = await import("@/project/instance")
    const { SessionPrompt } = await import("@/session/prompt")

    const sessionTitle = path.basename(Instance.directory)

    log.info("spawning skill evolution review", {
      parentSessionID: input.sessionID,
      projectId: input.projectId,
      folderName,
      skillProjectId,
      sessionTitle,
    })

    // Find or create the evolution session (direct SQL, no createNext)
    const existing = findEvolutionSession(skillProjectId, sessionTitle)
    const reviewSessionId = existing ?? insertEvolutionSession(skillProjectId, sessionTitle)

    log.info(existing ? "reusing evolution session" : "created evolution session", {
      reviewSessionId,
      sessionTitle,
    })

    // Mark as a review session so the hook ignores it
    _reviewSessions.add(reviewSessionId)

    // Run the review agent fire-and-forget inside the skill-sessions Instance context so that
    // Session.get / MessageV2 reads+writes all target the skill-sessions DB.
    Instance.provide({
      directory: SKILL_SESSIONS_ROOT,
      create: false,
      fn: () =>
        SessionPrompt.prompt({
          sessionID: reviewSessionId,
          parts: [{ type: "text", text: prompt }],
        }),
    }).catch((err) => {
      log.error("review session failed", { error: err, reviewSessionId })
    })
  } catch (err) {
    log.error("failed to spawn review session", { error: err, sessionID: input.sessionID })
  }
}

/**
 * Set of session IDs that are background review sessions.
 * Used by the hook to prevent recursive triggering.
 */
const _reviewSessions = new Set<string>()

export function isReviewSession(sessionID: string): boolean {
  return _reviewSessions.has(sessionID)
}
