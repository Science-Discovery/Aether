import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { TooltipKeybind, Tooltip } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { showToast } from "@opencode-ai/ui/toast"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { FileDiff } from "@opencode-ai/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { DialogSelectFile } from "@/components/dialog-select-file"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { createOpenSessionFileTab, createSessionTabs, getTabReorderIndex, type Sizing } from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import type { FileNode } from "@opencode-ai/sdk/v2"

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => FileDiff[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  size: Sizing
}) {
  const layout = useLayout()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { params, sessionKey, tabs, view } = useSessionLayout()

  function handleFileCreate(dir: string, type: "file" | "directory") {
    const title = type === "file" ? "新建文件" : "新建文件夹"
    const placeholder = type === "file" ? "文件名（如 notes.md）" : "文件夹名"
    dialog.show(() => {
      const [name, setName] = createSignal("")
      const doCreate = async () => {
        const trimmed = name().trim()
        if (!trimmed) return
        dialog.close()
        const newPath = dir ? `${dir}/${trimmed}` : trimmed
        try {
          await sdk.client.file.create({ path: newPath, type })
          file.tree.refresh(dir)
          if (params.id) void sync.session.diff(params.id, { force: true })
          if (!file.tree.state(dir)?.expanded) file.tree.expand(dir)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          showToast({ variant: "error", icon: "circle-x", title: "创建失败", description: message })
        }
      }
      return (
        <Dialog
          title={title}
          action={
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => dialog.close()} style={{ padding: "4px 12px", cursor: "pointer" }}>
                取消
              </button>
              <button onClick={doCreate} style={{ padding: "4px 12px", cursor: "pointer", "font-weight": "bold" }}>
                确认
              </button>
            </div>
          }
        >
          <div style={{ padding: "12px 0" }}>
            <input
              autofocus
              type="text"
              value={name()}
              placeholder={placeholder}
              onInput={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") doCreate()
                if (e.key === "Escape") dialog.close()
              }}
              style={{ width: "100%", padding: "6px 8px", "box-sizing": "border-box" }}
            />
          </div>
        </Dialog>
      )
    })
  }

  function handleFileDelete(node: FileNode) {
    const label = node.type === "directory" ? "文件夹" : "文件"
    dialog.show(() => {
      const doDelete = async () => {
        dialog.close()
        const parentDir = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : ""
        try {
          await sdk.client.file.delete({ path: node.path })
          file.tree.refresh(parentDir)
          // Close tabs for the deleted file/directory
          const tabsToClose = tabs().all().filter((tab) => {
            const tabPath = file.pathFromTab(tab)
            if (!tabPath) return false
            if (node.type === "directory") {
              return tabPath === node.path || tabPath.startsWith(node.path + "/")
            }
            return tabPath === node.path
          })
          for (const tab of tabsToClose) tabs().close(tab)
          // Also clear multi-select if the deleted path was selected
          setSelectedPaths((prev) => {
            if (!prev.has(node.path)) return prev
            const next = new Set(prev)
            next.delete(node.path)
            return next
          })
          if (params.id) void sync.session.diff(params.id, { force: true })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          showToast({ variant: "error", icon: "circle-x", title: "删除失败", description: message })
        }
      }
      return (
        <Dialog
          title={`删除${label}`}
          description={`确认删除${label} "${node.name}"？此操作不可撤销。`}
          action={
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => dialog.close()} style={{ padding: "4px 12px", cursor: "pointer" }}>
                取消
              </button>
              <button
                autofocus
                onClick={doDelete}
                style={{ padding: "4px 12px", cursor: "pointer", "font-weight": "bold", color: "red" }}
              >
                删除
              </button>
            </div>
          }
        />
      )
    })
  }

  function handleFileRename(node: FileNode) {
    dialog.show(() => {
      const [name, setName] = createSignal(node.name)
      const doRename = async () => {
        const newName = name().trim()
        if (!newName || newName === node.name) {
          dialog.close()
          return
        }
        dialog.close()
        const parentDir = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : ""
        try {
          await sdk.client.file.rename({ path: node.path, name: newName })
          file.tree.refresh(parentDir)
          if (params.id) void sync.session.diff(params.id, { force: true })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          showToast({ variant: "error", icon: "circle-x", title: "重命名失败", description: message })
        }
      }
      return (
        <Dialog
          title="重命名"
          action={
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => dialog.close()} style={{ padding: "4px 12px", cursor: "pointer" }}>
                取消
              </button>
              <button
                autofocus
                onClick={doRename}
                style={{ padding: "4px 12px", cursor: "pointer", "font-weight": "bold" }}
              >
                确认
              </button>
            </div>
          }
        >
          <input
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doRename()
              if (e.key === "Escape") dialog.close()
            }}
            style={{
              width: "100%",
              padding: "6px 8px",
              background: "var(--surface-raised-base)",
              border: "1px solid var(--border-base)",
              "border-radius": "4px",
              color: "var(--text-strong)",
              "font-size": "14px",
              outline: "none",
            }}
            ref={(el) => setTimeout(() => { el.focus(); el.select() }, 0)}
          />
        </Dialog>
      )
    })
  }

  function handleRefresh() {
    file.tree.refresh("")
  }

  const [isSummarizing, setIsSummarizing] = createSignal(false)

  async function handleSummarize() {
    if (isSummarizing()) return
    setIsSummarizing(true)
    try {
      const result = await sdk.client.file.summarize()
      const data = result.data as { count: number } | undefined
      const count = data?.count ?? 0
      showToast({
        variant: "success",
        title: `已生成 ${count} 个目录摘要`,
      })
      file.tree.refresh("")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", icon: "circle-x", title: "生成摘要失败", description: message })
    } finally {
      setIsSummarizing(false)
    }
  }

  const isDesktop = createMediaQuery("(min-width: 768px)")

  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const fileOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const open = createMemo(() => reviewOpen() || fileOpen())
  const reviewTab = createMemo(() => isDesktop())
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (reviewOpen()) return `calc(100% - ${layout.session.width()}px)`
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const diffFiles = createMemo(() => props.diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of props.diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  // Multi-select state for file tree (Cmd/Ctrl click) — 使用共享状态
  const { selectedPaths, setSelectedPaths } = file

  const handleFileClickWithMultiSelect = (node: import("@opencode-ai/sdk/v2").FileNode, event?: MouseEvent) => {
    if (event && (event.metaKey || event.ctrlKey)) {
      // Cmd/Ctrl click: toggle selection
      setSelectedPaths((prev) => {
        const next = new Set(prev)
        if (next.has(node.path)) {
          next.delete(node.path)
        } else {
          next.add(node.path)
        }
        return next
      })
    } else {
      // Normal click: open file and mark as selected
      setSelectedPaths(new Set<string>([node.path]))
      openTab(file.tab(node.path))
    }
  }

  const handleMultiDelete = (paths: string[]) => {
    dialog.show(() => {
      const doDelete = async () => {
        dialog.close()
        let success = 0
        let failed = 0
        const dirsToRefresh = new Set<string>()
        for (const p of paths) {
          const parentDir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""
          try {
            await sdk.client.file.delete({ path: p })
            dirsToRefresh.add(parentDir)
            // Close any open tab for this path
            const tabToClose = tabs().all().find((tab) => file.pathFromTab(tab) === p)
            if (tabToClose) tabs().close(tabToClose)
            success++
          } catch {
            failed++
          }
        }
        for (const dir of dirsToRefresh) file.tree.refresh(dir)
        setSelectedPaths(new Set<string>())
        if (params.id) void sync.session.diff(params.id, { force: true })
        if (failed > 0) {
          showToast({ variant: "error", title: `删除完成：${success} 成功，${failed} 失败` })
        } else {
          showToast({ variant: "success", title: `已删除 ${success} 项` })
        }
      }
      return (
        <Dialog
          title="批量删除"
          description={`确认删除选中的 ${paths.length} 个文件/文件夹？此操作不可撤销。`}
          action={
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => dialog.close()} style={{ padding: "4px 12px", cursor: "pointer" }}>
                取消
              </button>
              <button
                autofocus
                onClick={doDelete}
                style={{ padding: "4px 12px", cursor: "pointer", "font-weight": "bold", color: "red" }}
              >
                删除
              </button>
            </div>
          }
        />
      )
    })
  }

  const handleMultiDownload = async (paths: string[]) => {
    let count = 0
    for (const p of paths) {
      try {
        const res = await sdk.client.file.read({ path: p })
        const content = res.data?.content ?? ""
        const blob = new Blob([content], { type: "text/plain" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = p.split("/").pop() ?? p
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        count++
      } catch {
        // skip files that can't be read (directories, binary, etc.)
      }
    }
    showToast({ variant: "success", title: `已下载 ${count} 个文件` })
  }

  // Clipboard state for copy/cut
  const [clipboard, setClipboard] = createSignal<{ paths: string[]; mode: "copy" | "cut" } | null>(null)

  const handleMultiCopy = (paths: string[]) => {
    setClipboard({ paths, mode: "copy" })
    showToast({ variant: "success", title: `已复制 ${paths.length} 项` })
  }

  const handleMultiCut = (paths: string[]) => {
    setClipboard({ paths, mode: "cut" })
    showToast({ variant: "success", title: `已剪切 ${paths.length} 项` })
  }

  const handleFileDrop = async (paths: string[], targetDir: string) => {
    let success = 0
    let failed = 0
    const dirsToRefresh = new Set<string>()
    dirsToRefresh.add(targetDir)
    for (const p of paths) {
      const fileName = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p
      const parentDir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""
      const newPath = targetDir ? `${targetDir}/${fileName}` : fileName
      if (newPath === p) continue
      try {
        await sdk.client.file.rename({ path: p, name: newPath })
        dirsToRefresh.add(parentDir)
        success++
      } catch {
        failed++
      }
    }
    for (const dir of dirsToRefresh) file.tree.refresh(dir)
    setSelectedPaths(new Set<string>())
    if (params.id) void sync.session.diff(params.id, { force: true })
    if (failed > 0) {
      showToast({ variant: "error", title: `移动完成：${success} 成功，${failed} 失败` })
    } else if (success > 0) {
      showToast({ variant: "success", title: `已移动 ${success} 项` })
    }
  }

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop()}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.reviewSnap,
        }}
        style={{ width: panelWidth() }}
      >
        <div class="size-full flex border-l border-border-weaker-base">
          <div
            aria-hidden={!reviewOpen()}
            inert={!reviewOpen()}
            class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
            classList={{
              "pointer-events-none": !reviewOpen(),
            }}
          >
            <div class="size-full min-w-0 h-full bg-background-base">
              <DragDropProvider
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                collisionDetector={closestCenter}
              >
                <DragDropSensors />
                <ConstrainDragYAxis />
                <Tabs value={activeTab()} onChange={openTab}>
                  <div class="sticky top-0 shrink-0 flex">
                    <Tabs.List
                      ref={(el: HTMLDivElement) => {
                        const stop = createFileTabListSync({ el, contextOpen })
                        onCleanup(stop)
                      }}
                    >
                      <Show when={reviewTab() && props.canReview()}>
                        <Tabs.Trigger value="review">
                          <div class="flex items-center gap-1.5">
                            <div>{language.t("session.tab.review")}</div>
                            <Show when={props.hasReview()}>
                              <div>{props.reviewCount()}</div>
                            </Show>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={contextOpen()}>
                        <Tabs.Trigger
                          value="context"
                          closeButton={
                            <TooltipKeybind
                              title={language.t("common.closeTab")}
                              keybind={command.keybind("tab.close")}
                              placement="bottom"
                              gutter={10}
                            >
                              <IconButton
                                icon="close-small"
                                variant="ghost"
                                class="h-5 w-5"
                                onClick={() => tabs().close("context")}
                                aria-label={language.t("common.closeTab")}
                              />
                            </TooltipKeybind>
                          }
                          hideCloseButton
                          onMiddleClick={() => tabs().close("context")}
                        >
                          <div class="flex items-center gap-2">
                            <SessionContextUsage variant="indicator" />
                            <div>{language.t("session.tab.context")}</div>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <SortableProvider ids={openedTabs()}>
                        <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                      </SortableProvider>
                      <div class="bg-background-stronger h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3">
                        <TooltipKeybind
                          title={language.t("command.file.open")}
                          keybind={command.keybind("file.open")}
                          class="flex items-center"
                        >
                          <IconButton
                            icon="plus-small"
                            variant="ghost"
                            iconSize="large"
                            class="!rounded-md"
                            onClick={() =>
                              dialog.show(() => <DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
                            }
                            aria-label={language.t("command.file.open")}
                          />
                        </TooltipKeybind>
                      </div>
                    </Tabs.List>
                  </div>

                  <Show when={reviewTab() && props.canReview()}>
                    <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "review"}>{props.reviewPanel()}</Show>
                    </Tabs.Content>
                  </Show>

                  <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "empty"}>
                      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                        <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                          <Mark class="w-14 opacity-10" />
                          <div class="text-14-regular text-text-weak max-w-56">
                            {language.t("session.files.selectToOpen")}
                          </div>
                        </div>
                      </div>
                    </Show>
                  </Tabs.Content>

                  <Show when={contextOpen()}>
                    <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "context"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <SessionContextTab />
                        </div>
                      </Show>
                    </Tabs.Content>
                  </Show>

                  <Show when={activeFileTab()} keyed>
                    {(tab) => <FileTabContent tab={tab} />}
                  </Show>
                </Tabs>
                <DragOverlay>
                  <Show when={store.activeDraggable} keyed>
                    {(tab) => {
                      const path = file.pathFromTab(tab)
                      return (
                        <div data-component="tabs-drag-preview">
                          <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                        </div>
                      )
                    }}
                  </Show>
                </DragOverlay>
              </DragDropProvider>
            </div>
          </div>

          <div
            id="file-tree-panel"
            aria-hidden={!fileOpen()}
            inert={!fileOpen()}
            class="relative min-w-0 h-full shrink-0 overflow-hidden"
            classList={{
              "pointer-events-none": !fileOpen(),
              "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                !props.size.active(),
            }}
            style={{ width: treeWidth() }}
          >
            <div
              class="h-full flex flex-col overflow-hidden group/filetree"
              classList={{ "border-l border-border-weaker-base": reviewOpen() }}
            >
              <Tabs
                variant="pill"
                value={fileTreeTab()}
                onChange={setFileTreeTabValue}
                class="h-full"
                data-scope="filetree"
              >
                <Tabs.List>
                  <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                    {props.reviewCount()}{" "}
                    {language.t(
                      props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                    )}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                    {language.t("session.files.all")}
                  </Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                  <Switch>
                    <Match when={props.hasReview() || !props.diffsReady()}>
                      <Show
                        when={props.diffsReady()}
                        fallback={
                          <div class="px-2 py-2 text-12-regular text-text-weak">
                            {language.t("common.loading")}
                            {language.t("common.loading.ellipsis")}
                          </div>
                        }
                      >
                        <FileTree
                          path=""
                          class="pt-3"
                          allowed={diffFiles()}
                          kinds={kinds()}
                          draggable={false}
                          active={props.activeDiff}
                          onFileClick={(node) => props.focusReviewDiff(node.path)}
                        />
                      </Show>
                    </Match>
                    <Match when={true}>{empty(props.empty())}</Match>
                  </Switch>
                </Tabs.Content>
                <Tabs.Content value="all" class="bg-background-stronger px-3 py-0 flex flex-col">
                  <div class="flex items-center gap-1 py-1.5 border-b border-border-weak-base">
                    <Tooltip value="在项目根目录新建文件">
                      <button
                        type="button"
                        class="flex items-center gap-1 px-2 py-1 rounded text-12-regular text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
                        onClick={() => handleFileCreate("", "file")}
                      >
                        <Icon name="plus-small" size="small" />
                        新建文件
                      </button>
                    </Tooltip>
                    <Tooltip value="在项目根目录新建文件夹">
                      <button
                        type="button"
                        class="flex items-center gap-1 px-2 py-1 rounded text-12-regular text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
                        onClick={() => handleFileCreate("", "directory")}
                      >
                        <Icon name="folder-add-left" size="small" />
                        新建文件夹
                      </button>
                    </Tooltip>
                    <Tooltip value="为项目所有文件夹生成 .summary 摘要文件">
                      <button
                        type="button"
                        class="flex items-center gap-1 px-2 py-1 rounded text-12-regular text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={handleSummarize}
                        disabled={isSummarizing()}
                      >
                        <Icon name="bullet-list" size="small" />
                        {isSummarizing() ? "生成中..." : "生成摘要"}
                      </button>
                    </Tooltip>
                    <Tooltip value="刷新项目文件列表">
                      <button
                        type="button"
                        class="ml-auto flex items-center gap-1 px-2 py-1 rounded text-12-regular text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
                        onClick={handleRefresh}
                      >
                        <Icon name="arrow-down-to-line" size="small" />
                        刷新
                      </button>
                    </Tooltip>
                  </div>
                  <Switch>
                    <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                    <Match when={true}>
                      <FileTree
                        path=""
                        class="pt-3"
                        modified={diffFiles()}
                        kinds={kinds()}
                        selectedPaths={selectedPaths()}
                        onFileClick={handleFileClickWithMultiSelect}
                        onFileCreate={handleFileCreate}
                        onFileDelete={handleFileDelete}
                        onFileRename={handleFileRename}
                        onMultiDelete={handleMultiDelete}
                        onMultiDownload={handleMultiDownload}
                        onMultiCopy={handleMultiCopy}
                        onMultiCut={handleMultiCut}
                        onFileDrop={handleFileDrop}
                      />
                    </Match>
                  </Switch>
                </Tabs.Content>
              </Tabs>
            </div>
            <Show when={fileOpen()}>
              <div onPointerDown={() => props.size.start()}>
                <ResizeHandle
                  direction="horizontal"
                  edge="start"
                  size={layout.fileTree.width()}
                  min={200}
                  max={480}
                  onResize={(width) => {
                    props.size.touch()
                    layout.fileTree.resize(width)
                  }}
                />
              </div>
            </Show>
          </div>
        </div>
      </aside>
    </Show>
  )
}
