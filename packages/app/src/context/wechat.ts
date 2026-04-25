import { createSignal } from "solid-js"

export type WeChatStatus = "idle" | "loading" | "qrcode" | "connected" | "reconnecting" | "stolen" | "error"

interface WeChatEvent {
  type: string
  properties: {
    status?: WeChatStatus | "starting"
    message?: string
    image?: string
    user?: { id: string; name: string }
    code?: string
  }
}

const [status, setStatus] = createSignal<WeChatStatus>("idle")
const [qrcode, setQrcode] = createSignal<string | null>(null)
const [error, setError] = createSignal<{ code: string; message: string } | null>(null)
const [user, setUser] = createSignal<{ id: string; name: string } | null>(null)
const [loadingMsg, setLoadingMsg] = createSignal<string>("Starting WeChat bridge...")
const [locked, setLocked] = createSignal(false)

export { status, qrcode, error, user, loadingMsg, locked }

let clientId: string | null = null
let sseAbort: AbortController | null = null
let pingTimer: ReturnType<typeof setInterval> | undefined
let sseRetryTimer: ReturnType<typeof setTimeout> | undefined
let initialized = false

type Resolver = () => { url: string; headers: HeadersInit }
let resolve: Resolver | null = null

export function bindWechatResolver(r: Resolver) {
  resolve = r
}

const api = () => {
  if (!resolve) throw new Error("wechat resolver not bound")
  return resolve()
}

const updateStatus = (s: WeChatStatus) => {
  setStatus(s)
  if (s !== "loading") setLoadingMsg("Starting WeChat bridge...")
}

function connectSSE() {
  if (sseAbort) sseAbort.abort()
  if (sseRetryTimer !== undefined) {
    clearTimeout(sseRetryTimer)
    sseRetryTimer = undefined
  }
  sseAbort = new AbortController()

  void (async () => {
    try {
      const { url, headers } = api()
      const sseUrl = clientId ? `${url}/wechat/events?clientId=${encodeURIComponent(clientId)}` : `${url}/wechat/events`
      const response = await fetch(sseUrl, {
        headers: { ...headers, Accept: "text/event-stream" },
        signal: sseAbort!.signal,
      })
      if (!response.ok || !response.body) {
        if (status() !== "idle" && status() !== "error" && status() !== "stolen") updateStatus("reconnecting")
        scheduleSseRetry()
        return
      }

      if (status() === "reconnecting") updateStatus("connected")

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
            const event: WeChatEvent = JSON.parse(raw)
            if (event.type === "wechat.qrcode" && event.properties.image) {
              setQrcode(event.properties.image)
              updateStatus("qrcode")
            } else if (event.type === "wechat.connected" && event.properties.user) {
              setUser(event.properties.user)
              updateStatus("connected")
            } else if (event.type === "wechat.error") {
              setError({
                code: event.properties.code || "unknown",
                message: event.properties.message || "Unknown error",
              })
              updateStatus("error")
            } else if (event.type === "wechat.status" && event.properties.status) {
              const s = event.properties.status === "starting" ? "loading" : event.properties.status
              updateStatus(s as WeChatStatus)
              if (event.properties.message) setLoadingMsg(event.properties.message)
            }
          } catch {}
        }
      }

      if (status() !== "idle" && status() !== "error" && status() !== "stolen") {
        updateStatus("reconnecting")
        scheduleSseRetry()
      }
    } catch {
      if (status() !== "idle" && status() !== "error" && status() !== "stolen") {
        updateStatus("reconnecting")
        scheduleSseRetry()
      }
    }
  })()
}

function scheduleSseRetry() {
  if (sseRetryTimer !== undefined) return
  sseRetryTimer = setTimeout(() => {
    sseRetryTimer = undefined
    if (status() !== "idle" && status() !== "error" && status() !== "stolen") connectSSE()
  }, 3000)
}

