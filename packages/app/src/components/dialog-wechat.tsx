import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Component, Show, Switch, Match, createSignal, onCleanup, onMount } from "solid-js"
import { useSDK } from "@/context/sdk"
import { setWechatStatus } from "@/context/wechat"

type WeChatStatus = "idle" | "loading" | "qrcode" | "connected" | "error"

interface WeChatEvent {
  type: string
  properties: {
    status?: WeChatStatus
    message?: string
    image?: string
    user?: { id: string; name: string }
    code?: string
  }
}

export const DialogWeChat: Component = () => {
  const dialog = useDialog()
  const sdk = useSDK()
  const [status, setStatus] = createSignal<WeChatStatus>("idle")
  const [qrcode, setQrcode] = createSignal<string | null>(null)
  const [error, setError] = createSignal<{ code: string; message: string } | null>(null)
  const [user, setUser] = createSignal<{ id: string; name: string } | null>(null)

  const updateStatus = (s: WeChatStatus) => {
    setStatus(s)
    setWechatStatus(s)
  }

  let eventSource: EventSource | null = null

  const fetchStatus = async () => {
    try {
      const response = await fetch(`${sdk.url}/wechat/status`)
      const data = await response.json()
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

  const startBridge = async () => {
    updateStatus("loading")
    setError(null)

    try {
      const response = await fetch(`${sdk.url}/wechat/start`, { method: "POST" })
      const data = await response.json()

      if (!data.success) {
        setError({ code: "start_failed", message: data.message || "Failed to start WeChat bridge" })
        updateStatus("error")
        return
      }

      // 检查响应中的状态（可能是已保存的会话）
      if (data.status === "connected" && data.user) {
        setUser(data.user)
        updateStatus("connected")
        return
      }

      connectEventSource()
    } catch (err) {
      setError({ code: "network_error", message: String(err) })
      updateStatus("error")
    }
  }

  const stopBridge = async () => {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
    await fetch(`${sdk.url}/wechat/stop`, { method: "POST" })
    updateStatus("idle")
    setQrcode(null)
  }

  const connectEventSource = () => {
    if (eventSource) {
      eventSource.close()
    }

    eventSource = new EventSource(`${sdk.url}/wechat/events`)

    eventSource.onmessage = (e) => {
      try {
        const event: WeChatEvent = JSON.parse(e.data)

        if (event.type === "wechat.qrcode" && event.properties.image) {
          setQrcode(event.properties.image)
          updateStatus("qrcode")
        } else if (event.type === "wechat.connected" && event.properties.user) {
          setUser(event.properties.user)
          updateStatus("connected")
        } else if (event.type === "wechat.error") {
          setError({ code: event.properties.code || "unknown", message: event.properties.message || "Unknown error" })
          updateStatus("error")
        } else if (event.type === "wechat.status" && event.properties.status) {
          updateStatus(event.properties.status)
        }
      } catch {}
    }

    eventSource.onerror = () => {
      eventSource?.close()
      eventSource = null
    }
  }

  onMount(() => {
    fetchStatus()
  })

  onCleanup(() => {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
  })

  return (
    <Dialog title="微信连接" class="max-w-md">
      <div class="flex flex-col items-center gap-6 p-6">
        <Switch fallback={<div />}>
          <Match when={status() === "idle"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="wechat" size="large" class="size-16 text-icon-base" />
              <p class="text-14-regular text-text-base text-center">连接微信后，可在微信中使用 Aether AI</p>
              <Button variant="primary" onClick={startBridge}>
                连接微信
              </Button>
            </div>
          </Match>

          <Match when={status() === "loading"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-12 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />
              <p class="text-14-regular text-text-base">正在启动微信桥接...</p>
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
              <Button variant="secondary" onClick={stopBridge}>
                断开连接
              </Button>
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
                <Button variant="primary" onClick={startBridge}>
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
