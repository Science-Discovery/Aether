import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { cmp } from "./utils"
import { SESSION_RECENT_LIMIT, SESSION_RECENT_WINDOW } from "./types"

export function sessionUpdatedAt(session: Session) {
  return session.time.updated ?? session.time.created
}

export function compareSessionRecent(a: Session, b: Session) {
  const aUpdated = sessionUpdatedAt(a)
  const bUpdated = sessionUpdatedAt(b)
  if (aUpdated !== bUpdated) return bUpdated - aUpdated
  return cmp(a.id, b.id)
}

export function takeRecentSessions(sessions: Session[], limit: number, cutoff: number) {
  if (limit <= 0) return [] as Session[]
  const selected: Session[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    if (!session?.id) continue
    if (seen.has(session.id)) continue
    seen.add(session.id)
    if (sessionUpdatedAt(session) <= cutoff) continue
    const index = selected.findIndex((x) => compareSessionRecent(session, x) < 0)
    if (index === -1) selected.push(session)
    if (index !== -1) selected.splice(index, 0, session)
    if (selected.length > limit) selected.pop()
  }
  return selected
}

export function trimSessions(
  input: Session[],
  options: {
    limit: number
    permission: Record<string, PermissionRequest[]>
    now?: number
    keep?: Iterable<string>
    recent?: number
  },
) {
  const limit = Math.max(0, options.limit)
  const cutoff = (options.now ?? Date.now()) - SESSION_RECENT_WINDOW
  const all = input
    .filter((s) => !!s?.id)
    .filter((s) => !s.time?.archived)
    .sort((a, b) => cmp(a.id, b.id))
  const roots = all.filter((s) => !s.parentID)
  const children = all.filter((s) => !!s.parentID)
  const rootsByActivity = roots.slice().sort(compareSessionRecent)
  const base = rootsByActivity.slice(0, limit)
  const baseIds = new Set(base.map((s) => s.id))
  const remaining = roots.filter((s) => !baseIds.has(s.id))
  const recent = takeRecentSessions(remaining, options.recent ?? SESSION_RECENT_LIMIT, cutoff)
  const keepRoots = [...base, ...recent]
  const keepRootIds = new Set(keepRoots.map((s) => s.id))
  const keepChildren = children.filter((s) => {
    if (s.parentID && keepRootIds.has(s.parentID)) return true
    const perms = options.permission[s.id] ?? []
    if (perms.length > 0) return true
    return sessionUpdatedAt(s) > cutoff
  })
  const pinned = pinnedIDs(all, options.keep)
  const kept = new Map<string, Session>()
  for (const s of [...keepRoots, ...keepChildren]) kept.set(s.id, s)
  for (const s of all) {
    if (!pinned.has(s.id)) continue
    kept.set(s.id, s)
  }
  return [...kept.values()].sort((a, b) => cmp(a.id, b.id))
}

function pinnedIDs(sessions: Session[], keep?: Iterable<string>) {
  const pinned = new Set<string>()
  if (!keep) return pinned
  const parentOf = new Map(sessions.map((s) => [s.id, s.parentID] as const))
  for (const id of keep) {
    let current: string | undefined = id
    while (current && !pinned.has(current)) {
      pinned.add(current)
      current = parentOf.get(current)
    }
  }
  return pinned
}
