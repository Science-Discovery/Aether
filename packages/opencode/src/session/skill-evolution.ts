import { Session } from "."
import { SessionPrompt } from "./prompt"
import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"

const log = Log.create({ service: "skill.evolution" })

export const Event = {
  SkillSaved: BusEvent.define(
    "skill.saved",
    z.object({
      sessionID: SessionID.zod,
      actions: z.array(z.string()),
    }),
  ),
}

// Number of LLM steps (each step may contain multiple tool calls) without
// calling skill_manage before a background review is triggered.
export const SKILL_NUDGE_INTERVAL = 10

// Marker stored on the child session to identify it as a skill review session,
// so it never recursively triggers another review.
export const SKILL_REVIEW_MARKER = "__skill_review__"

export const SKILL_REVIEW_PROMPT = [
  "Review the conversation above and consider saving or updating a skill if appropriate.",
  "",
  "Focus on: was a non-trivial approach used to complete a task that required trial and error,",
  "or changing course due to experiential findings along the way, or did the user expect or",
  "desire a different method or outcome?",
  "",
  "If a relevant skill already exists, update it with what you learned.",
  "Otherwise, create a new skill if the approach is reusable.",
  "If nothing is worth saving, just say 'Nothing to save.' and stop.",
].join("\n")

export const SKILLS_GUIDANCE = [
  "After completing a complex task (5+ tool calls), fixing a tricky error,",
  "or discovering a non-trivial workflow, save the approach as a skill with",
  "skill_manage so you can reuse it next time.",
  "When using a skill and finding it outdated, incomplete, or wrong,",
  "patch it immediately with skill_manage(action='patch') — don't wait to be asked.",
  "Skills that aren't maintained become liabilities.",
].join("\n")

export function buildReviewPrompt(messages: MessageV2.WithParts[]): string {
  // Summarise the conversation into text so the review agent can read it
  const lines: string[] = ["<conversation_history>"]
  for (const msg of messages) {
    const role = msg.info.role === "user" ? "User" : "Assistant"
    for (const part of msg.parts) {
      if (part.type === "text" && !("synthetic" in part && part.synthetic)) {
        lines.push(`[${role}]: ${part.text}`)
      } else if (part.type === "tool") {
        const toolPart = part as MessageV2.ToolPart
        if (toolPart.state.status === "completed") {
          lines.push(`[Tool call: ${toolPart.tool}] → ${toolPart.state.output ?? ""}`)
        }
      }
    }
  }
  lines.push("</conversation_history>", "", SKILL_REVIEW_PROMPT)
  return lines.join("\n")
}

export async function spawnBackgroundReview(input: {
  sessionID: SessionID
  agentName: string
  model: { providerID: string; modelID: string }
  messages: MessageV2.WithParts[]
}): Promise<void> {
  const { sessionID, agentName, model, messages } = input
  try {
    const childSession = await Session.create({
      parentID: sessionID,
      title: SKILL_REVIEW_MARKER,
      permission: [
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "todowrite", pattern: "*", action: "deny" },
      ],
    })

    console.log(`[skill review] started childSession=${childSession.id} model=${model.providerID}/${model.modelID}`)

    const reviewPrompt = buildReviewPrompt(messages)

    await SessionPrompt.prompt({
      sessionID: childSession.id,
      agent: agentName,
      model: {
        providerID: model.providerID as any,
        modelID: model.modelID as any,
      },
      parts: [{ type: "text", text: reviewPrompt }],
    })

    // mirrors Hermes: scan child session messages for successful skill_manage calls
    const childMessages = await MessageV2.filterCompacted(MessageV2.stream(childSession.id))
    const actions: string[] = []
    let reviewText = ""
    for (const msg of childMessages) {
      for (const part of msg.parts) {
        if (part.type === "text" && !("synthetic" in part && part.synthetic)) {
          reviewText = (part as MessageV2.TextPart).text.trim()
        }
        if (part.type !== "tool") continue
        const toolPart = part as MessageV2.ToolPart
        if (toolPart.tool !== "skill_manage") continue
        if (toolPart.state.status !== "completed") continue
        const out = toolPart.state.output
        if (out && (out.includes("created") || out.includes("updated") || out.includes("patched"))) {
          actions.push(toolPart.state.title)
        }
      }
    }

    if (actions.length > 0) {
      console.log(`[skill review] ${reviewText || ""}`)
      console.log(`[skill review] 💾 ${actions.join(", ")}`)
      await Bus.publish(Event.SkillSaved, { sessionID, actions })
      log.info("skill review saved", { actions })
    } else {
      console.log(`[skill review] ${reviewText || "nothing to save"}`)
    }
  } catch (err) {
    console.log(`[skill review] error: ${err}`)
    log.error("failed to spawn background skill review", { error: err })
  }
}
