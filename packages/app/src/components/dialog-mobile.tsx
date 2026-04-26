import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Component, Show, Switch, Match, createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useServer } from "@/context/server"
import { useModels } from "@/context/models"
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
  setStatus,
  type MobilePlatform,
} from "@/context/mobile"

interface Props {
  platform: MobilePlatform
}

const LABELS: Record<MobilePlatform, { title: string; connect: string; loading: string }> = {
  feishu: { title: "飞书连接", connect: "连接飞书", loading: "正在连接飞书..." },
  qq: { title: "QQ连接", connect: "连接QQ", loading: "正在连接QQ..." },
  wechat: { title: "微信连接", connect: "连接微信", loading: "正在启动微信桥接..." },
}

const platformName = (p: MobilePlatform) => (p === "feishu" ? "飞书" : p === "qq" ? "QQ" : "微信")

const iconName = (p: MobilePlatform) =>
  p === "feishu" ? ("feishu" as const) : p === "qq" ? ("qq" as const) : ("wechat" as const)

export const DialogMobile: Component<Props> = (props) => {
  const dialog = useDialog()
  const server = useServer()
  const models = useModels()
  const [inputAppId, setInputAppId] = createSignal("")
  const [inputAppSecret, setInputAppSecret] = createSignal("")
  const [steps, setSteps] = createStore({ 1: false, 2: false, 3: false, 4: false, 5: false })

  const p = () => props.platform
  const label = () => LABELS[p()]

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
      title={label().title}
      size={p() === "feishu" || p() === "qq" ? "large" : undefined}
      class={p() === "feishu" || p() === "qq" ? "max-w-lg" : "max-w-md"}
    >
      <div class="flex flex-col items-center gap-6 p-6">
        <Switch fallback={<div />}>
          <Match when={p() === "wechat" && locked("wechat")}>
            <div class="flex flex-col items-center gap-4">
              <Icon name={iconName(p())} size="large" class="size-16 text-icon-weak" />
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
                <Button variant="primary" onClick={doForceTakeover}>
                  强制接管
                </Button>
              </div>
            </div>
          </Match>

          <Match when={status(p()) === "stolen"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name="warning" size="large" class="size-16 text-icon-warning" />
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">连接已被接管</p>
                <p class="text-14-regular text-text-weak text-center">
                  {platformName(props.platform)}连接已被其他客户端或服务接管
                </p>
              </div>
              <Button variant="primary" onClick={doStart}>
                重新连接
              </Button>
            </div>
          </Match>

          <Match when={status(p()) === "idle"}>
            <div class="flex flex-col items-center gap-4">
              <Icon name={iconName(p())} size="large" class="size-16 text-icon-base" />
              <p class="text-14-regular text-text-base text-center">
                连接{platformName(props.platform)}后，可在{platformName(props.platform)}中使用 Aether AI
              </p>
              <Show
                when={(p() === "feishu" || p() === "qq") && hasConfig(p())}
                fallback={
                  p() === "feishu" || p() === "qq" ? (
                    <Button variant="primary" onClick={() => setStatus(p(), "config")}>
                      配置{platformName(props.platform)}应用
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={doStart}>
                      {label().connect}
                    </Button>
                  )
                }
              >
                <div class="flex gap-2">
                  <Button variant="primary" onClick={doStart}>
                    {label().connect}
                  </Button>
                  <Button variant="ghost" onClick={() => setStatus(p(), "config")}>
                    重新配置
                  </Button>
                </div>
              </Show>
            </div>
          </Match>

          <Match when={status(p()) === "config"}>
            <Show when={p() === "feishu" || p() === "qq"}>
              <div class="flex flex-col gap-4 w-full">
                <div class="w-full flex flex-col gap-3">
                  <div class="flex flex-col gap-1">
                    <label class="text-12-medium text-text-base">App ID</label>
                    <input
                      type="text"
                      value={inputAppId()}
                      onInput={(e) => setInputAppId(e.currentTarget.value)}
                      placeholder={p() === "qq" ? "10xxxxxx" : "cli_xxxxxxxx"}
                      class="w-full px-3 py-2 rounded-md border border-border-base bg-surface-base text-text-base text-13-regular focus:outline-none focus:border-border-focus"
                    />
                  </div>
                  <div class="flex flex-col gap-1">
                    <label class="text-12-medium text-text-base">App Secret</label>
                    <input
                      type="password"
                      value={inputAppSecret()}
                      onInput={(e) => setInputAppSecret(e.currentTarget.value)}
                      placeholder="输入 App Secret"
                      class="w-full px-3 py-2 rounded-md border border-border-base bg-surface-base text-text-base text-13-regular focus:outline-none focus:border-border-focus"
                    />
                  </div>
                  <div class="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setStatus(p(), "idle")}>
                      取消
                    </Button>
                    <Button variant="primary" disabled={!inputAppId() || !inputAppSecret()} onClick={doStart}>
                      连接
                    </Button>
                  </div>
                </div>
                <div class="w-full flex flex-col gap-1 pt-2 border-t border-border-base max-h-[280px] overflow-y-auto">
                  <Show when={p() === "feishu"}>
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
                              <li>填写应用名称和描述</li>
                              <li>
                                获取 <strong class="text-text-base">App ID</strong> 和{" "}
                                <strong class="text-text-base">App Secret</strong>
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
                              <li>在「添加应用能力」找到「机器人」并添加</li>
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
                              <li>在「事件与回调」→「事件配置」</li>
                              <li>
                                选择：<strong class="text-text-base">使用长连接接收事件</strong>
                              </li>
                              <li>
                                添加事件：
                                <code class="text-12-regular bg-surface-muted px-1 rounded">im.message.receive_v1</code>
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
                            <ul class="text-13-regular text-text-weak space-y-1">
                              <li>
                                <code class="text-12-regular bg-surface-muted px-1 rounded">im:message</code> —
                                获取与发送消息
                              </li>
                              <li>
                                <code class="text-12-regular bg-surface-muted px-1 rounded">
                                  im:message:send_as_bot
                                </code>{" "}
                                — 以机器人身份发送消息
                              </li>
                              <li>
                                <code class="text-12-regular bg-surface-muted px-1 rounded">im:resource</code> —
                                上传文件资源
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
                              <li>创建版本并提交审核</li>
                              <li>管理员审核通过后即可使用</li>
                            </ol>
                          </Collapsible.Content>
                        </Collapsible>
                      </Collapsible.Content>
                    </Collapsible>
                  </Show>
                  <Show when={p() === "qq"}>
                    <Collapsible open={true} variant="ghost">
                      <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                        <Collapsible.Arrow />
                        <span class="text-13-medium text-text-strong">
                          按以下步骤在QQ开放平台配置机器人【点击展开每步细节】
                        </span>
                      </Collapsible.Trigger>
                      <Collapsible.Content class="flex flex-col gap-1">
                        <Collapsible open={steps[1]} onOpenChange={(v) => setSteps(1, v)} variant="ghost">
                          <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                            <Collapsible.Arrow />
                            <span class="text-13-medium text-text-strong">第一步：注册并创建机器人</span>
                          </Collapsible.Trigger>
                          <Collapsible.Content class="px-2 pb-2">
                            <ol class="text-13-regular text-text-weak list-decimal list-outside ml-4 space-y-1">
                              <li>
                                打开{" "}
                                <a
                                  href="https://q.qq.com"
                                  target="_blank"
                                  rel="noopener"
                                  class="text-text-link underline"
                                >
                                  QQ开放平台
                                </a>
                                ，选择个人或企业入驻
                              </li>
                              <li>点击「创建机器人」，填写资料</li>
                              <li>
                                获取 <strong class="text-text-base">AppID</strong> 和{" "}
                                <strong class="text-text-base">AppSecret</strong>
                              </li>
                            </ol>
                          </Collapsible.Content>
                        </Collapsible>
                        <Collapsible open={steps[2]} onOpenChange={(v) => setSteps(2, v)} variant="ghost">
                          <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                            <Collapsible.Arrow />
                            <span class="text-13-medium text-text-strong">第二步：配置开发场景</span>
                          </Collapsible.Trigger>
                          <Collapsible.Content class="px-2 pb-2">
                            <ol class="text-13-regular text-text-weak list-decimal list-outside ml-4 space-y-1">
                              <li>在开发基础设置页面获取 AppID 和 AppSecret</li>
                              <li>配置沙箱环境（测试群/频道/单聊）</li>
                              <li>将机器人添加至沙箱群或沙箱频道进行测试</li>
                            </ol>
                          </Collapsible.Content>
                        </Collapsible>
                        <Collapsible open={steps[3]} onOpenChange={(v) => setSteps(3, v)} variant="ghost">
                          <Collapsible.Trigger class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md hover:bg-surface-muted cursor-pointer">
                            <Collapsible.Arrow />
                            <span class="text-13-medium text-text-strong">第三步：发布上线</span>
                          </Collapsible.Trigger>
                          <Collapsible.Content class="px-2 pb-2">
                            <ol class="text-13-regular text-text-weak list-decimal list-outside ml-4 space-y-1">
                              <li>填写自测报告并提交审核</li>
                              <li>审核通过后手动上线</li>
                              <li>用户可在QQ客户端添加机器人</li>
                            </ol>
                          </Collapsible.Content>
                        </Collapsible>
                      </Collapsible.Content>
                    </Collapsible>
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
                <p class="text-12-regular text-text-weak">首次使用将自动安装运行环境，可能需要几分钟</p>
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
                <p class="text-14-regular text-text-base">请用微信扫描二维码登录</p>
                <Button variant="ghost" onClick={() => stopBridge("wechat")}>
                  取消
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
                <p class="text-16-medium text-text-strong">正在重连{platformName(props.platform)}</p>
                <p class="text-14-regular text-text-weak text-center max-w-xs">{loadingMsg(p())}</p>
              </div>
              <Button variant="ghost" onClick={() => stopBridge(p())}>
                取消
              </Button>
            </div>
          </Match>

          <Match when={status(p()) === "connected"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-success flex items-center justify-center">
                <Icon name="check-small" size="large" class="text-icon-success-base" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">已连接{platformName(props.platform)}</p>
                <Show when={(p() === "feishu" || p() === "qq") && appId(p())}>
                  <p class="text-14-regular text-text-weak">App: {appId(p())!.slice(0, 16)}...</p>
                </Show>
                <Show when={user(p())}>
                  <p class="text-14-regular text-text-weak">{user(p())!.name}</p>
                </Show>
              </div>
              <Show when={p() === "feishu" || p() === "qq"}>
                <div class="w-full text-13-regular text-text-weak bg-surface-muted rounded-md p-3 space-y-1">
                  <p class="text-12-medium text-text-base">使用方式</p>
                  <p>私聊：直接给机器人发消息</p>
                  <p>
                    群聊：需要 <strong class="text-text-base">@机器人</strong> 才会触发回复
                  </p>
                </div>
              </Show>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={() => stopBridge(p())}>
                  断开连接
                </Button>
                <Button variant="ghost" onClick={() => logout(p())}>
                  {p() === "wechat" ? "切换账号" : "切换应用"}
                </Button>
              </div>
            </div>
          </Match>

          <Match when={status(p()) === "error"}>
            <div class="flex flex-col items-center gap-4">
              <div class="size-16 rounded-full bg-surface-error flex items-center justify-center">
                <Icon name="warning" size="large" class="text-icon-error-base" />
              </div>
              <div class="flex flex-col items-center gap-1">
                <p class="text-16-medium text-text-strong">连接失败</p>
                <Show when={error(p())}>
                  <p class="text-14-regular text-text-weak text-center max-w-xs">{error(p())!.message}</p>
                </Show>
              </div>
              <div class="flex gap-2">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  关闭
                </Button>
                <Button variant="primary" onClick={doRetry}>
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
