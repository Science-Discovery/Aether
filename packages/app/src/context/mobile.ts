import { createSignal } from "solid-js"

export type MobilePlatform = "feishu" | "qq" | "wechat"

export type MobileStatus =
  | "idle"
  | "loading"
  | "config"
  | "qrcode"
  | "connected"
  | "reconnecting"
  | "error"
  | "locked"
  | "stolen"

interface PlatformState {
  status: MobileStatus
  error: { code: string; message: string } | null
  user: { id: string; name: string } | null
  loadingMsg: string
  qrcode: string | null
  locked: boolean
  hasConfig: boolean
  appId: string | null
}

const defaults: PlatformState = {
  status: "idle",
  error: null,
  user: null,
  loadingMsg: "",
  qrcode: null,
  locked: false,
  hasConfig: false,
  appId: null,
}

const [state, setState] = createSignal<Record<MobilePlatform, PlatformState>>({
  feishu: { ...defaults, loadingMsg: "正在连接飞书..." },
  qq: { ...defaults, loadingMsg: "正在连接QQ..." },
  wechat: { ...defaults, loadingMsg: "正在启动微信桥接..." },
})

const pState = (p: MobilePlatform) => state()[p]

export const status = (p: MobilePlatform) => pState(p).status
export const error = (p: MobilePlatform) => pState(p).error
export const user = (p: MobilePlatform) => pState(p).user
export const loadingMsg = (p: MobilePlatform) => pState(p).loadingMsg
export const qrcode = (p: MobilePlatform) => pState(p).qrcode
export const locked = (p: MobilePlatform) => pState(p).locked
export const hasConfig = (p: MobilePlatform) => pState(p).hasConfig
export const appId = (p: MobilePlatform) => pState(p).appId

export function setStatus(p: MobilePlatform, s: MobileStatus) {
  setState((prev) => ({ ...prev, [p]: { ...prev[p], status: s } }))
}

const patch = (p: MobilePlatform, u: Partial<PlatformState>) => {
  setState((prev) => ({ ...prev, [p]: { ...prev[p], ...u } }))
}

const updateStatus = (p: MobilePlatform, s: MobileStatus) => {
  const msg = p === "feishu" ? "正在连接飞书..." : p === "qq" ? "正在连接QQ..." : "正在启动微信桥接..."
  patch(p, { status: s, loadingMsg: s !== "loading" ? msg : prev(p).loadingMsg })
}

function prev(p: MobilePlatform) {
  return state()[p]
}

interface MobileEvent {
  type: string
  properties: {
    status?: MobileStatus | "starting"
    message?: string
    appId?: string
    image?: string
    user?: { id: string; name: string }
    code?: string
  }
}

const sseControllers: Record<MobilePlatform, AbortController | null> = { feishu: null, qq: null, wechat: null }
const sseRetryTimers: Record<MobilePlatform, ReturnType<typeof setTimeout> | undefined> = {
  feishu: undefined,
  qq: undefined,
  wechat: undefined,
}
const pingTimer: ReturnType<typeof setInterval> | undefined = undefined
let clientId: string | null = null
let pingInterval: ReturnType<typeof setInterval> | undefined
let pingFails = 0

type Resolver = () => { url: string; headers: HeadersInit }
let resolve: Resolver | null = null

export function bindResolver(r: Resolver) {
  resolve = r
}

const api = () => {
  if (!resolve) throw new Error("mobile resolver not bound")
  return resolve()
}

