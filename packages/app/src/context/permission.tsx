import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSettings } from "@/context/settings"
import { useGlobalSync } from "./global-sync"
import { useParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import {
  acceptKey,
  directoryAcceptKey,
  isDirectoryAutoAccepting,
  autoRespondsPermission,
  sessionAcceptValue,
  sessionLineage,
  createModeOverrides,
  type PermissionMode,
} from "./permission-auto-respond"
import type { SessionPreference } from "./global-sync/types"

export type { PermissionMode }

export function resolveMode(pref?: { autoAccept?: boolean; mode?: PermissionMode }) {
  return pref?.mode ?? (pref?.autoAccept ? "full" : undefined)
}

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "always" | "reject"
  directory?: string
}) => void

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasPermissionPromptRules(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (typeof permission !== "object") return false
  if (Array.isArray(permission)) return false

  const config = permission as Record<string, unknown>
  return Object.values(config).some(isNonAllowRule)
}

const MODE_ORDER: PermissionMode[] = ["off", "safe", "full"]

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const params = useParams()
    const globalSDK = useGlobalSDK()
    const globalSync = useGlobalSync()
    const settings = useSettings()

    const permissionsEnabled = createMemo(() => {
      const directory = decode64(params.dir)
      if (!directory) return false
      const [store] = globalSync.child(directory)
      return hasPermissionPromptRules(store.config.permission)
    })

    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.serverGlobal("permission", ["permission.v3"]),
        migrate(value) {
          if (!value || typeof value !== "object" || Array.isArray(value)) return value

          const data = value as Record<string, unknown>
          if (data.autoAccept) return value

          return {
            ...data,
            autoAccept:
              typeof data.autoAcceptEdits === "object" && data.autoAcceptEdits && !Array.isArray(data.autoAcceptEdits)
                ? data.autoAcceptEdits
                : {},
          }
        },
      },
      createStore({
        autoAccept: {} as Record<string, boolean>,
      }),
    )

    createEffect(() => {
      if (!ready()) return
      const directory = decode64(params.dir)
      if (!directory) return
      const [childStore] = globalSync.child(directory)
      const perm = childStore.config.permission
      if (typeof perm === "string" && perm === "allow") {
        const key = directoryAcceptKey(directory)
        if (store.autoAccept[key] === undefined) {
          setStore(
            produce((draft) => {
              draft.autoAccept[key] = true
            }),
          )
        }
      }
    })

    const current = () => {
      const directory = decode64(params.dir)
      if (!directory) return { session: [], preference: {} } as const
      return globalSync.child(directory, { bootstrap: false })[0]
    }

    const MAX_RESPONDED = 1000
    const RESPONDED_TTL_MS = 60 * 60 * 1000
    const responded = new Map<string, number>()
    const enableVersion = new Map<string, number>()
    const overrides = createModeOverrides()

    function pruneResponded(now: number) {
      for (const [id, ts] of responded) {
        if (now - ts < RESPONDED_TTL_MS) break
        responded.delete(id)
      }

      for (const id of responded.keys()) {
        if (responded.size <= MAX_RESPONDED) break
        responded.delete(id)
      }
    }

    const respond: PermissionRespondFn = (input) => {
      globalSDK.client.permission.respond(input).catch(() => {
        responded.delete(input.permissionID)
      })
    }

    function respondOnce(permission: PermissionRequest, directory?: string) {
      const now = Date.now()
      const hit = responded.has(permission.id)
      responded.delete(permission.id)
      responded.set(permission.id, now)
      pruneResponded(now)
      if (hit) return
      respond({
        sessionID: permission.sessionID,
        permissionID: permission.id,
        response: "once",
        directory,
      })
    }

    function prefModeOf(pref?: { autoAccept?: boolean; mode?: PermissionMode }) {
      const mode = resolveMode(pref)
      if (mode !== undefined) return mode
      if (pref?.autoAccept === false) return "off"
      return undefined
    }

    function prefMode(
      child: { session: readonly { id: string; parentID?: string }[]; preference: Record<string, SessionPreference> },
      sessionID: string,
    ) {
      return sessionLineage(child.session, sessionID)
        .map((id) => prefModeOf(child.preference[id]))
        .find((item) => item !== undefined)
    }

    function modeOf(sessionID: string, directory?: string): PermissionMode | undefined {
      const child = directory ? globalSync.child(directory, { bootstrap: false })[0] : current()
      const pref = (child.preference as Record<string, SessionPreference>)[sessionID]
      const override = overrides.get(sessionID, directory, pref?.mode)
      if (override !== undefined) return override
      const mode = prefMode(child, sessionID)
      if (mode !== undefined) return mode
      const legacy = sessionAcceptValue(store.autoAccept, [...child.session], sessionID, directory)
      if (legacy === undefined) return undefined
      return legacy ? "full" : "off"
    }

    function effectiveMode(sessionID?: string, directory?: string): PermissionMode {
      if (sessionID) return modeOf(sessionID, directory) ?? "off"
      const dir = directory ?? decode64(params.dir)
      if (dir && isDirectoryAutoAccepting(store.autoAccept, dir)) return "full"
      return settings.permissions.defaultPermissionMode()
    }

    function isAutoAccepting(sessionID: string, directory?: string) {
      return modeOf(sessionID, directory) === "full"
    }

    function isAutoAcceptingDirectory(directory: string) {
      return isDirectoryAutoAccepting(store.autoAccept, directory)
    }

    function shouldAutoRespond(permission: PermissionRequest, directory?: string) {
      const child = directory ? globalSync.child(directory, { bootstrap: false })[0] : current()
      const pref = (child.preference as Record<string, SessionPreference>)[permission.sessionID]
      const override = overrides.get(permission.sessionID, directory, pref?.mode)
      if (override !== undefined) return override === "full"
      const mode = prefMode(child, permission.sessionID)
      if (mode !== undefined) return mode === "full"
      return autoRespondsPermission(store.autoAccept, [...child.session], permission, directory, child.preference)
    }

    function bumpEnableVersion(sessionID: string, directory?: string) {
      const key = acceptKey(sessionID, directory)
      const next = (enableVersion.get(key) ?? 0) + 1
      enableVersion.set(key, next)
      return next
    }

    function sweepPending(sessionID: string, directory: string, key: string, version: number) {
      globalSDK.client.permission
        .list({ directory })
        .then((x) => {
          if (enableVersion.get(key) !== version) return
          if (!isAutoAccepting(sessionID, directory)) return
          for (const perm of x.data ?? []) {
            if (!perm?.id) continue
            if (!shouldAutoRespond(perm, directory)) continue
            respondOnce(perm, directory)
          }
        })
        .catch(() => undefined)
    }

    function setMode(sessionID: string, directory: string, mode: PermissionMode) {
      overrides.set(sessionID, directory, mode)
      const key = acceptKey(sessionID, directory)
      const version = bumpEnableVersion(sessionID, directory)
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = mode === "full"
          delete draft.autoAccept[sessionID]
        }),
      )

      globalSDK
        .createClient({ directory, throwOnError: true })
        .session.preference.update({ sessionID, mode })
        .catch(() => undefined)

      if (mode !== "full") return
      sweepPending(sessionID, directory, key, version)
    }

    const unsubscribe = globalSDK.event.listen((e) => {
      const event = e.details
      if (event?.type !== "permission.asked") return

      const perm = event.properties
      if (!shouldAutoRespond(perm, e.name)) return

      respondOnce(perm, e.name)
    })
    onCleanup(unsubscribe)

    function enableDirectory(directory: string) {
      const key = directoryAcceptKey(directory)
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = true
        }),
      )

      globalSDK.client.permission
        .list({ directory })
        .then((x) => {
          if (!isAutoAcceptingDirectory(directory)) return
          for (const perm of x.data ?? []) {
            if (!perm?.id) continue
            if (!shouldAutoRespond(perm, directory)) continue
            respondOnce(perm, directory)
          }
        })
        .catch(() => undefined)
    }

    function disableDirectory(directory: string) {
      const key = directoryAcceptKey(directory)
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = false
        }),
      )
    }

    function toggleDirectory(directory: string) {
      if (isDirectoryAutoAccepting(store.autoAccept, directory)) {
        disableDirectory(directory)
        return
      }
      enableDirectory(directory)
    }

    return {
      ready,
      respond,
      autoResponds(permission: PermissionRequest, directory?: string) {
        return shouldAutoRespond(permission, directory)
      },
      modeOf,
      effectiveMode,
      setMode,
      cycleMode(sessionID: string | undefined, directory: string): PermissionMode {
        if (!sessionID) {
          const active = isDirectoryAutoAccepting(store.autoAccept, directory)
          toggleDirectory(directory)
          return active ? "off" : "full"
        }

        const now = modeOf(sessionID, directory) ?? "off"
        const next = MODE_ORDER[(MODE_ORDER.indexOf(now) + 1) % MODE_ORDER.length]
        setMode(sessionID, directory, next)
        return next
      },
      isAutoAccepting,
      isAutoAcceptingDirectory,
      toggleAutoAcceptDirectory: toggleDirectory,
      enableAutoAccept(sessionID: string, directory: string) {
        if (modeOf(sessionID, directory) === "full") return
        setMode(sessionID, directory, "full")
      },
      permissionsEnabled,
      isPermissionAllowAll(directory: string) {
        const [childStore] = globalSync.child(directory)
        const perm = childStore.config.permission
        return typeof perm === "string" && perm === "allow"
      },
    }
  },
})
