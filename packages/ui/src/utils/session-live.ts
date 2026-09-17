import type { Part } from "@opencode-ai/sdk/v2/client"

const hidden = new Set(["todowrite"])

function streaming(time: { end?: number } | undefined) {
  return !!time && time.end === undefined
}

export function livePart(part: Part, showReasoningSummaries: boolean) {
  if (part.type === "tool") {
    if (hidden.has(part.tool)) return false
    return part.state.status === "pending" || part.state.status === "running"
  }
  if (part.type === "text") return !!part.text?.trim() && streaming(part.time)
  if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim() && streaming(part.time)
  return false
}
