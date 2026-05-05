import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Switch as SwitchToggle } from "@opencode-ai/ui/switch"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Component, Show, Switch, Match, createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useServer } from "@/context/server"
import { useModels } from "@/context/models"
import { useLanguage } from "@/context/language"
import {
  status,
  error,
  user,
  loadingMsg,
  qrcode,
  locked,
  hasConfig,
  appId,
  startBridge,
  stopBridge,
  logout,
  fetchStatus,
  forceTakeover,
  retryBridge,
  rescanBridge,
  setStatus,
  autoConnect,
  setAutoConnect,
  type MobilePlatform,
  type MobileStatus,
} from "@/context/mobile"

const CRED_KEY = (p: MobilePlatform) => `opencode:creds:mobile:${p}`

function loadMobileCreds(p: MobilePlatform) {
  try {
    const raw = localStorage.getItem(CRED_KEY(p))
    if (!raw) return null
    return JSON.parse(raw) as { appId: string; appSecret: string }
  } catch {
    return null
  }
}

function saveMobileCreds(p: MobilePlatform, appId: string, appSecret: string) {
  localStorage.setItem(CRED_KEY(p), JSON.stringify({ appId, appSecret }))
}

interface Props {
  platform: MobilePlatform
}

const iconName = (p: MobilePlatform) =>
  p === "feishu" ? ("feishu" as const) : p === "qq" ? ("qq" as const) : ("wechat" as const)

