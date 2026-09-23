import type { Notification } from "./notification"

export type { Notification }

const SUMMARY_MAX = 80
const GLOBAL_SESSION = "global"

const clamp = (text: string) => (text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text)

export const errorText = (notification: Notification | undefined) => {
  if (!notification || notification.type !== "error") return ""
  const err = notification.error
  if (typeof err === "string") return clamp(err)
  const message = (err?.data as { message?: unknown } | undefined)?.message
  const text = typeof message === "string" ? message : ""
  if (text && err?.name) return clamp(`${err.name}: ${text}`)
  return clamp(text || err?.name || "")
}

export const zombieTargets = (list: Notification[]) => {
  const groups = new Map<string, Set<string>>()
  list.forEach((notification) => {
    if (notification.viewed) return
    if (!notification.directory) return
    if (!notification.session || notification.session === GLOBAL_SESSION) return
    const ids = groups.get(notification.directory) ?? new Set<string>()
    ids.add(notification.session)
    groups.set(notification.directory, ids)
  })
  return groups
}
