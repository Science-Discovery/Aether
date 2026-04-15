import type { Session } from "@opencode-ai/sdk/v2/client"
import type { RootLoadArgs } from "./types"

export async function loadRootSessionsWithFallback(input: RootLoadArgs) {
  try {
    const result = await input.list({ directory: input.directory, roots: true, limit: input.limit })
    return {
      data: result.data,
      limit: input.limit,
      limited: true,
    } as const
  } catch {
    const result = await input.list({ directory: input.directory, roots: true })
    return {
      data: result.data,
      limit: input.limit,
      limited: false,
    } as const
  }
}

export async function loadDescendantsForRoots(input: {
  directory: string
  roots: Session[]
  tree: (query: { directory: string; sessionID: string }) => Promise<{
    data?:
      | {
          kind?: string
          sessions?: Session[]
        }
      | undefined
  }>
  children: (query: { directory: string; sessionID: string }) => Promise<{ data?: Session[] }>
}) {
  const descendants = new Map<string, Session>()
  const legacyRoots: Session[] = []

  for (const root of input.roots) {
    try {
      const result = await input.tree({
        directory: input.directory,
        sessionID: root.id,
      })
      const payload = result.data
      if (payload?.kind === "tree" && Array.isArray(payload.sessions)) {
        for (const session of payload.sessions) {
          if (!session?.id) continue
          if (session.id === root.id) continue
          if (session.time?.archived) continue
          descendants.set(session.id, session)
        }
        continue
      }
    } catch {
      // Fallback to children recursion below for compatibility / transient failures.
    }
    legacyRoots.push(root)
  }

  const queue = [...legacyRoots.map((session) => session.id)]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const parentID = queue.shift()
    if (!parentID) continue
    if (visited.has(parentID)) continue
    visited.add(parentID)

    let children: Session[] = []
    try {
      const result = await input.children({
        directory: input.directory,
        sessionID: parentID,
      })
      children = result.data ?? []
    } catch {
      continue
    }

    for (const child of children) {
      if (!child?.id) continue
      if (child.time?.archived) continue
      descendants.set(child.id, child)
      if (!visited.has(child.id)) queue.push(child.id)
    }
  }

  return [...descendants.values()]
}

export function estimateRootSessionTotal(input: { count: number; limit: number; limited: boolean }) {
  if (!input.limited) return input.count
  if (input.count < input.limit) return input.count
  return input.count + 1
}
