import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { PdfConvertProgressBar } from "@/components/pdf-convert-progress"
import { Keybind } from "@opencode-ai/ui/keybind"
import { Popover } from "@opencode-ai/ui/popover"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { getFilename } from "@opencode-ai/util/path"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { createMemo, Show } from "solid-js"
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
import { decode64 } from "@/utils/base64"
import { StatusPopover } from "../status-popover"

type OS = "macos" | "windows" | "linux" | "unknown"

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

  const fileManager = createMemo(() => {
    if (os() === "macos") return { label: "session.header.open.finder", icon: "finder" as const }
    if (os() === "windows") return { label: "session.header.open.fileExplorer", icon: "file-explorer" as const }
    return { label: "session.header.open.fileManager", icon: "finder" as const }
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

  const [menu, setMenu] = createStore({ open: false })
  const [pending, setPending] = createStore({ open: false })

  const canOpen = createMemo(() => {
    if (!server.isLocal()) return false
    if (platform.platform === "desktop") return !!platform.openPath
    return platform.platform === "web"
  })
  const openDir = () => {
    if (pending.open || !canOpen()) return
    const directory = projectDirectory()
    if (!directory) return

    setPending("open", true)
    const task =
      platform.platform === "desktop" && platform.openPath
        ? platform.openPath(directory)
        : sdk.client.file.open({ path: directory }).then(() => undefined)
    task
      .catch((err: unknown) => showRequestError(language, err))
      .finally(() => {
        setPending("open", false)
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

                <div class="flex items-center shrink-0">
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
                  <Popover
                    gutter={4}
                    placement="bottom-start"
                    open={menu.open}
                    onOpenChange={(open) => setMenu("open", open)}
                    triggerAs={IconButton}
                    triggerProps={{
                      icon: "chevron-down",
                      variant: "ghost",
                      class: "titlebar-icon w-[20px] h-6 p-0 box-border",
                      classList: { hidden: !projectDirectory() },
                      "aria-label": language.t("session.header.open.menu"),
                    }}
                  >
                    <div class="flex flex-col w-[320px]">
                      <div class="flex h-8 shrink-0 items-center gap-1 pl-2.5 pr-0.5 border-b border-border-weak-base">
                        <Tooltip placement="bottom" value={language.t(fileManager().label)}>
                          <button
                            type="button"
                            class="flex-1 min-w-0 h-full truncate text-12-medium text-text-strong text-left rounded-sm hover:bg-surface-raised-base-hover"
                            onClick={openDir}
                            disabled={!canOpen() || pending.open}
                            aria-label={language.t(fileManager().label)}
                          >
                            {name()}
                          </button>
                        </Tooltip>
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
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}
