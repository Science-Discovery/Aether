import { createStore } from "solid-js/store"

export type MobilePlatform = "feishu" | "qq" | "wechat"

export type MobileStatus = "idle" | "loading" | "config" | "qrcode" | "connected" | "reconnecting" | "error"

interface PlatformState {
  status: MobileStatus
  error: { code: string; message: string } | null
  user: { id: string; name: string } | null
  loadingMsg: string
  qrcode: string | null
  hasConfig: boolean
  enabled: boolean
  appId: string | null
}

function defaults(loadingMsg: string): PlatformState {
  return {
    status: "idle",
    error: null,
    user: null,
    loadingMsg,
    qrcode: null,
    hasConfig: false,
    enabled: false,
    appId: null,
  }
}

const [state, setState] = createStore<Record<MobilePlatform, PlatformState>>({
  feishu: defaults("正在连接飞书..."),
  qq: defaults("正在连接QQ..."),
  wechat: defaults("正在启动微信桥接..."),
})

export const status = (p: MobilePlatform) => state[p].status
export const error = (p: MobilePlatform) => state[p].error
export const user = (p: MobilePlatform) => state[p].user
export const loadingMsg = (p: MobilePlatform) => state[p].loadingMsg
export const qrcode = (p: MobilePlatform) => state[p].qrcode
export const hasConfig = (p: MobilePlatform) => state[p].hasConfig
export const enabled = (p: MobilePlatform) => state[p].enabled
export const appId = (p: MobilePlatform) => state[p].appId

export function setStatus(p: MobilePlatform, s: MobileStatus) {
  setState(p, "status", s)
}

const patch = (p: MobilePlatform, u: Partial<PlatformState>) => setState(p, u)

type Resolver = () => { url: string; headers: HeadersInit }
let resolve: Resolver | null = null

export function bindResolver(r: Resolver) {
  resolve = r
}

const api = () => {
  if (!resolve) throw new Error("mobile resolver not bound")
  return resolve()
}

type Emitter = {
  listen: (cb: (e: { name: string; details: { type: string; properties: any } }) => void) => () => void
}

let bound = false

export function bindEmitter(e: Emitter) {
  if (bound) return
  bound = true
  e.listen((ev) => {
    const type = ev.details.type as string
    for (const p of ["wechat", "feishu", "qq"] as const) {
      if (type.startsWith(`${p}.`)) {
        handleMobileEvent(p, type, ev.details.properties)
        return
      }
    }
  })
}

function handleMobileEvent(p: MobilePlatform, type: string, props: any) {
  if (type.endsWith(".qrcode") && props.image) {
    patch(p, { qrcode: props.image, status: "qrcode" })
  } else if (type.endsWith(".connected")) {
    const u: Partial<PlatformState> = { status: "connected", error: null, enabled: true }
    if (props.appId) u.appId = props.appId
    if (props.user) u.user = props.user
    patch(p, u)
  } else if (type.endsWith(".reconnecting")) {
    patch(p, {
      status: "reconnecting",
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
    if (s === "idle" && state[p].status !== "idle" && state[p].status !== "error") return
    const u: Partial<PlatformState> = { status: s }
    if (props.message) u.loadingMsg = props.message
    if (props.appId) u.appId = props.appId
    if (props.user) u.user = props.user
    patch(p, u)
  }
}

export async function fetchStatus(p: MobilePlatform) {
  const { url, headers } = api()
  try {
    const prefix = `/mobile/${p}`
    const response = await fetch(`${url}${prefix}/status`, { headers })
    const data = await response.json()
    if (p === "wechat") patch("wechat", { hasConfig: data.hasConfig })
    if (p === "feishu") patch("feishu", { hasConfig: data.hasConfig })
    if (p === "qq") patch("qq", { hasConfig: data.hasConfig })
    const base: Partial<PlatformState> = { enabled: data.enabled === true }
    if (data.status === "connected") {
      const u: Partial<PlatformState> = { ...base, status: "connected" }
      if (data.appId) u.appId = data.appId
      if (data.user) u.user = data.user
      patch(p, u)
    } else if (data.status === "qrcode" && data.qrcode) {
      patch(p, { ...base, qrcode: data.qrcode, status: "qrcode" })
    } else if (data.status === "reconnecting") {
      patch(p, { ...base, status: "reconnecting" })
    } else if (data.error) {
      patch(p, { ...base, error: data.error, status: "error" })
    } else if (data.status === "idle" && data.hasConfig) {
      patch(p, { ...base, status: "idle", user: data.user })
    } else {
      patch(p, base)
    }
  } catch {}
}

export async function startBridge(p: MobilePlatform, appIdVal?: string, appSecretVal?: string, rescan = false) {
  patch(p, {
    status: "loading",
    loadingMsg: p === "feishu" ? "正在连接飞书..." : p === "qq" ? "正在连接QQ..." : "正在启动微信桥接...",
    error: null,
  })

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
      body.rescan = rescan
    }

    const response = await fetch(`${url}${prefix}/start`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const data = await response.json()

    if (!data.success) {
      if (data.code === "config_missing") {
        patch(p, { status: "config" })
        return
      }
      patch(p, {
        error: { code: data.code || "start_failed", message: data.message || "连接失败" },
        status: "error",
      })
      return
    }

    if (data.status === "connected" && data.user) {
      patch(p, { user: data.user, status: "connected", enabled: true })
      return
    }

    patch(p, { enabled: true })
    void fetchStatus(p)
  } catch (err) {
    patch(p, { error: { code: "network_error", message: String(err) }, status: "error" })
  }
}

export async function stopBridge(p: MobilePlatform) {
  try {
    const { url, headers } = api()
    const prefix = `/mobile/${p}`
    await fetch(`${url}${prefix}/stop`, { method: "POST", headers })
  } catch {}
  patch(p, { status: "idle", qrcode: null, enabled: false })
}

export async function logout(p: MobilePlatform) {
  const { url, headers } = api()
  const prefix = `/mobile/${p}`
  try {
    await fetch(`${url}${prefix}/stop`, { method: "POST", headers })
    await fetch(`${url}${prefix}/session`, { method: "DELETE", headers })
  } catch {}
  patch(p, { user: null, appId: null, hasConfig: false, status: "idle", qrcode: null, enabled: false })
}

export async function retryBridge(p: MobilePlatform) {
  return startBridge(p)
}

export async function rescanBridge(p: MobilePlatform) {
  if (p !== "wechat") return
  await stopBridge("wechat")
  return startBridge("wechat", undefined, undefined, true)
}

export function initMobile(p: MobilePlatform) {
  void fetchStatus(p)
}
