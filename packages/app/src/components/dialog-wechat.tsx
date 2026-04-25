import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Component, Show, Switch, Match } from "solid-js"
import { useModels } from "@/context/models"
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

  const currentModelStr = () => {
    const m = models.recent.list()[0]
    return m ? `${m.providerID}/${m.modelID}` : undefined
  }

  return (
    <Dialog title="WeChat Connection" class="max-w-md">
      <div class="flex flex-col items-center gap-6 p-6">
        <Switch fallback={<div />}>
          <Match when={locked()}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="wechat" size="large" class="size-16 text-icon-weak" />
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">WeChat is connected by another client</p>
                <p class="text-14-regular text-text-weak text-center">
                  Another page is currently using WeChat, please disconnect first
                </p>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  Close
                </Button>
                <Button variant="primary" onClick={() => forceTakeover(currentModelStr())}>
                  Force Takeover
                </Button>
              </div>
            </div>
          </Match>

          <Match when={status() === "stolen"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="warning" size="large" class="size-16 text-icon-warning" />
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">Connection Taken Over</p>
                <p class="text-14-regular text-text-weak text-center">
                  WeChat connection has been taken over by another client or service
                </p>
              </div>
              <Button variant="primary" onClick={() => startBridge(true, currentModelStr())}>
                Reconnect
              </Button>
            </div>
          </Match>

          <Match when={status() === "idle"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="wechat" size="large" class="size-16 text-icon-base" />
              <p class="text-14-regular text-text-base text-center">Connect WeChat to use Aether AI in WeChat</p>
              <Button variant="primary" onClick={() => startBridge(true, currentModelStr())}>
                Connect WeChat
              </Button>
            </div>
          </Match>

          <Match when={status() === "loading"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-12 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />
              <p class="text-14-regular text-text-base">{loadingMsg()}</p>
              <p class="text-12-regular text-text-weak">
                First-time use will auto-install the runtime, which may take a few minutes
              </p>
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
              <p class="text-14-regular text-text-base">Please scan the QR code with WeChat to log in</p>
              <Button variant="ghost" onClick={stopBridge}>
                Cancel
              </Button>
            </div>
          </Match>

          <Match when={status() === "reconnecting"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-12 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />
              <p class="text-14-regular text-text-base">Reconnecting WeChat...</p>
              <Button variant="ghost" onClick={stopBridge}>
                Cancel
              </Button>
            </div>
          </Match>

          <Match when={status() === "connected"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-success flex items-center justify-center">
                <Icon name="check-small" size="large" class="text-icon-success-base" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">WeChat Connected</p>
                <Show when={user()}>
                  <p class="text-14-regular text-text-weak">{user()!.name}</p>
                </Show>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={stopBridge}>
                  Disconnect
                </Button>
                <Button variant="ghost" onClick={logout}>
                  Switch Account
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
                <p class="text-16-medium text-text-strong">Connection Failed</p>
                <Show when={error()}>
                  <p class="text-14-regular text-text-weak text-center max-w-xs">{error()!.message}</p>
                </Show>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  Close
                </Button>
                <Button variant="primary" onClick={() => startBridge(true, currentModelStr())}>
                  Retry
                </Button>
              </div>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
