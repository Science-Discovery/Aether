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
import { useLanguage } from "@/context/language"

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
  const language = useLanguage()
  const [status, setStatus] = createSignal<FeishuStatus>("idle")
  const [error, setError] = createSignal<{ code: string; message: string } | null>(null)
  const [appId, setAppId] = createSignal("")
  const [appSecret, setAppSecret] = createSignal("")
  const [connectedAppId, setConnectedAppId] = createSignal<string | null>(null)
  const [loadingMsg, setLoadingMsg] = createSignal("")
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
    if (s !== "loading") setLoadingMsg("")
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
      setLoadingMsg(language.t("feishu.eventStreamDisconnected"))
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
    setLoadingMsg(language.t("feishu.connecting"))
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
        setError({ code: data.code || "start_failed", message: data.message || language.t("feishu.failedToConnect") })
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
                setLoadingMsg(language.t("feishu.autoReconnecting"))
              } else if (event.type === "feishu.error") {
                setError({
                  code: event.properties.code || "unknown",
                  message: event.properties.message || language.t("feishu.unknownError"),
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
    <Dialog title={language.t("feishu.connection")} size="large" class="max-w-lg">
      <div class="flex flex-col items-center gap-6 p-6">
        <Switch fallback={<div />}>
          <Match when={status() === "idle"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="feishu" size="large" class="size-16 text-icon-base" />
              <p class="text-14-regular text-text-base text-center">{language.t("feishu.connectToUse")}</p>
              <Show
                when={hasConfig()}
                fallback={
                  <Button variant="primary" onClick={() => updateStatus("config")}>
                    {language.t("feishu.configureApp")}
                  </Button>
                }
              >
                <div class="flex gap-2">
                  <Button variant="primary" onClick={() => startBridge()}>
                    {language.t("feishu.connectFeishu")}
                  </Button>
                  <Button variant="ghost" onClick={() => updateStatus("config")}>
                    {language.t("feishu.reconfigure")}
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
                    placeholder={language.t("feishu.enterAppSecret")}
                    class="w-full px-3 py-2 rounded-md border border-border-base bg-surface-base text-text-base text-13-regular focus:outline-none focus:border-border-focus"
                  />
                </div>
                <div class="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => updateStatus("idle")}>
                    {language.t("feishu.cancel")}
                  </Button>
                  <Button variant="primary" disabled={!appId() || !appSecret()} onClick={() => startBridge(true)}>
                    {language.t("feishu.connect")}
                  </Button>
                </div>
              </div>
              <div class="w-full flex flex-col gap-1 pt-2 border-t border-border-base max-h-[280px] overflow-y-auto">
                <Collapsible open={true} variant="ghost">
                  <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                    <Collapsible.Arrow />
                    <span class="text-13-medium text-text-strong">{language.t("feishu.stepsIntro")}</span>
                  </Collapsible.Trigger>
                  <Collapsible.Content class="flex flex-col gap-1">
                    <Collapsible open={steps[1]} onOpenChange={(v) => setSteps(1, v)} variant="ghost">
                      <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                        <Collapsible.Arrow />
                        <span class="text-13-medium text-text-strong">{language.t("feishu.step1.title")}</span>
                      </Collapsible.Trigger>
                      <Collapsible.Content class="px-2 pb-2">
                        <ol class="text-13-regular text-text-weak list-decimal list-outside ml-4 space-y-1">
                          <li>
                            Open{" "}
                            <a
                              href="https://open.feishu.cn/app"
                              target="_blank"
                              rel="noopener"
                              class="text-text-link underline"
                            >
                              {language.t("feishu.openPlatform")}
                            </a>
                          </li>
                          <li>{language.t("feishu.step1.clickCreate")}</li>
                          <li>{language.t("feishu.step1.fillName")}</li>
                          <li>
                            {language.t("feishu.step1.getCredentials")} <strong class="text-text-base">App ID</strong>
                            (format:
                            <code class="text-12-regular bg-surface-muted px-1 rounded">
                              cli_xxxxxxxxxxxxxxxx
                            </code>) {language.t("feishu.step1.and")} <strong class="text-text-base">App Secret</strong>
                          </li>
                        </ol>
                      </Collapsible.Content>
                    </Collapsible>

                    <Collapsible open={steps[2]} onOpenChange={(v) => setSteps(2, v)} variant="ghost">
                      <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                        <Collapsible.Arrow />
                        <span class="text-13-medium text-text-strong">{language.t("feishu.step2.title")}</span>
                      </Collapsible.Trigger>
                      <Collapsible.Content class="px-2 pb-2">
                        <ol class="text-13-regular text-text-weak list-decimal list-outside ml-4 space-y-1">
                          <li>{language.t("feishu.step2.clickApp")}</li>
                          <li>{language.t("feishu.step2.findCapability")}</li>
                          <li>{language.t("feishu.step2.addBot")}</li>
                        </ol>
                      </Collapsible.Content>
                    </Collapsible>

                    <Collapsible open={steps[3]} onOpenChange={(v) => setSteps(3, v)} variant="ghost">
                      <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                        <Collapsible.Arrow />
                        <span class="text-13-medium text-text-strong">{language.t("feishu.step3.title")}</span>
                      </Collapsible.Trigger>
                      <Collapsible.Content class="px-2 pb-2">
                        <ol class="text-13-regular text-text-weak list-decimal list-outside ml-4 space-y-1">
                          <li>{language.t("feishu.step3.clickEvents")}</li>
                          <li>
                            <strong class="text-text-base">{language.t("feishu.step3.longConnection")}</strong>{" "}
                            {language.t("feishu.step3.notWebhook")}
                          </li>
                          <li>
                            {language.t("feishu.step3.addEvent")}
                            <code class="text-12-regular bg-surface-muted px-1 rounded">im.message.receive_v1</code>
                            {language.t("feishu.step3.receiveMessages")}
                          </li>
                        </ol>
                      </Collapsible.Content>
                    </Collapsible>

                    <Collapsible open={steps[4]} onOpenChange={(v) => setSteps(4, v)} variant="ghost">
                      <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                        <Collapsible.Arrow />
                        <span class="text-13-medium text-text-strong">{language.t("feishu.step4.title")}</span>
                      </Collapsible.Trigger>
                      <Collapsible.Content class="px-2 pb-2">
                        <p class="text-13-regular text-text-weak mb-1.5">
                          {language.t("feishu.step4.searchPermissions")}
                        </p>
                        <ul class="text-13-regular text-text-weak space-y-1">
                          <li>
                            <code class="text-12-regular bg-surface-muted px-1 rounded">im:message</code> —
                            {language.t("feishu.step4.imMessage")}
                          </li>
                          <li>
                            <code class="text-12-regular bg-surface-muted px-1 rounded">im:message:send_as_bot</code> —
                            {language.t("feishu.step4.imMessageSendAsBot")}
                          </li>
                          <li>
                            <code class="text-12-regular bg-surface-muted px-1 rounded">
                              im:message.p2p_msg:readonly
                            </code>{" "}
                            — {language.t("feishu.step4.imMessageP2p")}
                          </li>
                          <li>
                            <code class="text-12-regular bg-surface-muted px-1 rounded">im:message.group_msg</code> —
                            {language.t("feishu.step4.imMessageGroupMsg")}
                          </li>
                          <li>
                            <code class="text-12-regular bg-surface-muted px-1 rounded">im:resource</code> —
                            {language.t("feishu.step4.imResource")}
                          </li>
                        </ul>
                      </Collapsible.Content>
                    </Collapsible>

                    <Collapsible open={steps[5]} onOpenChange={(v) => setSteps(5, v)} variant="ghost">
                      <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                        <Collapsible.Arrow />
                        <span class="text-13-medium text-text-strong">{language.t("feishu.step5.title")}</span>
                      </Collapsible.Trigger>
                      <Collapsible.Content class="px-2 pb-2">
                        <ol class="text-13-regular text-text-weak list-decimal list-outside ml-4 space-y-1">
                          <li>{language.t("feishu.step5.clickVersion")}</li>
                          <li>{language.t("feishu.step5.createVersion")}</li>
                          <li>{language.t("feishu.step5.adminApproval")}</li>
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
              <p class="text-14-regular text-text-base">{loadingMsg() || language.t("feishu.connecting")}</p>
            </div>
          </Match>

          <Match when={status() === "reconnecting"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-warning flex items-center justify-center">
                <Icon name="arrow-right" size="large" class="text-icon-warning-base animate-spin" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">{language.t("feishu.reconnecting")}</p>
                <p class="text-14-regular text-text-weak text-center max-w-xs">
                  {loadingMsg() || language.t("feishu.autoReconnecting")}
                </p>
              </div>
            </div>
          </Match>

          <Match when={status() === "connected"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-success flex items-center justify-center">
                <Icon name="check-small" size="large" class="text-icon-success-base" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">{language.t("feishu.connected")}</p>
                <Show when={connectedAppId()}>
                  <p class="text-14-regular text-text-weak">App: {connectedAppId()!.slice(0, 16)}...</p>
                </Show>
              </div>
              <div class="w-full text-13-regular text-text-weak bg-surface-muted rounded-md p-3 space-y-1">
                <p class="text-12-medium text-text-base">{language.t("feishu.usage")}</p>
                <p>{language.t("feishu.privateChat")}</p>
                <p>
                  {language.t("feishu.groupChat")}{" "}
                  <strong class="text-text-base">{language.t("feishu.groupChatBot")}</strong>{" "}
                  {language.t("feishu.groupChatTrigger")}
                </p>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={stopBridge}>
                  {language.t("feishu.disconnect")}
                </Button>
                <Button variant="ghost" onClick={logout}>
                  {language.t("feishu.switchApp")}
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
                <p class="text-16-medium text-text-strong">{language.t("feishu.connectionFailed")}</p>
                <Show when={error()}>
                  <p class="text-14-regular text-text-weak text-center max-w-xs">{error()!.message}</p>
                </Show>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  {language.t("feishu.close")}
                </Button>
                <Button variant="primary" onClick={() => startBridge()}>
                  {language.t("feishu.retry")}
                </Button>
              </div>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