export const DialogMobile: Component<Props> = (props) => {
  const dialog = useDialog()
  const server = useServer()
  const models = useModels()
  const language = useLanguage()
  const savedCreds = () => loadMobileCreds(p())
  const [inputAppId, setInputAppId] = createSignal(savedCreds()?.appId ?? "")
  const [inputAppSecret, setInputAppSecret] = createSignal(savedCreds()?.appSecret ?? "")
  const [steps, setSteps] = createStore({ 1: false, 2: false, 3: false, 4: false, 5: false })
  const [prevStatus, setPrevStatus] = createSignal<MobileStatus>("idle")

  const p = () => props.platform

  const authHeaders = (): HeadersInit => {
    const s = server.current?.http
    if (!s?.password) return {}
    return { Authorization: `Basic ${btoa(`${s.username ?? "opencode"}:${s.password}`)}` }
  }

  const currentModelStr = () => {
    if (p() === "wechat") {
      const m = models.recent.list()[0]
      return m ? `${m.providerID}/${m.modelID}` : undefined
    }
    const m = models.recent.list()[0]
    return m ? { providerID: m.providerID, modelID: m.modelID } : undefined
  }

  const doStart = () => {
    if (p() === "feishu" || p() === "qq") {
      saveMobileCreds(p(), inputAppId(), inputAppSecret())
      return startBridge(p(), false, undefined, false, inputAppId(), inputAppSecret())
    }
    return startBridge("wechat", true, currentModelStr() as string | undefined)
  }

  const doForceTakeover = () => {
    if (p() === "wechat") return forceTakeover("wechat", currentModelStr() as string | undefined)
  }

  const doRetry = () => {
    if (p() === "wechat") return retryBridge("wechat")
    return doStart()
  }

  onMount(() => {
    fetchStatus(p())
  })

  return (
    <Dialog
      title={language.t(`${p()}.connection`)}
      size={p() === "feishu" || p() === "qq" ? "large" : undefined}
      class={p() === "feishu" || p() === "qq" ? "max-w-lg" : "max-w-md"}
    >
      <div class="flex flex-col items-center gap-6 p-6">
        <Switch fallback={<div />}>
          <Match when={p() === "wechat" && locked("wechat")}>
            <div class="flex flex-col items-center gap-4">
              <Icon name={iconName(p())} size="large" class="size-16 text-icon-weak" />
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">{language.t("wechat.lockedByOther")}</p>
                <p class="text-14-regular text-text-weak text-center">{language.t("wechat.disconnectOnOtherPage")}</p>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  {language.t("wechat.close")}
                </Button>
                <Button variant="primary" onClick={doForceTakeover}>
                  {language.t("wechat.forceTakeover")}
                </Button>
              </div>
            </div>
          </Match>

          <Match when={status(p()) === "stolen"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="warning" size="large" class="size-16 text-icon-warning" />
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">{language.t(`${p()}.connectionTakenOver`)}</p>
                <p class="text-14-regular text-text-weak text-center">{language.t(`${p()}.takenOverByOther`)}</p>
              </div>
              <Button variant="primary" onClick={doStart}>
                {language.t(`${p()}.reconnect`)}
              </Button>
            </div>
          </Match>

          <Match when={status(p()) === "idle"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name={iconName(p())} size="large" class="size-16 text-icon-base" />
              <p class="text-14-regular text-text-base text-center">{language.t(`${p()}.connectToUse`)}</p>
              <Show
                when={hasConfig(p())}
                fallback={
                  p() === "feishu" || p() === "qq" ? (
                    <Button variant="primary" onClick={() => setStatus(p(), "config")}>
                      {language.t(`${p()}.configureApp`)}
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={doStart}>
                      {language.t("wechat.connectWechat")}
                    </Button>
                  )
                }
              >
                <div class="flex gap-2">
                  <Button variant="primary" onClick={doStart}>
                    {p() === "feishu"
                      ? language.t("feishu.connectFeishu")
                      : p() === "qq"
                        ? language.t("qq.connectQQ")
                        : language.t("wechat.connectWechat")}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setPrevStatus("idle")
                      if (p() === "wechat") rescanBridge("wechat")
                      else setStatus(p(), "config")
                    }}
                  >
                    {p() === "wechat" ? language.t("wechat.rescan") : language.t(`${p()}.reconfigure`)}
                  </Button>
                </div>
              </Show>
            </div>
          </Match>

          <Match when={status(p()) === "config"}>
            <Show when={p() === "feishu" || p() === "qq"}>
              <div class="flex flex-col gap-4 w-full">
                <div class="w-full flex flex-col gap-3">
                  <div class="sr-only" aria-hidden="true">
                    <input type="text" name="username" tabIndex={-1} autocomplete="username" />
                    <input type="password" name="password" tabIndex={-1} autocomplete="current-password" />
                  </div>
                  <div class="flex flex-col gap-1">
                    <label class="text-12-medium text-text-base">App ID</label>
                    <input
                      type="text"
                      name={`mobile-appid-${p()}`}
                      value={inputAppId()}
                      onInput={(e) => setInputAppId(e.currentTarget.value)}
                      autocomplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      placeholder={p() === "qq" ? "10xxxxxx" : "cli_xxxxxxxx"}
                      class="w-full px-3 py-2 rounded-md border border-border-base bg-surface-base text-text-base text-13-regular focus:outline-none focus:border-border-focus"
                    />
                  </div>
                  <div class="flex flex-col gap-1">
                    <label class="text-12-medium text-text-base">App Secret</label>
                    <input
                      type="password"
                      name={`mobile-secret-${p()}`}
                      value={inputAppSecret()}
                      onInput={(e) => setInputAppSecret(e.currentTarget.value)}
                      autocomplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      placeholder={language.t(`${p()}.enterAppSecret`)}
                      class="w-full px-3 py-2 rounded-md border border-border-base bg-surface-base text-text-base text-13-regular focus:outline-none focus:border-border-focus"
                    />
                  </div>
                  <div class="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setStatus(p(), prevStatus())}>
                      {language.t(`${p()}.cancel`)}
                    </Button>
                    <Button variant="primary" disabled={!inputAppId() || !inputAppSecret()} onClick={doStart}>
                      {language.t(`${p()}.connect`)}
                    </Button>
                  </div>
                </div>
                <div class="w-full flex flex-col gap-1 pt-2 border-t border-border-base max-h-[280px] overflow-y-auto">
                  <Show when={p() === "feishu"}>
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
                                {language.t("common.open")}{" "}
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
                                {language.t("feishu.step1.getCredentials")}{" "}
                                <strong class="text-text-base">App ID</strong> {language.t("feishu.step1.and")}{" "}
                                <strong class="text-text-base">App Secret</strong>
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
                                {language.t("feishu.step3.addEvent")}{" "}
                                <code class="text-12-regular bg-surface-muted px-1 rounded">im.message.receive_v1</code>{" "}
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
                                <code class="text-12-regular bg-surface-muted px-1 rounded">
                                  im:message:send_as_bot
                                </code>{" "}
                                — {language.t("feishu.step4.imMessageSendAsBot")}
                              </li>
                              <li>
                                <code class="text-12-regular bg-surface-muted px-1 rounded">
                                  im:message.p2p_msg:readonly
                                </code>{" "}
                                — {language.t("feishu.step4.imMessageP2p")}
                              </li>
                              <li>
                                <code class="text-12-regular bg-surface-muted px-1 rounded">im:message.group_msg</code>{" "}
                                —{language.t("feishu.step4.imMessageGroupMsg")}
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
                  </Show>
                  <Show when={p() === "qq"}>
                    <p class="text-13-regular text-text-weak">
                      {language.t("qq.open")}{" "}
                      <a href="https://q.qq.com" target="_blank" rel="noopener" class="text-text-link underline">
                        {language.t("qq.openPlatform")}
                      </a>
                      ，{language.t("qq.getCredentials")} <strong class="text-text-base">AppID</strong>{" "}
                      {language.t("feishu.step1.and")} <strong class="text-text-base">AppSecret</strong>
                    </p>
                  </Show>
                </div>
              </div>
            </Show>
          </Match>

          <Match when={status(p()) === "loading"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-12 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />
              <p class="text-14-regular text-text-base">{loadingMsg(p())}</p>
              <Show when={p() === "wechat"}>
                <p class="text-12-regular text-text-weak">{language.t("wechat.autoInstall")}</p>
              </Show>
            </div>
          </Match>

          <Match when={status(p()) === "qrcode"}>
            <Show when={p() === "wechat"}>
              <div class="flex flex-col items-center gap-4">
                <Show when={qrcode("wechat")}>
                  <img
                    src={qrcode("wechat")!}
                    alt="QR Code"
                    class="w-64 h-64 object-contain rounded-lg border border-border-base"
                  />
                </Show>
                <p class="text-14-regular text-text-base">{language.t("wechat.scanQRCode")}</p>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (prevStatus() === "connected") {
                      stopBridge("wechat").then(() => startBridge("wechat", true))
                    } else {
                      stopBridge("wechat")
                    }
                  }}
                >
                  {language.t("wechat.cancel")}
                </Button>
              </div>
            </Show>
          </Match>

          <Match when={status(p()) === "reconnecting"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-warning flex items-center justify-center">
                <Icon name="arrow-right" size="large" class="text-icon-warning-base animate-spin" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">{language.t(`${p()}.reconnecting`)}</p>
                <p class="text-14-regular text-text-weak text-center max-w-xs">{loadingMsg(p())}</p>
              </div>
              <Button variant="ghost" onClick={() => stopBridge(p())}>
                {language.t(`${p()}.cancel`)}
              </Button>
            </div>
          </Match>

          <Match when={status(p()) === "connected"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-success flex items-center justify-center">
                <Icon name="check-small" size="large" class="text-icon-success-base" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">{language.t(`${p()}.connected`)}</p>
                <Show when={(p() === "feishu" || p() === "qq") && appId(p())}>
                  <p class="text-14-regular text-text-weak">App: {appId(p())!.slice(0, 16)}...</p>
                </Show>
                <Show when={user(p()) && user(p())!.name && user(p())!.name !== "Unknown"}>
                  <p class="text-14-regular text-text-weak">{user(p())!.name}</p>
                </Show>
              </div>
              <Show when={p() === "feishu" || p() === "qq"}>
                <div class="w-full text-13-regular text-text-weak bg-surface-muted rounded-md p-3 space-y-1">
                  <p class="text-12-medium text-text-base">{language.t(`${p()}.usage`)}</p>
                  <p>{language.t(`${p()}.privateChat`)}</p>
                  <p>
                    {language.t(`${p()}.groupChat`)}{" "}
                    <strong class="text-text-base">{language.t(`${p()}.groupChatBot`)}</strong>{" "}
                    {language.t(`${p()}.groupChatTrigger`)}
                  </p>
                </div>
              </Show>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={() => stopBridge(p())}>
                  {language.t(`${p()}.disconnect`)}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setPrevStatus(status(p()))
                    if (p() === "wechat") rescanBridge("wechat")
                    else setStatus(p(), "config")
                  }}
                >
                  {p() === "wechat" ? language.t("wechat.rescan") : language.t(`${p()}.reconfigure`)}
                </Button>
              </div>
              <SwitchToggle checked={autoConnect(p())} onChange={(v) => setAutoConnect(p(), v)}>
                {language.t("mobile.autoConnect")}
              </SwitchToggle>
            </div>
          </Match>

          <Match when={status(p()) === "error"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-error flex items-center justify-center">
                <Icon name="warning" size="large" class="text-icon-error-base" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">{language.t(`${p()}.connectionFailed`)}</p>
                <Show when={error(p())}>
                  <p class="text-14-regular text-text-weak text-center max-w-xs">{error(p())!.message}</p>
                </Show>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  {language.t(`${p()}.close`)}
                </Button>
                <Button variant="primary" onClick={doRetry}>
                  {language.t(`${p()}.retry`)}
                </Button>
              </div>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
