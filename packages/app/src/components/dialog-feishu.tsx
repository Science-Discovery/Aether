import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Component, Show, Switch, Match, createSignal, onCleanup, onMount } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { setFeishuStatus } from "@/context/feishu"

type FeishuStatus = "idle" | "loading" | "config" | "connected" | "error"

interface FeishuEvent {
  type: string
  properties: {
    status?: FeishuStatus | "starting"
    message?: string
    appId?: string
    code?: string
  }
}

export const DialogFeishu: Component = () => {
  const dialog = useDialog()
  const sdk = useSDK()
  const server = useServer()
  const [status, setStatus] = createSignal<FeishuStatus>("idle")
  const [error, setError] = createSignal<{ code: string; message: string } | null>(null)
  const [appId, setAppId] = createSignal("")
  const [appSecret, setAppSecret] = createSignal("")
  const [connectedAppId, setConnectedAppId] = createSignal<string | null>(null)
  const [loadingMsg, setLoadingMsg] = createSignal("正在连接飞书...")
  const [hasConfig, setHasConfig] = createSignal(false)

  const authHeaders = (): HeadersInit => {
    const s = server.current?.http
    if (!s?.password) return {}
    return { Authorization: `Basic ${btoa(`${s.username ?? "opencode"}:${s.password}`)}` }
  }

  const updateStatus = (s: FeishuStatus) => {
    setStatus(s)
    setFeishuStatus(s === "config" ? "idle" : s)
    if (s !== "loading") setLoadingMsg("正在连接飞书...")
  }

  let abort: AbortController | null = null

  const fetchStatus = async () => {
    try {
      const response = await fetch(`${sdk.url}/feishu/status`, { headers: authHeaders() })
      const data = await response.json()
      setHasConfig(data.hasConfig)
      if (data.status === "connected" && data.appId) {
        updateStatus("connected")
        setConnectedAppId(data.appId)
      } else if (data.error) {
        setError(data.error)
        updateStatus("error")
      } else if (data.hasConfig) {
        // Has saved config, show idle (ready to connect)
        updateStatus("idle")
      }
    } catch {}
  }

  const startBridge = async (withConfig = false) => {
    updateStatus("loading")
    setLoadingMsg("正在连接飞书...")
    setError(null)

    // Connect SSE first so we don't miss any events
    connectSSE()

    try {
      const body: any = {}
      if (withConfig) {
        body.appId = appId()
        body.appSecret = appSecret()
      }

      const response = await fetch(`${sdk.url}/feishu/start`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await response.json()

      if (!data.success) {
        if (data.code === "config_missing") {
          updateStatus("config")
          return
        }
        setError({ code: data.code || "start_failed", message: data.message || "连接飞书失败" })
        updateStatus("error")
        return
      }

      // SSE already connected, events will flow through
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
    await fetch(`${sdk.url}/feishu/stop`, { method: "POST", headers: authHeaders() })
    updateStatus("idle")
  }

  const logout = async () => {
    if (abort) {
      abort.abort()
      abort = null
    }
    await fetch(`${sdk.url}/feishu/stop`, { method: "POST", headers: authHeaders() })
    await fetch(`${sdk.url}/feishu/session`, { method: "DELETE", headers: authHeaders() })
    setConnectedAppId(null)
    setHasConfig(false)
    setAppId("")
    setAppSecret("")
    updateStatus("idle")
  }

  const connectSSE = () => {
    if (abort) {
      abort.abort()
    }
    abort = new AbortController()

    void (async () => {
      try {
        const response = await fetch(`${sdk.url}/feishu/events`, {
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
              const event: FeishuEvent = JSON.parse(raw)
              if (event.type === "feishu.connected" && event.properties.appId) {
                setConnectedAppId(event.properties.appId)
                updateStatus("connected")
              } else if (event.type === "feishu.error") {
                setError({
                  code: event.properties.code || "unknown",
                  message: event.properties.message || "未知错误",
                })
                updateStatus("error")
              } else if (event.type === "feishu.status" && event.properties.status) {
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
    <Dialog title="飞书连接" class="max-w-md">
      <div class="flex flex-col items-center gap-6 p-6">
        <Switch fallback={<div />}>
          <Match when={status() === "idle"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="feishu" size="large" class="size-16 text-icon-base" />
              <p class="text-14-regular text-text-base text-center">连接飞书后，可在飞书中使用 Aether AI</p>
              <Show
                when={hasConfig()}
                fallback={
                  <Button variant="primary" onClick={() => updateStatus("config")}>
                    配置飞书应用
                  </Button>
                }
              >
                <div class="flex gap-2">
                  <Button variant="primary" onClick={() => startBridge()}>
                    连接飞书
                  </Button>
                  <Button variant="ghost" onClick={() => updateStatus("config")}>
                    重新配置
                  </Button>
                </div>
              </Show>
            </div>
          </Match>

          <Match when={status() === "config"}>
            <div class="flex flex-col items-center gap-4 w-full">
              <Icon name="feishu" size="large" class="size-12 text-icon-base" />
              <p class="text-14-regular text-text-weak text-center">
                请在飞书开放平台创建应用，获取 App ID 和 App Secret
              </p>
              <div class="w-full flex flex-col gap-3">
                <div class="flex flex-col gap-1">
                  <label class="text-12-medium text-text-base">App ID</label>
                  <input
                    type="text"
                    value={appId()}
                    onInput={(e) => setAppId(e.currentTarget.value)}
                    placeholder="cli_xxxxxxxx"
                    class="w-full px-3 py-2 rounded-md border border-border-base bg-surface-base text-text-base text-13-regular focus:outline-none focus:border-border-focus"
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <label class="text-12-medium text-text-base">App Secret</label>
                  <input
                    type="password"
                    value={appSecret()}
                    onInput={(e) => setAppSecret(e.currentTarget.value)}
                    placeholder="输入 App Secret"
                    class="w-full px-3 py-2 rounded-md border border-border-base bg-surface-base text-text-base text-13-regular focus:outline-none focus:border-border-focus"
                  />
                </div>
              </div>
              <div class="flex gap-2">
                <Button variant="ghost" onClick={() => updateStatus("idle")}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  disabled={!appId() || !appSecret()}
                  onClick={() => startBridge(true)}
                >
                  连接
                </Button>
              </div>
            </div>
          </Match>

          <Match when={status() === "loading"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-12 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />
              <p class="text-14-regular text-text-base">{loadingMsg()}</p>
            </div>
          </Match>

          <Match when={status() === "connected"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-success flex items-center justify-center">
                <Icon name="check-small" size="large" class="text-icon-success-base" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">已连接飞书</p>
                <Show when={connectedAppId()}>
                  <p class="text-14-regular text-text-weak">App: {connectedAppId()!.slice(0, 16)}...</p>
                </Show>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={stopBridge}>
                  断开连接
                </Button>
                <Button variant="ghost" onClick={logout}>
                  切换应用
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
                <Button variant="primary" onClick={() => startBridge()}>
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
