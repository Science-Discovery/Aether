// @refresh reload

import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import pkg from "../package.json"
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
  window.location.reload()
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const req = async (path: string, init?: RequestInit) => {
  const res = await fetch(new URL(path, getCurrentUrl()), init)
  if (res.ok) return res
  throw new Error(`Request failed: ${res.status}`)
}

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink,
  back,
  forward,
  restart,
  notify,
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
  getProxyConfig: async () => {
    const local = readProxy()
    return req("/global/proxy")
      .then((res) => res.json())
      .then((next) => {
        writeProxy(next)
        return next
      })
      .catch(() => {
        return (
          local ?? {
            enabled: false,
            http: { host: "", port: 8080 },
            https: { host: "", port: 8080 },
          }
        )
      })
  },
  setProxyConfig: async (config) => {
    await req("/global/proxy", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    })
    writeProxy(config)
  },
}

if (root instanceof HTMLElement) {
  const server: ServerConnection.Http = { type: "http", http: { url: getCurrentUrl() } }
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface
            defaultServer={ServerConnection.Key.make(getDefaultUrl())}
            servers={[server]}
            disableHealthCheck
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
