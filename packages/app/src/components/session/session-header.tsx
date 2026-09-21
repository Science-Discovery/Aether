import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { PdfConvertProgressBar } from "@/components/pdf-convert-progress"
import { Keybind } from "@opencode-ai/ui/keybind"
import { Popover } from "@opencode-ai/ui/popover"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { getFilename } from "@opencode-ai/util/path"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import FileTree from "@/components/file-tree"
import { useCommand } from "@/context/command"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { resolveProject } from "@/context/global-sync/bootstrap"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { createOpenSessionFileTab, focusTerminalById } from "@/pages/session/helpers"
import { createFileActions } from "@/pages/session/file-actions"
import { useSessionLayout } from "@/pages/session/session-layout"
import { messageAgentColor } from "@/utils/agent"
import { decode64 } from "@/utils/base64"
import { Persist, persisted } from "@/utils/persist"
import { StatusPopover } from "../status-popover"

const OPEN_APPS = [
  "vscode",
  "cursor",
  "zed",
  "textmate",
  "antigravity",
  "finder",
  "terminal",
  "iterm2",
  "ghostty",
  "warp",
  "xcode",
  "android-studio",
  "powershell",
  "sublime-text",
] as const

type OpenApp = (typeof OPEN_APPS)[number]
type OS = "macos" | "windows" | "linux" | "unknown"

