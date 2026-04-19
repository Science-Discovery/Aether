import type { Session } from "@opencode-ai/sdk/v2"

type LoadBranchTreeSessionsInput = {
  sessionID: string
  getSession: (sessionID: string) => Promise<Session>
  getChildren: (sessionID: string) => Promise<Session[]>
}

const compareByCreated = (a: Session, b: Session) => a.time.created - b.time.created || a.id.localeCompare(b.id)

export async function loadBranchTreeSessions(input: LoadBranchTreeSessionsInput) {
  const sessionsByID = new Map<string, Session>()
  const current = await input.getSession(input.sessionID)
  sessionsByID.set(current.id, current)

  let root = current
  const seenAncestors = new Set<string>([current.id])
  while (root.parentID && !seenAncestors.has(root.parentID)) {
    const parent = await input.getSession(root.parentID)
    sessionsByID.set(parent.id, parent)
    seenAncestors.add(parent.id)
    root = parent
  }

  const queue = [root.id]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const sessionID = queue.shift()
    if (!sessionID || visited.has(sessionID)) continue
    visited.add(sessionID)

    const children = (await input.getChildren(sessionID)).slice().sort(compareByCreated)
    for (const child of children) {
      sessionsByID.set(child.id, child)
      if (!visited.has(child.id)) queue.push(child.id)
    }
  }

  return {
    rootID: root.id,
    sessions: [...sessionsByID.values()].sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export function mergeSessionsByID(existing: Session[] | undefined, incoming: Session[]) {
  const merged = new Map((existing ?? []).map((session) => [session.id, session] as const))
  for (const session of incoming) merged.set(session.id, session)
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
}
