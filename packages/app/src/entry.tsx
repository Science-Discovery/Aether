// @refresh reload

import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { base } from "@/base-path"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { createWebUpdate } from "@/utils/web-update"
import { handleNotificationClick } from "@/utils/notification-click"
import { ServerConnection } from "./context/server"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"
const PROXY_KEY = "opencode.settings.dat:proxy"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)
const readProxy = () => {
  const raw = getStorage(PROXY_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    const enabled = typeof parsed.enabled === "boolean" ? parsed.enabled : false
    const http =
      parsed.http && typeof parsed.http === "object"
        ? {
            host: typeof parsed.http.host === "string" ? parsed.http.host : "",
            port: typeof parsed.http.port === "number" ? parsed.http.port : 8080,
          }
        : null
    const https =
      parsed.https && typeof parsed.https === "object"
        ? {
            host: typeof parsed.https.host === "string" ? parsed.https.host : "",
            port: typeof parsed.https.port === "number" ? parsed.https.port : 8080,
          }
        : null
    if (http && https) return { enabled, http, https }
    const host = typeof parsed.host === "string" ? parsed.host : ""
    const scheme = parsed.scheme === "https" ? "https" : "http"
    return {
      enabled,
      http: {
        host: scheme === "http" ? host : "",
        port: typeof parsed.port === "number" ? parsed.port : 8080,
      },
      https: {
        host: scheme === "https" ? host : "",
        port: typeof parsed.port === "number" ? parsed.port : 8080,
      },
    }
  } catch {
    return null
  }
}
const writeProxy = (proxy: {
  enabled: boolean
  http: { host: string; port: number }
  https: { host: string; port: number }
}) => setStorage(PROXY_KEY, JSON.stringify(proxy))

const hosted = (proxy: { http: { host: string }; https: { host: string } }) =>
  !!(proxy.http.host.trim() || proxy.https.host.trim())

const empty = (proxy: { enabled: boolean; http: { host: string }; https: { host: string } }) =>
  !proxy.enabled && !hosted(proxy)

const notify: Platform["notify"] = async (title, description, href) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "https://opencode.ai/favicon-96x96-v3.png",
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  return
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  const bp = base()
  return bp === "/" ? location.origin : `${location.origin}${bp}`
}

const endpoint = (path: string) => new URL(path.replace(/^\/+/, ""), `${getCurrentUrl().replace(/\/+$/, "")}/`)

const readWebVersion = async () => {
  return fetch(endpoint("/global/web-update/current"))
    .then((res) => (res.ok ? res.json() : null))
    .then((data: unknown) => {
      if (!data || typeof data !== "object") return ""
      const version = (data as Record<string, unknown>).currentVersion
      if (typeof version !== "string") return ""
      return version.trim()
    })
    .catch(() => "")
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const req = async (path: string, init?: RequestInit) => {
  const res = await fetch(endpoint(path), init)
  if (res.ok) return res
  throw new Error(`Request failed: ${res.status}`)
}

const push = async (proxy: {
  enabled: boolean
  http: { host: string; port: number }
  https: { host: string; port: number }
}) => {
  await req("/global/proxy", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proxy),
  })
}

const sync = async () => {
  const local = readProxy()
  if (!local) return
  if (!local.enabled || !hosted(local)) return
  await push(local).catch(() => undefined)
}

const lease = (() => {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
})()

const ping = async (alive = true) => {
  await req("/global/ping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: lease, alive }),
  }).catch(() => undefined)
}

const release = () => {
  const url = endpoint("/global/ping").toString()
  const body = JSON.stringify({ id: lease, alive: false })
  if (navigator.sendBeacon) {
    const data = new Blob([body], { type: "application/json" })
    if (navigator.sendBeacon(url, data)) return
  }
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => undefined)
}

const start = () => {
  void ping()
  const timer = setInterval(() => {
    void ping()
  }, 10_000)
  const hide = () => release()
  const focus = () => {
    if (document.visibilityState !== "visible") return
    void ping()
  }
  window.addEventListener("pagehide", hide)
  document.addEventListener("visibilitychange", focus)
  return () => {
    clearInterval(timer)
    window.removeEventListener("pagehide", hide)
    document.removeEventListener("visibilitychange", focus)
  }
}

const detectOS = (): string => {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes("mac")) return "darwin"
  if (ua.includes("win")) return "windows"
  return "linux"
}
const web = createWebUpdate(req, detectOS)

const platform: Platform = {
  platform: "web",
  version: undefined,
  openLink,
  back,
  forward,
  restart,
  notify,
  checkUpdate: async () => {
    const data = await web.check()
    return {
      updateAvailable: data.updateAvailable,
      currentVersion: data.currentVersion,
      version: data.version,
      downloaded: data.downloaded,
      status: data.status,
      updateError: data.updateError,
      updateAction: data.updateAction,
    }
  },
  downloadUpdate: web.downloadUpdate,
  update: async () => {
    const result = await web.update()
    if (result?.kind === "mirror") {
      return platform.retryUpdateMirror?.()
    }
    if (result?.kind === "recover") {
      return platform.recoverUpdate?.()
    }
  },
  recoverUpdate: web.recoverUpdate,
  retryUpdateMirror: web.retryUpdateMirror,
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
  getProxyConfig: async () => {
    const local = readProxy()
    const fallback = local ?? {
      enabled: false,
      http: { host: "", port: 8080 },
      https: { host: "", port: 8080 },
    }

    return req("/global/proxy")
      .then((res) => res.json())
      .then(async (next) => {
        if (local && empty(next)) {
          writeProxy(local)
          if (!local.enabled || !hosted(local)) return local
          await req("/global/proxy", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(local),
          }).catch(() => undefined)
          return local
        }
        writeProxy(next)
        return next
      })
      .catch(() => fallback)
  },
  setProxyConfig: async (config) => {
    await push(config)
    writeProxy(config)
  },
}

const boot = async () => {
  if (!(root instanceof HTMLElement)) return
  platform.version = (await readWebVersion()) || undefined
  let stop = start()
  await sync()
  const server: ServerConnection.Http = { type: "http", http: { url: getCurrentUrl() } }
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface
            defaultServer={ServerConnection.Key.make(getDefaultUrl())}
            servers={[server]}
            disableHealthCheck
            basePath={base()}
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
  window.addEventListener("pagehide", () => {
    stop()
  })
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return
    stop = start()
  })
}

void boot()
