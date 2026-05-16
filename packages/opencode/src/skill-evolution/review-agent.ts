import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { SKILL_REVIEW_PROMPT_BASE } from "./constants"
import { Spawner } from "./spawner"
import { Log } from "@/util/log"

const log = Log.create({ service: "skill-evolution.review-agent" })

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
 * Falls back to an empty list if no skills are found.
 */
async function collectCategories(projectId: string): Promise<string[]> {
  const categories = new Set<string>()

  const dirsToScan = [
    path.join(Global.Path.home, ".aether", "skills"),
    path.join(Global.Path.home, ".aether", "skill-sessions", projectId, "skills"),
  ]

  for (const dir of dirsToScan) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillMd = path.join(dir, entry.name, "SKILL.md")
      try {
        const content = await fs.readFile(skillMd, "utf-8")
        // Extract category field from YAML frontmatter
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
  projectId: string,
): Promise<string> {
  const categories = await collectCategories(projectId)
  const categoryHint =
    categories.length > 0
      ? categories.map((c) => `  - ${c}`).join("\n") + "\n"
      : "  (no existing categories yet)\n"

  return [
    serializeHistory(messages),
    "",
    SKILL_REVIEW_PROMPT_BASE + categoryHint,
  ].join("\n")
}

/**
 * Spawn a background review session for the given conversation.
 * Runs fire-and-forget; errors are logged but never rethrown.
 */
export async function spawnReview(input: {
  sessionID: string
  messages: ReadonlyArray<MessageSnapshot>
  projectId: string
}): Promise<void> {
  try {
    const prompt = await buildReviewPrompt(input.messages, input.projectId)
    const skillSessionsDir = Spawner.skillSessionsBase(input.projectId)
    await fs.mkdir(skillSessionsDir, { recursive: true })

    log.info("spawning skill evolution review", {
      sessionID: input.sessionID,
      projectId: input.projectId,
      promptLength: prompt.length,
    })

    // Dynamically import to avoid circular deps and keep startup cost low
    const { Instance } = await import("@/project/instance")
    const { Session } = await import("@/session")
    const { SessionPrompt } = await import("@/session/prompt")

    // Create a child session under the parent project for the review
    const reviewSession = await Session.createNext({
      title: `skill-evolution / review (parent: ${input.sessionID})`,
      directory: Instance.directory,
      parentID: undefined,
    })

    // Mark as a review session so the hook ignores it
    _reviewSessions.add(reviewSession.id)

    // Run the review agent in the background — intentionally not awaited
    SessionPrompt.prompt({
      sessionID: reviewSession.id,
      parts: [{ type: "text", text: prompt }],
    }).catch((err) => {
      log.error("review session failed", { error: err, sessionID: reviewSession.id })
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