function startPing() {
  stopPing()
  pingTimer = setInterval(async () => {
    if (!clientId) return
    try {
      const { url, headers } = api()
      const res = await fetch(`${url}/wechat/ping`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ clientId }),
      })
      const data = await res.json()
      if (data.stolen) {
        stopPing()
        if (sseAbort) {
          sseAbort.abort()
          sseAbort = null
        }
        if (sseRetryTimer !== undefined) {
          clearTimeout(sseRetryTimer)
          sseRetryTimer = undefined
        }
        updateStatus("stolen")
      }
    } catch {
      if (status() !== "idle" && status() !== "stolen") {
        updateStatus("reconnecting")
      }
    }
  }, 10_000)
}

function stopPing() {
  if (pingTimer !== undefined) {
    clearInterval(pingTimer)
    pingTimer = undefined
  }
}

export async function fetchStatus() {
  const { url, headers } = api()
  try {
    const response = await fetch(`${url}/wechat/status`, { headers })
    const data = await response.json()
    if (data.locked && data.status !== "idle" && data.lockHolder !== clientId) {
      setLocked(true)
      if (data.user) setUser(data.user)
      return
    }
    setLocked(false)
    if (data.status === "connected" && data.user) {
      updateStatus("connected")
      setUser(data.user)
      startPing()
      connectSSE()
    } else if (data.status === "qrcode" && data.qrcode) {
      updateStatus("qrcode")
      setQrcode(data.qrcode)
      startPing()
      connectSSE()
    } else if (data.error) {
      setError(data.error)
      updateStatus("error")
    }
  } catch {}
}

export async function startBridge(auto = false, modelStr?: string, force = false) {
  updateStatus("loading")
  setLoadingMsg("Starting WeChat bridge...")
  setError(null)
  setLocked(false)

  clientId = clientId || crypto.randomUUID()

  try {
    const { url, headers } = api()
    const response = await fetch(`${url}/wechat/start`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelStr, autoInstall: auto, clientId, force }),
    })
    const data = await response.json()

    if (!data.success) {
      if (data.code === "locked") {
        setLocked(true)
        updateStatus("idle")
        return
      }
      setError({ code: data.code || "start_failed", message: data.message || "Failed to start WeChat bridge" })
      updateStatus("error")
      return
    }

    clientId = data.clientId || clientId

    if (data.status === "connected" && data.user) {
      setUser(data.user)
      updateStatus("connected")
      connectSSE()
      startPing()
      return
    }

    connectSSE()
    startPing()
  } catch (err) {
    setError({ code: "network_error", message: String(err) })
    updateStatus("error")
  }
}

export async function stopBridge() {
  if (sseAbort) {
    sseAbort.abort()
    sseAbort = null
  }
  if (sseRetryTimer !== undefined) {
    clearTimeout(sseRetryTimer)
    sseRetryTimer = undefined
  }
  stopPing()
  try {
    const { url, headers } = api()
    await fetch(`${url}/wechat/stop`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId }),
    })
  } catch {}
  clientId = null
  updateStatus("idle")
  setQrcode(null)
}

export async function logout() {
  if (sseAbort) {
    sseAbort.abort()
    sseAbort = null
  }
  if (sseRetryTimer !== undefined) {
    clearTimeout(sseRetryTimer)
    sseRetryTimer = undefined
  }
  stopPing()
  const { url, headers } = api()
  await fetch(`${url}/wechat/stop`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ clientId }),
  })
  await fetch(`${url}/wechat/session`, { method: "DELETE", headers })
  clientId = null
  setUser(null)
  updateStatus("idle")
  setQrcode(null)
}

export function forceTakeover(modelStr?: string) {
  return startBridge(true, modelStr, true)
}

export function initWechat() {
  if (initialized) return
  initialized = true
  window.addEventListener("pagehide", () => {
    if (!clientId) return
    try {
      const { url } = api()
      navigator.sendBeacon(`${url}/wechat/stop`, new Blob([JSON.stringify({ clientId })], { type: "application/json" }))
    } catch {}
  })
  fetchStatus()
}
