import { base64Encode } from "@opencode-ai/util/encode"

export type PermissionMode = "off" | "safe" | "full"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  const directoryKey = directory ? directoryAcceptKey(directory) : undefined
  return autoAccept[key] ?? autoAccept[sessionID] ?? (directoryKey ? autoAccept[directoryKey] : undefined)
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

export function sessionLineage(session: readonly { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

export function resolvesPreference(pref?: { autoAccept?: boolean; mode?: PermissionMode }) {
  if (pref?.mode !== undefined) return pref.mode === "full"
  return pref?.autoAccept
}

// Locally-requested modes that have not been confirmed by a session.preference.updated
// event yet, keyed by acceptKey. Without this, a click before the SSE stream delivers
// the event is invisible to modeOf and a second click recomputes from the stale mode.
export function createModeOverrides(max = 500) {
  const map = new Map<string, PermissionMode>()
  return {
    set(sessionID: string, directory: string | undefined, mode: PermissionMode) {
      const key = acceptKey(sessionID, directory)
      map.delete(key)
      map.set(key, mode)
      for (const oldest of map.keys()) {
        if (map.size <= max) break
        map.delete(oldest)
      }
    },
    get(sessionID: string, directory: string | undefined, serverMode?: PermissionMode) {
      const key = acceptKey(sessionID, directory)
      const mode = map.get(key)
      if (mode === undefined) return undefined
      if (serverMode === mode) map.delete(key)
      return mode
    },
    drop(sessionID: string, directory: string | undefined) {
      map.delete(acceptKey(sessionID, directory))
    },
  }
}

export function sessionAcceptValue(
  autoAccept: Record<string, boolean>,
  session: readonly { id: string; parentID?: string }[],
  sessionID: string,
  directory?: string,
) {
  return sessionLineage(session, sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item) => item !== undefined)
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: readonly { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
  preference?: Record<string, { autoAccept?: boolean; mode?: PermissionMode }>,
) {
  const lineage = sessionLineage(session, permission.sessionID)
  if (preference) {
    const prefValue = lineage
      .map((id) => resolvesPreference(preference[id]))
      .find((item): item is boolean => item !== undefined)
    if (prefValue !== undefined) return prefValue
  }
  return sessionAcceptValue(autoAccept, session, permission.sessionID, directory) ?? false
}
