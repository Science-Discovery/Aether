import { getFilename } from "@opencode-ai/util/path"
import { type Session } from "@opencode-ai/sdk/v2/client"

type SessionStore = {
  session?: Session[]
  path: { directory: string }
}

export const workspaceKey = (directory: string) => {
  // Normalize separators to forward slashes; lowercase for Windows drive paths (case-insensitive FS)
  const normalized = directory.replace(/\\/g, "/")
  const cased = /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
  if (/^[a-z]:\/+$/i.test(cased)) return `${cased[0]}:/`
  if (/^\/+$/.test(cased)) return "/"
  return cased.replace(/\/+$/, "")
}

function sortSessions(now: number) {
  const oneMinuteAgo = now - 60 * 1000
  return (a: Session, b: Session) => {
    const aUpdated = a.time.updated ?? a.time.created
    const bUpdated = b.time.updated ?? b.time.created
    const aRecent = aUpdated > oneMinuteAgo
    const bRecent = bUpdated > oneMinuteAgo
    if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    return bUpdated - aUpdated
  }
}

const isRootVisibleSession = (session: Session, directory: string) =>
  workspaceKey(session.directory) === workspaceKey(directory) && !session.parentID && !session.time?.archived

const roots = (store: SessionStore) =>
  (store.session ?? []).filter((session) => isRootVisibleSession(session, store.path.directory))

export const sortedRootSessions = (store: SessionStore, now: number) => roots(store).sort(sortSessions(now))

export const latestRootSession = (stores: SessionStore[], now: number) =>
  stores.flatMap(roots).sort(sortSessions(now))[0]

export function hasProjectPermissions<T>(
  request: Record<string, T[] | undefined> | undefined,
  include: (item: T) => boolean = () => true,
) {
  return Object.values(request ?? {}).some((list) => list?.some(include))
}

export const childMapByParent = (sessions: Session[] | undefined) => {
  const map = new Map<string, string[]>()
  for (const session of sessions ?? []) {
    if (!session.parentID) continue
    const existing = map.get(session.parentID)
    if (existing) {
      existing.push(session.id)
      continue
    }
    map.set(session.parentID, [session.id])
  }
  return map
}

export const displayName = (project: { name?: string; worktree: string }) =>
  project.name || getFilename(project.worktree)

export const errorMessage = (err: unknown, fallback: string) => {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}

/**
 * Derive a starting directory for the "open project" dialog from the most
 * recently used project.  Returns the *parent* of the last project's worktree
 * so the user lands in the folder that contains sibling projects.
 *
 * Returns `undefined` when no recent project is available.
 */
export const recentProjectStart = (
  recent: { worktree: string } | undefined,
  home: string,
): string | undefined => {
  if (!recent) return undefined

  const normalized = recent.worktree.replace(/\\/g, "/")
  const key = workspaceKey(normalized)
  const homeKey = workspaceKey(home)

  // If the project is the home directory itself, or directly inside home,
  // just return home.
  if (key === homeKey) return home

  // Find the parent directory.
  const lastSlash = key.lastIndexOf("/")
  if (lastSlash <= 0) return "/" // POSIX root

  const parent = key.slice(0, lastSlash)

  // If parent is the root of a Windows drive (e.g. "C:"), normalize.
  if (/^[A-Za-z]:$/.test(parent)) return parent + "/"

  // If parent is the same as (or above) home, just use home.
  if (parent.length < homeKey.length) return home
  if (parent === homeKey) return home

  return parent
}

export const effectiveWorkspaceOrder = (local: string, dirs: string[], persisted?: string[]) => {
  const root = workspaceKey(local)
  const live = new Map<string, string>()

  for (const dir of dirs) {
    const key = workspaceKey(dir)
    if (key === root) continue
    if (!live.has(key)) live.set(key, dir)
  }

  if (!persisted?.length) return [local, ...live.values()]

  const result = [local]
  for (const dir of persisted) {
    const key = workspaceKey(dir)
    if (key === root) continue
    const match = live.get(key)
    if (!match) continue
    result.push(match)
    live.delete(key)
  }

  return [...result, ...live.values()]
}
