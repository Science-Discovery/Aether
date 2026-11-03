import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2"

function turn(parts: Part[] | undefined) {
  const values = (parts ?? []).flatMap((part) => {
    if (!("metadata" in part)) return []
    const metadata = part.metadata
    if (!metadata) return []
    const tag = metadata.nativeSteer ?? metadata.native
    if (!tag || typeof tag !== "object" || !("turn" in tag) || typeof tag.turn !== "string" || !tag.turn) return []
    return [tag.turn]
  })
  return new Set(values).size === 1 ? values[0] : undefined
}

export function forkable(message: AssistantMessage, messages: Message[], parts: Record<string, Part[] | undefined>) {
  if (message.providerID !== "codex-native" || message.error || typeof message.time.completed !== "number") return false
  const id = turn(parts[message.id])
  if (!id) return false
  const last = messages.findLast((item) => turn(parts[item.id]) === id)
  return (last?.role === "user" ? last.id : last?.parentID) === message.parentID
}
