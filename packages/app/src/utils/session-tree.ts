import type { Session } from "@opencode-ai/sdk/v2/client"

export function collectSessionSubtree(sessions: Session[] | undefined, rootSessionID: string) {
  const all = sessions ?? []
  const byParent = new Map<string, Session[]>()

  for (const session of all) {
    if (!session.parentID) continue
    const children = byParent.get(session.parentID)
    if (children) children.push(session)
    else byParent.set(session.parentID, [session])
  }

  const subtree: Session[] = []
  const queue = [rootSessionID]
  const visited = new Set<string>()
  const byID = new Map(all.map((session) => [session.id, session] as const))

  while (queue.length > 0) {
    const sessionID = queue.shift()
    if (!sessionID || visited.has(sessionID)) continue
    visited.add(sessionID)

    const session = byID.get(sessionID)
    if (!session) continue
    subtree.push(session)

    for (const child of byParent.get(sessionID) ?? []) {
      if (visited.has(child.id)) continue
      queue.push(child.id)
    }
  }

  return subtree
}

export function countSessionDescendants(sessions: Session[] | undefined, rootSessionID: string) {
  return Math.max(0, collectSessionSubtree(sessions, rootSessionID).length - 1)
}
