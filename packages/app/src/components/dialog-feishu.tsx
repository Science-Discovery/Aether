import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Component, Show, Switch, Match, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { setFeishuStatus } from "@/context/feishu"
import { useLocal } from "@/context/local"

type FeishuStatus = "idle" | "loading" | "config" | "connected" | "reconnecting" | "error"

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
  const local = useLocal()
  const [status, setStatus] = createSignal<FeishuStatus>("idle")
  const [error, setError] = createSignal<{ code: string; message: string } | null>(null)
  const [appId, setAppId] = createSignal("")
  const [appSecret, setAppSecret] = createSignal("")
  const [connectedAppId, setConnectedAppId] = createSignal<string | null>(null)
  const [loadingMsg, setLoadingMsg] = createSignal("正在连接飞书...")
  const [hasConfig, setHasConfig] = createSignal(false)
  const [steps, setSteps] = createStore({ 1: false, 2: false, 3: false, 4: false, 5: false })

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
  let retry: ReturnType<typeof setTimeout> | null = null

  const clearRetry = () => {
    if (!retry) return
    clearTimeout(retry)
    retry = null
  }

  const scheduleRetry = () => {
    if (retry || !hasConfig()) return
    retry = setTimeout(() => {
      retry = null
      if (status() === "connected" || status() === "loading") return
      updateStatus("reconnecting")
      setLoadingMsg("飞书事件流已断开，正在重连...")
      connectSSE()
      void fetchStatus()
    }, 3_000)
  }

  const fetchStatus = async () => {
    try {
      const response = await fetch(`${sdk.url}/feishu/status`, { headers: authHeaders() })
      const data = await response.json()
      setHasConfig(data.hasConfig)
      if (data.status === "connected" && data.appId) {
        clearRetry()
        updateStatus("connected")
        setConnectedAppId(data.appId)
      } else if (data.status === "reconnecting") {
        updateStatus("reconnecting")
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
      // Pass current web UI model so Feishu uses the same model after connecting
      const currentModel = local.model.current()
      if (currentModel) {
        body.model = { providerID: currentModel.provider.id, modelID: currentModel.id }
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
    clearRetry()
    if (abort) {
      abort.abort()
      abort = null
    }
    await fetch(`${sdk.url}/feishu/stop`, { method: "POST", headers: authHeaders() })
    updateStatus("idle")
  }

  const logout = async () => {
    clearRetry()
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
        if (!response.ok || !response.body) {
          scheduleRetry()
          return
        }

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
                clearRetry()
                setConnectedAppId(event.properties.appId)
                updateStatus("connected")
              } else if (event.type === "feishu.reconnecting") {
                updateStatus("reconnecting")
                setLoadingMsg("飞书连接中断，正在自动重连...")
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
                if (s === "connected") clearRetry()
              }
            } catch {}
          }
        }
        scheduleRetry()
      } catch {
        scheduleRetry()
      }
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
    clearRetry()
  })

  return (
    <Dialog title="飞书连接" size="large" class="max-w-lg">
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
            <div class="flex flex-col gap-4 w-full">
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
                <div class="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => updateStatus("idle")}>
                    取消
                  </Button>
                  <Button variant="primary" disabled={!appId() || !appSecret()} onClick={() => startBridge(true)}>
                    连接
                  </Button>
                </div>
              </div>
              <div class="w-full flex flex-col gap-1 pt-2 border-t border-border-base max-h-[280px] overflow-y-auto">
                <Collapsible open={true} variant="ghost">
                  <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                    <Collapsible.Arrow />
                    <span class="text-13-medium text-text-strong">
                      按以下步骤在飞书开放平台配置应用【点击展开每步细节】
                    </span>
                  </Collapsible.Trigger>
                  <Collapsible.Content class="flex flex-col gap-1">
                    <Collapsible open={steps[1]} onOpenChange={(v) => setSteps(1, v)} variant="ghost">
                      <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                        <Collapsible.Arrow />
                        <span class="text-13-medium text-text-strong">第一步：创建应用</span>
                      </Collapsible.Trigger>
                      <Collapsible.Content class="px-2 pb-2">
                        <ol class="text-13-regular text-text-weak list-decimal list-outside ml-4 space-y-1">
                          <li>
                            打开{" "}
                            <a
                              href="https://open.feishu.cn/app"
                              target="_blank"
                              rel="noopener"
                              class="text-text-link underline"
                            >
                              飞书开放平台
                            </a>
                          </li>
                          <li>点击「创建企业自建应用」</li>
                          <li>填写应用名称（如 "Aether AI"）和描述</li>
                          <li>
                            创建完成后，在「凭证与基础信息」页面获取 <strong class="text-text-base">App ID</strong>
                            （格式：
                            <code class="text-12-regular bg-surface-muted px-1 rounded">
                              cli_xxxxxxxxxxxxxxxx
                            </code>）和 <strong class="text-text-base">App Secret</strong>
                          </li>
                        </ol>
                      </Collapsible.Content>
                    </Collapsible>

                    <Collapsible open={steps[2]} onOpenChange={(v) => setSteps(2, v)} variant="ghost">
                      <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                        <Collapsible.Arrow />
                        <span class="text-13-medium text-text-strong">第二步：开启机器人能力</span>
                      </Collapsible.Trigger>
                      <Collapsible.Content class="px-2 pb-2">
                        <ol class="text-13-regular text-text-weak list-decimal list-outside ml-4 space-y-1">
                          <li>在应用列表中点击刚创建的应用</li>
                          <li>在左侧导航栏找到「添加应用能力」</li>
                          <li>找到「机器人」，点击「添加」</li>
                        </ol>
                      </Collapsible.Content>
                    </Collapsible>

                    <Collapsible open={steps[3]} onOpenChange={(v) => setSteps(3, v)} variant="ghost">
                      <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                        <Collapsible.Arrow />
                        <span class="text-13-medium text-text-strong">第三步：配置事件订阅</span>
                      </Collapsible.Trigger>
                      <Collapsible.Content class="px-2 pb-2">
                        <ol class="text-13-regular text-text-weak list-decimal list-outside ml-4 space-y-1">
                          <li>在左侧导航栏点击「事件与回调」→「事件配置」</li>
                          <li>
                            订阅方式选择：<strong class="text-text-base">使用长连接接收事件</strong>（非 webhook）
                          </li>
                          <li>
                            添加事件：
                            <code class="text-12-regular bg-surface-muted px-1 rounded">im.message.receive_v1</code>
                            （接收消息）
                          </li>
                        </ol>
                      </Collapsible.Content>
                    </Collapsible>

                    <Collapsible open={steps[4]} onOpenChange={(v) => setSteps(4, v)} variant="ghost">
                      <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                        <Collapsible.Arrow />
                        <span class="text-13-medium text-text-strong">第四步：配置权限</span>
                      </Collapsible.Trigger>
                      <Collapsible.Content class="px-2 pb-2">
                        <p class="text-13-regular text-text-weak mb-1.5">
                          在左侧导航栏点击「权限管理」，搜索并开通以下权限：
                        </p>
                        <ul class="text-13-regular text-text-weak space-y-1">
                          <li>
                            <code class="text-12-regular bg-surface-muted px-1 rounded">im:message</code> —
                            获取与发送消息
                          </li>
                          <li>
                            <code class="text-12-regular bg-surface-muted px-1 rounded">im:message:send_as_bot</code> —
                            以机器人身份发送消息
                          </li>
                          <li>
                            <code class="text-12-regular bg-surface-muted px-1 rounded">
                              im:message.p2p_msg:readonly
                            </code>{" "}
                            — 读取私聊消息
                          </li>
                          <li>
                            <code class="text-12-regular bg-surface-muted px-1 rounded">im:message.group_msg</code> —
                            读取群聊消息历史（总结功能需要）
                          </li>
                          <li>
                            <code class="text-12-regular bg-surface-muted px-1 rounded">im:resource</code> —
                            上传文件资源（发送附件功能需要）
                          </li>
                        </ul>
                      </Collapsible.Content>
                    </Collapsible>

                    <Collapsible open={steps[5]} onOpenChange={(v) => setSteps(5, v)} variant="ghost">
                      <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                        <Collapsible.Arrow />
                        <span class="text-13-medium text-text-strong">第五步：发布应用</span>
                      </Collapsible.Trigger>
                      <Collapsible.Content class="px-2 pb-2">
                        <ol class="text-13-regular text-text-weak list-decimal list-outside ml-4 space-y-1">
                          <li>在左侧导航栏点击「版本管理与发布」</li>
                          <li>创建版本并提交审核</li>
                          <li>管理员审核通过后即可使用</li>
                        </ol>
                      </Collapsible.Content>
                    </Collapsible>
                  </Collapsible.Content>
                </Collapsible>
              </div>
            </div>
          </Match>

          <Match when={status() === "loading"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-12 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />
              <p class="text-14-regular text-text-base">{loadingMsg()}</p>
            </div>
          </Match>

          <Match when={status() === "reconnecting"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-warning flex items-center justify-center">
                <Icon name="arrow-right" size="large" class="text-icon-warning-base animate-spin" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">正在重连飞书</p>
                <p class="text-14-regular text-text-weak text-center max-w-xs">{loadingMsg()}</p>
              </div>
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
              <div class="w-full text-13-regular text-text-weak bg-surface-muted rounded-md p-3 space-y-1">
                <p class="text-12-medium text-text-base">使用方式</p>
                <p>私聊：直接给机器人发消息</p>
                <p>
                  群聊：需要 <strong class="text-text-base">@机器人</strong> 才会触发回复
                </p>
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
