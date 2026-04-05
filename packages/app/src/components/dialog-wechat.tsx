import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Component, Show, Switch, Match, createSignal, onCleanup, onMount } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { setWechatStatus } from "@/context/wechat"
import { useModels } from "@/context/models"

type WeChatStatus = "idle" | "loading" | "qrcode" | "connected" | "error"

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

export const DialogWeChat: Component = () => {
  const dialog = useDialog()
  const sdk = useSDK()
  const server = useServer()
  const models = useModels()
  const [status, setStatus] = createSignal<WeChatStatus>("idle")
  const [qrcode, setQrcode] = createSignal<string | null>(null)
  const [error, setError] = createSignal<{ code: string; message: string } | null>(null)
  const [user, setUser] = createSignal<{ id: string; name: string } | null>(null)
  const [loadingMsg, setLoadingMsg] = createSignal<string>("正在启动微信桥接...")
  const [locked, setLocked] = createSignal(false)
  let clientId: string | null = null

  const authHeaders = (): HeadersInit => {
    const s = server.current?.http
    if (!s?.password) return {}
    return { Authorization: `Basic ${btoa(`${s.username ?? "opencode"}:${s.password}`)}` }
  }

  const updateStatus = (s: WeChatStatus) => {
    setStatus(s)
    setWechatStatus(s)
    if (s !== "loading") setLoadingMsg("正在启动微信桥接...")
  }

  let abort: AbortController | null = null

  const fetchStatus = async () => {
    try {
      const response = await fetch(`${sdk.url}/wechat/status`, { headers: authHeaders() })
      const data = await response.json()
      if (data.locked && data.status !== "idle") {
        setLocked(true)
        if (data.user) setUser(data.user)
        return
      }
      setLocked(false)
      if (data.status === "connected" && data.user) {
        updateStatus("connected")
        setUser(data.user)
      } else if (data.status === "qrcode" && data.qrcode) {
        updateStatus("qrcode")
        setQrcode(data.qrcode)
      } else if (data.error) {
        setError(data.error)
        updateStatus("error")
      }
    } catch {}
  }

  const startBridge = async (auto = false) => {
    updateStatus("loading")
    setLoadingMsg("正在启动微信桥接...")
    setError(null)
    setLocked(false)

    const currentModel = models.recent.list()[0]
    const modelStr = currentModel ? `${currentModel.providerID}/${currentModel.modelID}` : undefined
    clientId = clientId || crypto.randomUUID()

    try {
      const response = await fetch(`${sdk.url}/wechat/start`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelStr, autoInstall: auto, clientId }),
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

      // 已有保存的会话，直接显示连接状态
      if (data.status === "connected" && data.user) {
        setUser(data.user)
        updateStatus("connected")
        connectSSE()
        return
      }

      // 安装/启动在后台进行，通过 SSE 接收进度和结果
      connectSSE()
    } catch (err) {
      setError({ code: "network_error", message: String(err) })
      updateStatus("error")
    }
  }

  const stopBridge = async () => {
    if (abort) {
      abort.abort()
      abort = null
    }
    await fetch(`${sdk.url}/wechat/stop`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ clientId }),
    })
    clientId = null
    updateStatus("idle")
    setQrcode(null)
  }

  const logout = async () => {
    if (abort) {
      abort.abort()
      abort = null
    }
    await fetch(`${sdk.url}/wechat/stop`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ clientId }),
    })
    await fetch(`${sdk.url}/wechat/session`, { method: "DELETE", headers: authHeaders() })
    clientId = null
    setUser(null)
    updateStatus("idle")
    setQrcode(null)
  }

  const connectSSE = () => {
    if (abort) {
      abort.abort()
    }
    abort = new AbortController()

    void (async () => {
      try {
        const url = clientId
          ? `${sdk.url}/wechat/events?clientId=${encodeURIComponent(clientId)}`
          : `${sdk.url}/wechat/events`
        const response = await fetch(url, {
          headers: { ...authHeaders(), Accept: "text/event-stream" },
          signal: abort!.signal,
        })
        if (!response.ok || !response.body) return

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
                updateStatus(s)
                if (event.properties.message) setLoadingMsg(event.properties.message)
              }
            } catch {}
          }
        }
      } catch {}
    })()
  }

  onMount(() => {
    fetchStatus()
  })

  onCleanup(() => {
    if (abort) {
      abort.abort()
      abort = null
    }
  })

  return (
    <Dialog title="微信连接" class="max-w-md">
      <div class="flex flex-col items-center gap-6 p-6">
        <Switch fallback={<div />}>
          <Match when={locked()}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="wechat" size="large" class="size-16 text-icon-weak" />
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">微信已被其他客户端连接</p>
                <p class="text-14-regular text-text-weak text-center">当前有另一个页面正在使用微信，请先在该页面断开连接</p>
              </div>
              <Button variant="secondary" onClick={() => dialog.close()}>
                关闭
              </Button>
            </div>
          </Match>

          <Match when={status() === "idle"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="wechat" size="large" class="size-16 text-icon-base" />
              <p class="text-14-regular text-text-base text-center">连接微信后，可在微信中使用 Aether AI</p>
              <Button variant="primary" onClick={() => startBridge(true)}>
                连接微信
              </Button>
            </div>
          </Match>

          <Match when={status() === "loading"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-12 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />
              <p class="text-14-regular text-text-base">{loadingMsg()}</p>
              <p class="text-12-regular text-text-weak">首次使用将自动安装运行环境，可能需要几分钟</p>
            </div>
          </Match>

          <Match when={status() === "qrcode"}>
            <div class="flex flex-col items-center gap-4">
              <Show when={qrcode()}>
                <img
                  src={qrcode()!}
                  alt="QR Code"
                  class="w-64 h-64 object-contain rounded-lg border border-border-base"
                />
              </Show>
              <p class="text-14-regular text-text-base">请用微信扫描二维码登录</p>
              <Button variant="ghost" onClick={stopBridge}>
                取消
              </Button>
            </div>
          </Match>

          <Match when={status() === "connected"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-success flex items-center justify-center">
                <Icon name="check-small" size="large" class="text-icon-success-base" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">已连接微信</p>
                <Show when={user()}>
                  <p class="text-14-regular text-text-weak">{user()!.name}</p>
                </Show>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={stopBridge}>
                  断开连接
                </Button>
                <Button variant="ghost" onClick={logout}>
                  切换账号
                </Button>
              </div>
            </div>
          </Match>

          <Match when={status() === "error"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-error flex items-center justify-center">
                <Icon name="warning" size="large" class="text-icon-error-base" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">连接失败</p>
                <Show when={error()}>
                  <p class="text-14-regular text-text-weak text-center max-w-xs">{error()!.message}</p>
                </Show>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  关闭
                </Button>
                <Button variant="primary" onClick={() => startBridge(true)}>
                  重试
                </Button>
              </div>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
