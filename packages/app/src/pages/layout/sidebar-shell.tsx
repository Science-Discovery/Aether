import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { type LocalProject } from "@/context/layout"
import { useAuth } from "@/context/auth"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { showToast } from "@opencode-ai/ui/toast"
import { status as mobileStatus, type MobilePlatform } from "@/context/mobile"

export const SidebarContent = (props: {
  mobile?: boolean
  opened: Accessor<boolean>
  aimMove: (event: MouseEvent) => void
  projects: Accessor<LocalProject[]>
  renderProject: (project: LocalProject) => JSX.Element
  handleDragStart: (event: unknown) => void
  handleDragEnd: () => void
  handleDragOver: (event: DragEvent) => void
  showNewProject?: boolean
  newProjectLabel: JSX.Element
  onNewProject: () => void
  openProjectLabel: JSX.Element
  openProjectKeybind: Accessor<string | undefined>
  onOpenProject: () => void
  renderProjectOverlay: () => JSX.Element
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
  onOpenSettings: () => void

  helpLabel: Accessor<string>
  onOpenHelp: () => void
  renderPanel: () => JSX.Element
}): JSX.Element => {
  const expanded = createMemo(() => !!props.mobile || props.opened())
  const placement = () => (props.mobile ? "bottom" : "right")
  const auth = useAuth()
  const dialog = useDialog()
  const language = useLanguage()
  const agg = createMemo(() => {
    const w = mobileStatus("wechat")
    const q = mobileStatus("qq")
    const f = mobileStatus("feishu")
    const anyConnected = w === "connected" || q === "connected" || f === "connected"
    const anyLoading =
      w === "loading" ||
      w === "qrcode" ||
      w === "reconnecting" ||
      q === "loading" ||
      q === "reconnecting" ||
      f === "loading" ||
      f === "reconnecting"
    const anyError = w === "error" || w === "stolen" || q === "error" || f === "error"
    return { anyConnected, anyLoading, anyError }
  })
  let panel: HTMLDivElement | undefined
  let authDialogRun = 0

  function openLogin() {
    const run = ++authDialogRun
    void import("@/components/dialog-login").then((x) => {
      if (authDialogRun !== run) return
      dialog.show(() => <x.DialogLogin />)
    })
  }

  function openMobile(platform: MobilePlatform) {
    void import("@/components/dialog-mobile").then((x) => {
      dialog.show(() => <x.DialogMobile platform={platform} />)
    })
  }

  async function handleLogout() {
    await auth.logout()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("auth.logout.success.title"),
    })
  }

  createEffect(() => {
    const el = panel
    if (!el) return
    if (expanded()) {
      el.removeAttribute("inert")
      return
    }
    el.setAttribute("inert", "")
  })

  return (
    <div class="flex h-full w-full min-w-0 overflow-hidden">
      <div
        data-component="sidebar-rail"
        class="w-16 shrink-0 bg-background-base flex flex-col items-center overflow-hidden"
        onMouseMove={props.aimMove}
      >
        <div class="flex-1 min-h-0 w-full">
          <DragDropProvider
            onDragStart={props.handleDragStart}
            onDragEnd={props.handleDragEnd}
            onDragOver={props.handleDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragXAxis />
            <div class="h-full w-full flex flex-col items-center gap-3 px-3 py-3 overflow-y-auto no-scrollbar">
              <SortableProvider ids={props.projects().map((p) => p.worktree)}>
                <For each={props.projects()}>{(project) => props.renderProject(project)}</For>
              </SortableProvider>
              <Show when={props.showNewProject !== false}>
                <Tooltip placement={placement()} value={props.newProjectLabel}>
                  <IconButton
                    icon="new-session"
                    variant="ghost"
                    size="large"
                    onClick={props.onNewProject}
                    aria-label={typeof props.newProjectLabel === "string" ? props.newProjectLabel : undefined}
                  />
                </Tooltip>
              </Show>
              <Tooltip
                placement={placement()}
                value={
                  <div class="flex items-center gap-2">
                    <span>{props.openProjectLabel}</span>
                    <Show when={!props.mobile && !!props.openProjectKeybind()}>
                      <span class="text-icon-base text-12-medium">{props.openProjectKeybind()}</span>
                    </Show>
                  </div>
                }
              >
                <IconButton
                  icon="plus"
                  variant="ghost"
                  size="large"
                  onClick={props.onOpenProject}
                  aria-label={typeof props.openProjectLabel === "string" ? props.openProjectLabel : undefined}
                />
              </Tooltip>
            </div>
            <DragOverlay>{props.renderProjectOverlay()}</DragOverlay>
          </DragDropProvider>
        </div>
        <div class="shrink-0 w-full pt-3 pb-6 flex flex-col items-center gap-2">
          <Show
            when={auth.isAuthenticated && auth.account}
            fallback={
              <Tooltip placement={placement()} value={language.t("auth.login.submit")}>
                <IconButton
                  icon="user"
                  variant="ghost"
                  size="large"
                  onClick={openLogin}
                  aria-label={language.t("auth.login.submit")}
                />
              </Tooltip>
            }
          >
            {(account) => (
              <DropdownMenu>
                <Tooltip placement={placement()} value={account().name || account().email}>
                  <DropdownMenu.Trigger
                    as={IconButton}
                    icon="user"
                    variant="ghost"
                    size="large"
                    aria-label={account().name || account().email}
                  />
                </Tooltip>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="mt-1">
                    <DropdownMenu.Item disabled>
                      <DropdownMenu.ItemLabel class="text-text-weak">{account().email}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item onSelect={handleLogout}>
                      <DropdownMenu.ItemLabel>{language.t("auth.logout.submit")}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            )}
          </Show>
          <DropdownMenu placement="right" gutter={8}>
            <Tooltip placement={placement()} value={language.t("knowledgeBase.mobileConnection")}>
              <DropdownMenu.Trigger
                as={IconButton}
                icon="phone"
                variant="ghost"
                size="large"
                aria-label={language.t("knowledgeBase.mobileConnection")}
                classList={{
                  "text-green-500": agg().anyConnected,
                  "text-yellow-500 animate-pulse": agg().anyLoading && !agg().anyConnected,
                  "text-red-500": agg().anyError && !agg().anyConnected,
                }}
              />
            </Tooltip>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="ml-2">
                <DropdownMenu.Item onSelect={() => openMobile("wechat")}>
                  <div class="flex items-center gap-2">
                    <Icon
                      name="wechat"
                      size="small"
                      classList={{
                        "text-green-500": mobileStatus("wechat") === "connected",
                        "text-yellow-500":
                          mobileStatus("wechat") === "loading" ||
                          mobileStatus("wechat") === "qrcode" ||
                          mobileStatus("wechat") === "reconnecting",
                        "text-red-500": mobileStatus("wechat") === "error" || mobileStatus("wechat") === "stolen",
                      }}
                    />
                    <DropdownMenu.ItemLabel>{language.t("knowledgeBase.wechatConnection")}</DropdownMenu.ItemLabel>
                  </div>
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => openMobile("qq")}>
                  <div class="flex items-center gap-2">
                    <Icon
                      name="qq"
                      size="small"
                      classList={{
                        "text-blue-500": mobileStatus("qq") === "connected",
                        "text-yellow-500": mobileStatus("qq") === "loading" || mobileStatus("qq") === "reconnecting",
                        "text-red-500": mobileStatus("qq") === "error",
                      }}
                    />
                    <DropdownMenu.ItemLabel>{language.t("knowledgeBase.qqConnection")}</DropdownMenu.ItemLabel>
                  </div>
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => openMobile("feishu")}>
                  <div class="flex items-center gap-2">
                    <Icon
                      name="feishu"
                      size="small"
                      classList={{
                        "text-green-500": mobileStatus("feishu") === "connected",
                        "text-yellow-500": mobileStatus("feishu") === "loading",
                        "text-red-500": mobileStatus("feishu") === "error",
                      }}
                    />
                    <DropdownMenu.ItemLabel>{language.t("knowledgeBase.feishuConnection")}</DropdownMenu.ItemLabel>
                  </div>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
          <TooltipKeybind placement={placement()} title={props.settingsLabel()} keybind={props.settingsKeybind() ?? ""}>
            <IconButton
              icon="settings-gear"
              variant="ghost"
              size="large"
              onClick={props.onOpenSettings}
              aria-label={props.settingsLabel()}
            />
          </TooltipKeybind>
          <Tooltip placement={placement()} value={props.helpLabel()}>
            <IconButton
              icon="help"
              variant="ghost"
              size="large"
              onClick={props.onOpenHelp}
              aria-label={props.helpLabel()}
            />
          </Tooltip>
        </div>
      </div>

      <div
        ref={(el) => {
          panel = el
        }}
        classList={{ "flex-1 flex h-full min-h-0 min-w-0 overflow-hidden": true, "pointer-events-none": !expanded() }}
        aria-hidden={!expanded()}
      >
        {props.renderPanel()}
      </div>
    </div>
  )
}
