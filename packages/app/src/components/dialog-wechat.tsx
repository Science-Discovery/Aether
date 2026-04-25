import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Component, Show, Switch, Match } from "solid-js"
import { useModels } from "@/context/models"
import { useLanguage } from "@/context/language"
import {
  status,
  qrcode,
  error,
  user,
  loadingMsg,
  locked,
  startBridge,
  stopBridge,
  logout,
  forceTakeover,
  type WeChatStatus,
} from "@/context/wechat"

export const DialogWeChat: Component = () => {
  const dialog = useDialog()
  const models = useModels()
  const language = useLanguage()

  const currentModelStr = () => {
    const m = models.recent.list()[0]
    return m ? `${m.providerID}/${m.modelID}` : undefined
  }

  return (
    <Dialog title={language.t("wechat.connection")} class="max-w-md">
      <div class="flex flex-col items-center gap-6 p-6">
        <Switch fallback={<div />}>
          <Match when={locked()}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="wechat" size="large" class="size-16 text-icon-weak" />
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">{language.t("wechat.lockedByOther")}</p>
                <p class="text-14-regular text-text-weak text-center">{language.t("wechat.disconnectOnOtherPage")}</p>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  {language.t("wechat.close")}
                </Button>
                <Button variant="primary" onClick={() => forceTakeover(currentModelStr())}>
                  {language.t("wechat.forceTakeover")}
                </Button>
              </div>
            </div>
          </Match>

          <Match when={status() === "stolen"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="warning" size="large" class="size-16 text-icon-warning" />
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">{language.t("wechat.connectionTakenOver")}</p>
                <p class="text-14-regular text-text-weak text-center">{language.t("wechat.takenOverByOther")}</p>
              </div>
              <Button variant="primary" onClick={() => startBridge(true, currentModelStr())}>
                {language.t("wechat.reconnect")}
              </Button>
            </div>
          </Match>

          <Match when={status() === "idle"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="wechat" size="large" class="size-16 text-icon-base" />
              <p class="text-14-regular text-text-base text-center">{language.t("wechat.connectToUse")}</p>
              <Button variant="primary" onClick={() => startBridge(true, currentModelStr())}>
                {language.t("wechat.connectWechat")}
              </Button>
            </div>
          </Match>

          <Match when={status() === "loading"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-12 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />
              <p class="text-14-regular text-text-base">{loadingMsg() || language.t("wechat.startingBridge")}</p>
              <p class="text-12-regular text-text-weak">{language.t("wechat.autoInstall")}</p>
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
              <p class="text-14-regular text-text-base">{language.t("wechat.scanQRCode")}</p>
              <Button variant="ghost" onClick={stopBridge}>
                {language.t("wechat.cancel")}
              </Button>
            </div>
          </Match>

          <Match when={status() === "reconnecting"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-12 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />
              <p class="text-14-regular text-text-base">{language.t("wechat.reconnectingWechat")}</p>
              <Button variant="ghost" onClick={stopBridge}>
                {language.t("wechat.cancel")}
              </Button>
            </div>
          </Match>

          <Match when={status() === "connected"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-success flex items-center justify-center">
                <Icon name="check-small" size="large" class="text-icon-success-base" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">{language.t("wechat.connected")}</p>
                <Show when={user()}>
                  <p class="text-14-regular text-text-weak">{user()!.name}</p>
                </Show>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={stopBridge}>
                  {language.t("wechat.disconnect")}
                </Button>
                <Button variant="ghost" onClick={logout}>
                  {language.t("wechat.switchAccount")}
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
                <p class="text-16-medium text-text-strong">{language.t("wechat.connectionFailed")}</p>
                <Show when={error()}>
                  <p class="text-14-regular text-text-weak text-center max-w-xs">{error()!.message}</p>
                </Show>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  {language.t("wechat.close")}
                </Button>
                <Button variant="primary" onClick={() => startBridge(true, currentModelStr())}>
                  {language.t("wechat.retry")}
                </Button>
              </div>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