const MAC_APPS = [
  {
    id: "vscode",
    label: "session.header.open.app.vscode",
    icon: "vscode",
    openWith: "Visual Studio Code",
  },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "Cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "Zed" },
  { id: "textmate", label: "session.header.open.app.textmate", icon: "textmate", openWith: "TextMate" },
  {
    id: "antigravity",
    label: "session.header.open.app.antigravity",
    icon: "antigravity",
    openWith: "Antigravity",
  },
  { id: "terminal", label: "session.header.open.app.terminal", icon: "terminal", openWith: "Terminal" },
  { id: "iterm2", label: "session.header.open.app.iterm2", icon: "iterm2", openWith: "iTerm" },
  { id: "ghostty", label: "session.header.open.app.ghostty", icon: "ghostty", openWith: "Ghostty" },
  { id: "warp", label: "session.header.open.app.warp", icon: "warp", openWith: "Warp" },
  { id: "xcode", label: "session.header.open.app.xcode", icon: "xcode", openWith: "Xcode" },
  {
    id: "android-studio",
    label: "session.header.open.app.androidStudio",
    icon: "android-studio",
    openWith: "Android Studio",
  },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

const WINDOWS_APPS = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  {
    id: "powershell",
    label: "session.header.open.app.powershell",
    icon: "powershell",
    openWith: "powershell",
  },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

const LINUX_APPS = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

const detectOS = (platform: ReturnType<typeof usePlatform>): OS => {
  if (platform.platform === "desktop" && platform.os) return platform.os
  if (typeof navigator !== "object") return "unknown"
  const value = navigator.platform || navigator.userAgent
  if (/Mac/i.test(value)) return "macos"
  if (/Win/i.test(value)) return "windows"
  if (/Linux/i.test(value)) return "linux"
  return "unknown"
}

const showRequestError = (language: ReturnType<typeof useLanguage>, err: unknown) => {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

/** Search-files button. Rendered at the left end of the titlebar right cluster. */
export function SessionSearchFiles() {
  const layout = useLayout()
  const command = useCommand()
  const language = useLanguage()
  const { params } = useSessionLayout()

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const name = createMemo(() => {
    const directory = projectDirectory()
    const project = resolveProject(directory, layout.projects.list())
    if (project) return project.name || getFilename(project.worktree)
    return getFilename(directory)
  })
  const hotkey = createMemo(() => command.keybind("file.open"))

  return (
    <Button
      type="button"
      variant="ghost"
      size="small"
      class="hidden md:flex w-[120px] max-w-full min-w-0 items-center gap-2 justify-between rounded-md border border-border-weak-base bg-surface-panel shadow-none cursor-default"
      onClick={() => command.trigger("file.open")}
      aria-label={language.t("session.header.searchFiles")}
    >
      <div class="flex min-w-0 flex-1 items-center overflow-visible">
        <span class="flex-1 min-w-0 text-12-regular text-text-weak truncate text-left">
          {language.t("session.header.search.placeholder", {
            project: name(),
          })}
        </span>
      </div>

      <Show when={hotkey()}>
        {(keybind) => (
          <Keybind class="shrink-0 !border-0 !bg-transparent !shadow-none px-0 text-text-weaker">{keybind()}</Keybind>
        )}
      </Show>
    </Button>
  )
}

export function SessionHeader() {
  const layout = useLayout()
  const command = useCommand()
  const server = useServer()
  const platform = usePlatform()
  const sdk = useSDK()
  const language = useLanguage()
  const sync = useSync()
  const terminal = useTerminal()
  const file = useFile()
  const { params, view, tabs } = useSessionLayout()

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const name = createMemo(() => {
    const directory = projectDirectory()
    const project = layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
    if (project) return project.name || getFilename(project.worktree)
    return getFilename(directory)
  })
  const os = createMemo(() => detectOS(platform))

  const [exists, setExists] = createStore<Partial<Record<OpenApp, boolean>>>({
    finder: true,
  })

  const apps = createMemo(() => {
    if (os() === "macos") return MAC_APPS
    if (os() === "windows") return WINDOWS_APPS
    return LINUX_APPS
  })

  const fileManager = createMemo(() => {
    if (os() === "macos") return { label: "session.header.open.finder", icon: "finder" as const }
    if (os() === "windows") return { label: "session.header.open.fileExplorer", icon: "file-explorer" as const }
    return { label: "session.header.open.fileManager", icon: "finder" as const }
  })

  createEffect(() => {
    if (platform.platform !== "desktop") return
    if (!platform.checkAppExists) return

    const list = apps()

    setExists(Object.fromEntries(list.map((app) => [app.id, undefined])) as Partial<Record<OpenApp, boolean>>)

    void Promise.all(
      list.map((app) =>
        Promise.resolve(platform.checkAppExists?.(app.openWith))
          .then((value) => Boolean(value))
          .catch(() => false)
          .then((ok) => [app.id, ok] as const),
      ),
    ).then((entries) => {
      setExists(Object.fromEntries(entries) as Partial<Record<OpenApp, boolean>>)
    })
  })

  const options = createMemo(() => {
    return [
      { id: "finder", label: language.t(fileManager().label), icon: fileManager().icon },
      ...apps()
        .filter((app) => exists[app.id])
        .map((app) => ({ ...app, label: language.t(app.label) })),
    ] as const
  })

  const toggleTerminal = () => {
    const next = !view().terminal.opened()
    view().terminal.toggle()
    if (!next) return

    const id = terminal.active()
    if (!id) return
    focusTerminalById(id)
  }

  const terminalTitle = () => language.t(view().terminal.opened() ? "command.terminal.close" : "command.terminal.open")
  const reviewTitle = () => language.t(view().reviewPanel.opened() ? "command.review.close" : "command.review.open")
  const fileTreeTitle = () => language.t(layout.fileTree.opened() ? "command.fileTree.close" : "command.fileTree.open")

  const [prefs] = persisted(Persist.global("open.app"), createStore({ app: "finder" as OpenApp }))
  const [menu, setMenu] = createStore({ open: false })
  const [openRequest, setOpenRequest] = createStore({
    app: undefined as OpenApp | undefined,
  })

  const canOpen = createMemo(() => {
    if (!server.isLocal()) return false
    if (platform.platform === "desktop") return !!platform.openPath
    return platform.platform === "web"
  })
  const current = createMemo(
    () =>
      options().find((o) => o.id === prefs.app) ??
      options()[0] ??
      ({ id: "finder", label: fileManager().label, icon: fileManager().icon } as const),
  )
  const opening = createMemo(() => openRequest.app !== undefined)
  const tint = createMemo(() =>
    messageAgentColor(params.id ? sync.data.message[params.id] : undefined, sync.data.agent),
  )

  const openDir = (app: OpenApp) => {
    if (opening() || !canOpen()) return
    const directory = projectDirectory()
    if (!directory) return

    const item = options().find((o) => o.id === app)
    const openWith = item && "openWith" in item ? item.openWith : undefined
    setOpenRequest("app", app)
    const task =
      platform.platform === "desktop" && platform.openPath
        ? platform.openPath(directory, openWith)
        : sdk.client.file.open({ path: directory, app: openWith }).then(() => undefined)
    task
      .catch((err: unknown) => showRequestError(language, err))
      .finally(() => {
        setOpenRequest("app", undefined)
      })
  }

  const copyPath = () => {
    const directory = projectDirectory()
    if (!directory) return
    navigator.clipboard
      .writeText(directory)
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("session.share.copy.copied"),
          description: directory,
        })
      })
      .catch((err: unknown) => showRequestError(language, err))
  }

  const openFileTab = createOpenSessionFileTab({
    normalizeTab: (value: string) => (value.startsWith("file://") ? file.tab(value) : value),
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel: () => {
      if (!view().reviewPanel.opened()) view().reviewPanel.open()
    },
    setActive: tabs().setActive,
  })

  const actions = createFileActions({
    tabs,
    refresh: () => {
      if (params.id) void sync.session.diff(params.id, { force: true })
    },
  })

  const pickFile = (node: FileNode) => {
    if (node.type !== "file") return
    setMenu("open", false)
    openFileTab(file.tab(node.path))
  }

  const leftMount = createMemo(() => document.getElementById("opencode-titlebar-left"))
  const rightMount = createMemo(() => document.getElementById("opencode-titlebar-right"))

  return (
    <>
      <Show when={leftMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="flex items-center gap-1">
              <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
                <StatusPopover />
              </Tooltip>
              <TooltipKeybind
                placement="bottom"
                hideOnExpand={false}
                title={terminalTitle()}
                keybind={command.keybind("terminal.toggle")}
              >
                <Button
                  variant="ghost"
                  class="group/terminal-toggle titlebar-icon w-8 h-6 p-0 box-border shrink-0"
                  onClick={toggleTerminal}
                  aria-label={terminalTitle()}
                  aria-expanded={view().terminal.opened()}
                  aria-controls="terminal-panel"
                >
                  <Icon size="small" name={view().terminal.opened() ? "terminal-active" : "terminal"} />
                </Button>
              </TooltipKeybind>

              <div class="hidden md:flex items-center gap-1 shrink-0">
                <TooltipKeybind hideOnExpand={false} title={reviewTitle()} keybind={command.keybind("review.toggle")}>
                  <Button
                    variant="ghost"
                    class="group/review-toggle titlebar-icon w-8 h-6 p-0 box-border"
                    onClick={() => view().reviewPanel.toggle()}
                    aria-label={reviewTitle()}
                    aria-expanded={view().reviewPanel.opened()}
                    aria-controls="review-panel"
                  >
                    <Icon size="small" name={view().reviewPanel.opened() ? "review-active" : "review"} />
                  </Button>
                </TooltipKeybind>

                <TooltipKeybind
                  hideOnExpand={false}
                  title={fileTreeTitle()}
                  keybind={command.keybind("fileTree.toggle")}
                >
                  <Button
                    variant="ghost"
                    class="titlebar-icon w-8 h-6 p-0 box-border"
                    onClick={() => layout.fileTree.toggle()}
                    aria-label={fileTreeTitle()}
                    aria-expanded={layout.fileTree.opened()}
                    aria-controls="file-tree-panel"
                  >
                    <div class="relative flex items-center justify-center size-4">
                      <Icon
                        size="small"
                        name={layout.fileTree.opened() ? "file-tree-active" : "file-tree"}
                        classList={{
                          "text-icon-strong": layout.fileTree.opened(),
                          "text-icon-weak": !layout.fileTree.opened(),
                        }}
                      />
                    </div>
                  </Button>
                </TooltipKeybind>
              </div>
            </div>
          </Portal>
        )}
      </Show>
      <Show when={rightMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="flex items-center gap-2">
              <SessionSearchFiles />
              <PdfConvertProgressBar />
              <Show when={projectDirectory()}>
                <div class="flex items-center shrink-0">
                  <Show
                    when={canOpen()}
                    fallback={
                      <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden">
                        <Button
                          variant="ghost"
                          class="rounded-none h-full py-0 pr-3 pl-0.5 gap-1.5 border-none shadow-none"
                          onClick={copyPath}
                          aria-label={language.t("session.header.open.copyPath")}
                        >
                          <Icon name="copy" size="small" class="text-icon-base" />
                          <span class="text-12-regular text-text-strong">
                            {language.t("session.header.open.copyPath")}
                          </span>
                        </Button>
                      </div>
                    }
                  >
                    <Tooltip placement="bottom" value={language.t("session.header.open.folder")}>
                      <div class="flex items-center">
                        <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden">
                          <Button
                            variant="ghost"
                            class="rounded-none h-full px-0.5 border-none shadow-none disabled:!cursor-default"
                            classList={{
                              "bg-surface-raised-base-active": opening(),
                            }}
                            onClick={() => openDir(current().id)}
                            disabled={opening()}
                            aria-label={language.t("session.header.open.ariaLabel", { app: current().label })}
                          >
                            <div class="flex size-5 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-5">
                              <Show when={opening()} fallback={<AppIcon id={current().icon} />}>
                                <Spinner class="size-3.5" style={{ color: tint() ?? "var(--icon-base)" }} />
                              </Show>
                            </div>
                          </Button>
                          <Popover
                            gutter={4}
                            placement="bottom-end"
                            open={menu.open}
                            onOpenChange={(open) => setMenu("open", open)}
                            triggerAs={IconButton}
                            triggerProps={{
                              icon: "chevron-down",
                              variant: "ghost",
                              disabled: opening(),
                              class:
                                "rounded-none h-full w-[20px] p-0 border-none shadow-none data-[expanded]:bg-surface-raised-base-active disabled:!cursor-default",
                              classList: {
                                "bg-surface-raised-base-active": opening(),
                              },
                              "aria-label": language.t("session.header.open.menu"),
                            }}
                          >
                            <div class="flex flex-col w-[320px]">
                              <div class="flex h-8 shrink-0 items-center gap-1 pl-2.5 pr-0.5 border-b border-border-weak-base">
                                <span class="flex-1 min-w-0 truncate text-12-medium text-text-strong">{name()}</span>
                                <Tooltip placement="bottom" value={language.t("session.header.open.copyPath")}>
                                  <IconButton
                                    icon="copy"
                                    variant="ghost"
                                    size="small"
                                    class="size-6"
                                    onClick={copyPath}
                                    aria-label={language.t("session.header.open.copyPath")}
                                  />
                                </Tooltip>
                              </div>
                              <ScrollView class="h-80 mt-1">
                                <FileTree
                                  path=""
                                  class="pt-1 pr-1"
                                  onFileClick={pickFile}
                                  onFileDelete={actions.remove}
                                  onFileRename={actions.rename}
                                  onMenuSelect={() => setMenu("open", false)}
                                />
                              </ScrollView>
                            </div>
                          </Popover>
                        </div>
                      </div>
                    </Tooltip>
                  </Show>
                </div>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}
