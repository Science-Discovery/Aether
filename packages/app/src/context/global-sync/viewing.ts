const viewing = new Set<string>()

export function markViewing(sessionID?: string) {
  viewing.clear()
  if (sessionID) viewing.add(sessionID)
}

export function viewingIDs() {
  return viewing
}

export function isViewing(sessionID: string) {
  return viewing.has(sessionID)
}
