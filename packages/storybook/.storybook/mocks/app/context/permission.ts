type Mode = "off" | "safe" | "full"

const MODE_ORDER: Mode[] = ["off", "safe", "full"]

const sessionModes = new Map<string, Mode>()
const directoryAccepted = new Set<string>()

function key(sessionID: string, directory?: string) {
  return `${directory ?? ""}:${sessionID}`
}

function modeOf(sessionID: string, directory?: string): Mode | undefined {
  return sessionModes.get(key(sessionID, directory))
}

function setMode(sessionID: string, directory: string, mode: Mode) {
  sessionModes.set(key(sessionID, directory), mode)
}

export function usePermission() {
  return {
    ready: true,
    autoResponds() {
      return false
    },
    modeOf,
    effectiveMode(sessionID?: string, directory?: string): Mode {
      if (sessionID) return modeOf(sessionID, directory) ?? "off"
      return directoryAccepted.has(directory ?? "") ? "full" : "off"
    },
    setMode,
    cycleMode(sessionID: string | undefined, directory: string): Mode {
      if (!sessionID) {
        if (directoryAccepted.has(directory)) {
          directoryAccepted.delete(directory)
          return "off"
        }
        directoryAccepted.add(directory)
        return "full"
      }

      const now = modeOf(sessionID, directory) ?? "off"
      const next = MODE_ORDER[(MODE_ORDER.indexOf(now) + 1) % MODE_ORDER.length]
      setMode(sessionID, directory, next)
      return next
    },
    isAutoAccepting(sessionID: string, directory?: string) {
      return modeOf(sessionID, directory) === "full"
    },
    isAutoAcceptingDirectory(directory?: string) {
      return directoryAccepted.has(directory ?? "")
    },
    toggleAutoAcceptDirectory(directory?: string) {
      if (directoryAccepted.has(directory ?? "")) directoryAccepted.delete(directory ?? "")
      else directoryAccepted.add(directory ?? "")
    },
    enableAutoAccept(sessionID: string, directory: string) {
      setMode(sessionID, directory, "full")
    },
    permissionsEnabled: false,
    isPermissionAllowAll() {
      return false
    },
  }
}
