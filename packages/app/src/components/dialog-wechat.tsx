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
    <Dialog title="微信连接" class="max-w-md">
      <div class="flex flex-col items-center gap-6 p-6">
        <Switch fallback={<div />}>
          <Match when={locked()}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="wechat" size="large" class="size-16 text-icon-weak" />
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">微信已被其他客户端连接</p>
                <p class="text-14-regular text-text-weak text-center">
                  当前有另一个页面正在使用微信，请先在该页面断开连接
                </p>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  关闭
                </Button>
                <Button variant="primary" onClick={() => forceTakeover(currentModelStr())}>
                  强制接管
                </Button>
              </div>
            </div>
          </Match>

          <Match when={status() === "stolen"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="warning" size="large" class="size-16 text-icon-warning" />
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">连接已被接管</p>
                <p class="text-14-regular text-text-weak text-center">微信连接已被其他客户端或服务接管</p>
              </div>
              <Button variant="primary" onClick={() => startBridge(true, currentModelStr())}>
                重新连接
              </Button>
            </div>
          </Match>

          <Match when={status() === "idle"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="wechat" size="large" class="size-16 text-icon-base" />
              <p class="text-14-regular text-text-base text-center">连接微信后，可在微信中使用 Aether AI</p>
              <Button variant="primary" onClick={() => startBridge(true, currentModelStr())}>
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

          <Match when={status() === "reconnecting"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-12 animate-spin rounded-full border-2 border-icon-weak border-t-icon-base" />
              <p class="text-14-regular text-text-base">正在重新连接微信...</p>
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
                <Button variant="primary" onClick={() => startBridge(true, currentModelStr())}>
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