function connectSSE(p: MobilePlatform) {
  const abort = sseControllers[p]
  if (abort) abort.abort()
  const retry = sseRetryTimers[p]
  if (retry !== undefined) {
    clearTimeout(retry)
    sseRetryTimers[p] = undefined
  }
  sseControllers[p] = new AbortController()

  void (async () => {
    try {
      const { url, headers } = api()
      const prefix = `/mobile/${p}`
      const sseUrl =
        p === "wechat" && clientId
          ? `${url}${prefix}/events?clientId=${encodeURIComponent(clientId)}`
          : `${url}${prefix}/events`
      const response = await fetch(sseUrl, {
        headers: { ...headers, Accept: "text/event-stream" },
        signal: sseControllers[p]!.signal,
      })
      if (!response.ok || !response.body) {
        const s = prev(p).status
        if (s !== "idle" && s !== "error" && s !== "stolen") updateStatus(p, "reconnecting")
        scheduleSseRetry(p)
        return
      }

      if (prev(p).status === "reconnecting") updateStatus(p, "connected")

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const raw = line.slice(5).trim()
          if (!raw) continue
          try {
            const event: MobileEvent = JSON.parse(raw)
            const type = event.type
            const props = event.properties

            if (type.endsWith(".qrcode") && props.image) {
              patch(p, { qrcode: props.image, status: "qrcode" })
            } else if (type.endsWith(".connected")) {
              const u: Partial<PlatformState> = { status: "connected", error: null }
              if (props.appId) u.appId = props.appId
              if (props.user) u.user = props.user
              patch(p, u)
              setAutoConnect(p, true)
              clearSseRetry(p)
            } else if (type.endsWith(".reconnecting")) {
              updateStatus(p, "reconnecting")
              patch(p, {
                loadingMsg:
                  p === "feishu"
                    ? "飞书连接中断，正在自动重连..."
                    : p === "qq"
                      ? "QQ连接中断，正在自动重连..."
                      : "正在重新连接微信...",
              })
            } else if (type.endsWith(".error")) {
              patch(p, {
                error: { code: props.code || "unknown", message: props.message || "未知错误" },
                status: "error",
              })
            } else if (type.endsWith(".status") && props.status) {
              const s = props.status === "starting" ? "loading" : (props.status as MobileStatus)
              const cur = prev(p).status
              if (
                s === "idle" &&
                (cur === "loading" ||
                  cur === "reconnecting" ||
                  cur === "qrcode" ||
                  cur === "connected" ||
                  cur === "config")
              )
                continue
              const u: Partial<PlatformState> = { status: s }
              if (props.message) u.loadingMsg = props.message
              if (props.appId) u.appId = props.appId
              if (props.user) u.user = props.user
              if (s === "connected") clearSseRetry(p)
              patch(p, u)
            }
          } catch {}
        }
      }

      const s = prev(p).status
      if (p === "wechat") {
        if (s !== "idle" && s !== "error" && s !== "stolen") scheduleSseRetry(p)
      } else if (s !== "idle" && s !== "error" && s !== "stolen") {
        updateStatus(p, "reconnecting")
        scheduleSseRetry(p)
      }
    } catch {
      const s = prev(p).status
      if (p === "wechat") {
        if (s !== "idle" && s !== "error" && s !== "stolen") scheduleSseRetry(p)
      } else if (s !== "idle" && s !== "error" && s !== "stolen") {
        updateStatus(p, "reconnecting")
        scheduleSseRetry(p)
      }
    }
  })()
}

function clearSseRetry(p: MobilePlatform) {
  const t = sseRetryTimers[p]
  if (t !== undefined) {
    clearTimeout(t)
    sseRetryTimers[p] = undefined
  }
}

function scheduleSseRetry(p: MobilePlatform) {
  if (sseRetryTimers[p] !== undefined) return
  sseRetryTimers[p] = setTimeout(() => {
    sseRetryTimers[p] = undefined
    const s = prev(p).status
    if (s !== "idle" && s !== "error" && s !== "stolen") connectSSE(p)
  }, 3000)
}

