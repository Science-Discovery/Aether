import type { Session } from "@opencode-ai/sdk/v2/client"

export function upsertSessionList(items: Session[], next: Session) {
  const index = items.findIndex((item) => item.id === next.id)
  if (index !== -1) {
    const result = items.slice()
    result[index] = next
    return result
  }

  const insertAt = items.findIndex((item) => item.id > next.id)
  if (insertAt === -1) return [...items, next]

  const result = items.slice()
  result.splice(insertAt, 0, next)
  return result
}
