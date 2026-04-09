import { base64Encode } from "@opencode-ai/util/encode"

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

function sessionLineage(session: readonly { id: string; parentID?: string }[], sessionID: string) {
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

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: readonly { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
  preference?: Record<string, { autoAccept: boolean | null }>,
) {
  const lineage = sessionLineage(session, permission.sessionID)
  if (preference) {
    const prefValue = lineage
      .map((id) => preference[id]?.autoAccept)
      .find((item): item is boolean => item !== undefined && item !== null)
    if (prefValue !== undefined) return prefValue
  }
  const value = lineage
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
  return value ?? false
}