function startPing(p: MobilePlatform) {
  if (p !== "wechat") return
  stopPing()
  pingInterval = setInterval(async () => {
    if (!clientId) return
    try {
      const { url, headers } = api()
      const res = await fetch(`${url}/mobile/wechat/ping`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ clientId }),
      })
      const data = await res.json()
      pingFails = 0
      if (data.stolen) {
        stopPing()
        if (sseControllers.wechat) {
          sseControllers.wechat.abort()
          sseControllers.wechat = null
        }
        clearSseRetry("wechat")
        patch("wechat", { status: "stolen" })
      }
    } catch {
      pingFails += 1
      if (pingFails < 3) return
      pingFails = 0
      const s = prev("wechat").status
      if (s !== "idle" && s !== "stolen") patch("wechat", { status: "reconnecting" })
    }
  }, 10_000)
}

function stopPing() {
  if (pingInterval !== undefined) {
    clearInterval(pingInterval)
    pingInterval = undefined
  }
}

const STORAGE_KEY = (p: MobilePlatform) => `opencode:mobile:autoConnect:${p}`

const [autoConnectState, setAutoConnectState] = createSignal<Record<MobilePlatform, boolean>>({
  feishu: localStorage.getItem(STORAGE_KEY("feishu")) === "true",
  qq: localStorage.getItem(STORAGE_KEY("qq")) === "true",
  wechat: localStorage.getItem(STORAGE_KEY("wechat")) === "true",
})

export function autoConnect(p: MobilePlatform) {
  return autoConnectState()[p]
}

export function setAutoConnect(p: MobilePlatform, v: boolean) {
  if (v) localStorage.setItem(STORAGE_KEY(p), "true")
  else localStorage.removeItem(STORAGE_KEY(p))
  setAutoConnectState((prev) => ({ ...prev, [p]: v }))
}

export async function fetchStatus(p: MobilePlatform) {
  const { url, headers } = api()
  try {
    const prefix = `/mobile/${p}`
    const response = await fetch(`${url}${prefix}/status`, { headers })
    const data = await response.json()
    if (p === "wechat" && data.locked && data.status !== "idle" && data.lockHolder !== clientId) {
      patch("wechat", { locked: true, user: data.user || prev("wechat").user })
      return
    }
    if (p === "wechat") patch("wechat", { locked: false, hasConfig: data.hasConfig })
    if (p === "feishu") patch("feishu", { hasConfig: data.hasConfig })
    if (p === "qq") patch("qq", { hasConfig: data.hasConfig })
    if (data.status === "connected") {
      const u: Partial<PlatformState> = { status: "connected" }
      if (data.appId) u.appId = data.appId
      if (data.user) u.user = data.user
      patch(p, u)
      setAutoConnect(p, true)
      startPing(p)
      connectSSE(p)
    } else if (data.status === "qrcode" && data.qrcode) {
      patch(p, { qrcode: data.qrcode, status: "qrcode" })
      startPing(p)
      connectSSE(p)
    } else if (data.status === "reconnecting") {
      patch(p, { status: "reconnecting" })
      connectSSE(p)
    } else if (data.error) {
      patch(p, { error: data.error, status: "error" })
    } else if (p === "feishu" && data.hasConfig) {
      patch("feishu", { status: "idle" })
    } else if (p === "qq" && data.hasConfig) {
      patch("qq", { status: "idle" })
    } else if (p === "wechat" && data.hasConfig && data.status === "idle") {
      patch("wechat", { status: "idle", user: data.user })
    }
  } catch {}
}

