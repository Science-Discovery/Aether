import fs from "fs/promises"
import path from "path"
import z from "zod"
import { generateText, tool, jsonSchema, stepCountIs } from "ai"
import { Global } from "@/global"
import { Spawner } from "./spawner"
import { SKILL_REVIEW_PROMPT_BASE } from "./constants"
import { Log } from "@/util/log"
import { SessionID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Auth } from "@/auth"
import { EvolutionDb } from "./db"
import { SkillManageTool, SkillManageInput, SKILL_MANAGE_DESCRIPTION } from "./skill-manage-tool"

const log = Log.create({ service: "skill-evolution.review-agent" })

/** Projects with a review currently running, keyed by folderName. */
const runningReviews = new Set<string>()
/** Latest pending input per project, keyed by folderName. Overwritten on each new trigger. */
const pendingReviews = new Map<string, { sessionID: SessionID; projectId: string; projectDirectory?: string }>()

/** Maximum number of tool-call steps the LLM may take in a single review. */
const MAX_STEPS = 15

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
  const dirsToScan = [path.join(Global.Path.home, ".aether", "skills"), Spawner.skillSessionsDir(folderName)]
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
export async function buildReviewPrompt(messages: ReadonlyArray<MessageSnapshot>, folderName: string): Promise<string> {
  const categories = await collectCategories(folderName)
  const categoryHint =
    categories.length > 0 ? categories.map((c) => `  - ${c}`).join("\n") + "\n" : "  (no existing categories yet)\n"
  return [serializeHistory(messages), "", SKILL_REVIEW_PROMPT_BASE + categoryHint].join("\n")
}

/**
 * Spawn a background skill evolution review using a direct LLM call (no Session/Instance).
 *
 * Runs fire-and-forget; errors are logged only.
 */
export async function spawnReview(input: {
  sessionID: SessionID
  projectId: string
  projectDirectory?: string
}): Promise<void> {
  const folderName = input.projectDirectory
    ? Spawner.skillFolderName(input.projectDirectory, input.projectId)
    : input.projectId

  if (runningReviews.has(folderName)) {
    pendingReviews.set(folderName, input)
    return
  }
  runningReviews.add(folderName)

  try {
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

    const { Skill } = await import("@/skill")
    const allSkills = await Skill.all()
    const skillLocationMap: Record<string, string> = {}
    const skillSessionMap: Record<string, string> = {}
    for (const skill of allSkills) {
      const parts = skill.location.split(path.sep)
      const aetherIdx = parts.indexOf(".aether")
      if (aetherIdx === -1) {
        skillLocationMap[skill.name] = skill.location
      } else if (parts[aetherIdx + 1] === "skills") {
        skillLocationMap[skill.name] = skill.location
      } else if (parts[aetherIdx + 1] === "skill-sessions") {
        skillSessionMap[skill.name] = parts[aetherIdx + 2]
      }
    }

    log.info("spawning skill evolution review", {
      parentSessionID: input.sessionID,
      projectId: input.projectId,
      folderName,
    })

    void (async () => {
      const runId = EvolutionDb.insertRun({
        projectId: input.projectId,
        folderName,
        sourceSessionId: input.sessionID,
      })
      try {
        const model = await Provider.defaultModel()
        const resolved = await Provider.getModel(model.providerID, model.modelID)
        const language = await Provider.getLanguage(resolved)

        const skillManageSchema = ProviderTransform.schema(resolved, z.toJSONSchema(SkillManageInput as any))

        const skillManageTool = tool({
          description: SKILL_MANAGE_DESCRIPTION,
          parameters: jsonSchema(skillManageSchema as any),
          execute: async (params: any) => {
            const resolvedLocation = params.skillLocation ?? skillLocationMap?.[params.name]
            const resolvedSessionId =
              params.sessionProjectId ?? skillSessionMap?.[params.name] ?? (!resolvedLocation ? folderName : undefined)
            const result = await SkillManageTool.execute({
              ...params,
              skillLocation: resolvedLocation,
              sessionProjectId: resolvedSessionId,
            })
            return JSON.stringify(result)
          },
        } as any)

        const readTool = tool({
          description: "Read the contents of a file at the given absolute path.",
          parameters: jsonSchema({
            type: "object" as const,
            properties: {
              filePath: { type: "string", description: "The absolute path to the file to read." },
            },
            required: ["filePath"],
          }),
          execute: async (params: any) => {
            try {
              const content = await fs.readFile(params.filePath, "utf-8")
              return content
            } catch (e) {
              return `Error reading file: ${e instanceof Error ? e.message : String(e)}`
            }
          },
        } as any)

        const authInfo = await Auth.get(model.providerID)
        const providerOptions =
          authInfo?.type === "oauth" ? ProviderTransform.providerOptions(resolved, { store: false }) : undefined

        const result = await generateText({
          model: language,
          system: SKILL_REVIEW_PROMPT_BASE,
          messages: [{ role: "user" as const, content: prompt }],
          tools: { skill_manage: skillManageTool, read: readTool },
          stopWhen: stepCountIs(MAX_STEPS),
          providerOptions,
        })

        const toolCalls = result.steps
          .flatMap((s) => s.toolCalls ?? [])
          .map((tc) => ({ tool: tc.toolName, input: "input" in tc ? tc.input : undefined }))

        const summary = result.text?.slice(0, 500) || "(no text output)"

        EvolutionDb.completeRun(runId, {
          toolCallsJson: JSON.stringify(toolCalls),
          resultSummary: summary,
        })

        log.info("skill evolution review completed", {
          runId,
          folderName,
          toolCallCount: toolCalls.length,
        })
      } catch (err) {
        EvolutionDb.completeRun(runId, {
          error: err instanceof Error ? err.message : String(err),
        })
        log.error("skill evolution review failed", { error: err, runId })
      } finally {
        runningReviews.delete(folderName)
        const pending = pendingReviews.get(folderName)
        if (pending) {
          pendingReviews.delete(folderName)
          spawnReview(pending)
        }
      }
    })()
  } catch (err) {
    runningReviews.delete(folderName)
    log.error("failed to spawn review session", { error: err, sessionID: input.sessionID })
  }
}

export function isReviewSession(): boolean {
  // With the direct LLM approach there is no Instance context for review sessions,
  // so this always returns false. Kept for API compatibility with the hook.
  return false
}
