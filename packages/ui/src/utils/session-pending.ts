import type { Session } from "@opencode-ai/sdk/v2"

export function hasPendingRequest(
  sessions: Session[],
  rootID: string,
  permission: (sid: string) => unknown[] | undefined,
  question: (sid: string) => unknown[] | undefined,
): boolean {
  const childMap = new Map<string, string[]>()
  for (const s of sessions) {
    if (!s.parentID) continue
    const list = childMap.get(s.parentID)
    if (list) list.push(s.id)
    else childMap.set(s.parentID, [s.id])
  }

  const visited = new Set<string>()
  const queue = [rootID]
  visited.add(rootID)
  while (queue.length > 0) {
    const current = queue.shift()!
    if ((permission(current)?.length ?? 0) > 0 || (question(current)?.length ?? 0) > 0) return true
    const children = childMap.get(current)
    if (children) {
      for (const c of children) {
        if (!visited.has(c)) {
          visited.add(c)
          queue.push(c)
        }
      }
    }
  }
  return false
}