export async function startBridge(
  p: MobilePlatform,
  auto = false,
  modelStr?: string,
  force = false,
  appIdVal?: string,
  appSecretVal?: string,
  rescan = false,
) {
  patch(p, {
    status: "loading",
    loadingMsg: p === "feishu" ? "正在连接飞书..." : p === "qq" ? "正在连接QQ..." : "正在启动微信桥接...",
    error: null,
    locked: false,
  })

  if (p === "wechat") clientId = clientId || crypto.randomUUID()

  connectSSE(p)

  try {
    const { url, headers } = api()
    const prefix = `/mobile/${p}`
    const body: any = {}

    if (p === "feishu" || p === "qq") {
      if (appIdVal && appSecretVal) {
        body.appId = appIdVal
        body.appSecret = appSecretVal
      }
    } else {
      body.clientId = clientId
      body.autoInstall = auto
      body.force = force
      body.rescan = rescan
      if (modelStr) body.model = modelStr
    }

    const response = await fetch(`${url}${prefix}/start`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const data = await response.json()

    if (!data.success) {
      if (data.code === "locked") {
        patch("wechat", { locked: true, status: "idle" })
        return
      }
      if (data.code === "config_missing") {
        patch(p === "feishu" ? "feishu" : p === "qq" ? "qq" : "feishu", { status: "config" })
        return
      }
      patch(p, {
        error: { code: data.code || "start_failed", message: data.message || "连接失败" },
        status: "error",
      })
      return
    }

    if (p === "wechat") clientId = data.clientId || clientId

    if (data.status === "connected" && data.user) {
      patch(p, { user: data.user, status: "connected" })
      setAutoConnect(p, true)
      startPing(p)
      return
    }

    startPing(p)
  } catch (err) {
    patch(p, { error: { code: "network_error", message: String(err) }, status: "error" })
  }
}

export async function stopBridge(p: MobilePlatform) {
  setAutoConnect(p, false)
  const abort = sseControllers[p]
  if (abort) {
    abort.abort()
    sseControllers[p] = null
  }
  clearSseRetry(p)
  if (p === "wechat") stopPing()
  try {
    const { url, headers } = api()
    const prefix = `/mobile/${p}`
    const body: any = {}
    if (p === "wechat" && clientId) body.clientId = clientId
    await fetch(`${url}${prefix}/stop`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch {}
  if (p === "wechat") clientId = null
  patch(p, { status: "idle", qrcode: null })
}

export async function logout(p: MobilePlatform) {
  const abort = sseControllers[p]
  if (abort) {
    abort.abort()
    sseControllers[p] = null
  }
  clearSseRetry(p)
  if (p === "wechat") stopPing()
  const { url, headers } = api()
  const prefix = `/mobile/${p}`
  const stopBody: any = {}
  if (p === "wechat" && clientId) stopBody.clientId = clientId
  await fetch(`${url}${prefix}/stop`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(stopBody),
  })
  await fetch(`${url}${prefix}/session`, { method: "DELETE", headers })
  if (p === "wechat") clientId = null
  patch(p, { user: null, appId: null, hasConfig: false, status: "idle", qrcode: null })
}

export async function retryBridge(p: MobilePlatform) {
  if (p === "wechat") return startBridge(p)
  if (p === "qq") return startBridge(p)
  patch(p, { status: "reconnecting", loadingMsg: "正在重新连接飞书...", error: null })
  patch(p, { status: "reconnecting", loadingMsg: "正在重新连接微信...", error: null })
  connectSSE(p)
  try {
    const { url, headers } = api()
    const res = await fetch(`${url}/mobile/wechat/retry`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
    })
    const data = await res.json()
    if (!data.success) {
      patch("wechat", { error: { code: "retry_failed", message: data.message || "重连失败" }, status: "error" })
    }
  } catch (err) {
    patch("wechat", { error: { code: "network_error", message: String(err) }, status: "error" })
  }
}

export async function rescanBridge(p: MobilePlatform) {
  if (p !== "wechat") return
  await stopBridge("wechat")
  return startBridge("wechat", true, undefined, false, undefined, undefined, true)
}

export async function forceTakeover(p: MobilePlatform, modelStr?: string) {
  return startBridge(p, true, modelStr, true)
}

export function initMobile(p: MobilePlatform) {
  if (p === "wechat") {
    window.addEventListener("pagehide", () => {
      if (!clientId) return
      try {
        const { url } = api()
        navigator.sendBeacon(
          `${url}/mobile/wechat/stop`,
          new Blob([JSON.stringify({ clientId })], { type: "application/json" }),
        )
      } catch {}
    })
  }
  fetchStatus(p).then(() => {
    if (autoConnect(p) && hasConfig(p) && status(p) === "idle") {
      startBridge(p)
    }
  })
}
