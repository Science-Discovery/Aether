import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import type { FileSearchHandle } from "@opencode-ai/ui/file"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { cloneSelectedLineRange, previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { createLineCommentController } from "@opencode-ai/ui/line-comment-annotations"
import { sampledChecksum } from "@opencode-ai/util/encode"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Markdown } from "@opencode-ai/ui/markdown"
import { CodeEditor } from "@/components/code-editor"
import { useSDK } from "@/context/sdk"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { getSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { canRestoreEditor, editorValue } from "@/pages/session/file-tab-state"
import { createSessionTabs } from "@/pages/session/helpers"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogPdfToMarkdown } from "@/components/dialog-pdf-to-markdown"
import { DialogTranslateMarkdown } from "@/components/dialog-translate-markdown"

function FileCommentMenu(props: {
  moreLabel: string
  editLabel: string
  deleteLabel: string
  onEdit: VoidFunction
  onDelete: VoidFunction
}) {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          size="small"
          class="size-6 rounded-md"
          aria-label={props.moreLabel}
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={props.onEdit}>
              <DropdownMenu.ItemLabel>{props.editLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onDelete}>
              <DropdownMenu.ItemLabel>{props.deleteLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}

export function FileTabContent(props: { tab: string }) {
  const file = useFile()
  const comments = useComments()
  const language = useLanguage()
  const prompt = usePrompt()
  const sync = useSync()
  const fileComponent = useFileComponent()
  const sdk = useSDK()
  const terminal = useTerminal()
  const dialog = useDialog()

  const [isEditing, setIsEditingSignal] = createSignal(false)
  const [editContent, setEditContentSignal] = createSignal("")
  const [isSaving, setIsSaving] = createSignal(false)
  const [wordWrap, setWordWrapSignal] = createSignal(false)

  // 持久化 word wrap 和 isEditing（在文件路径确定后才能读取，延迟初始化）
  let persistedStateLoaded = false
  const loadPersistedFileState = () => {
    if (persistedStateLoaded) return
    const p = path()
    if (!p || !file.ready()) return
    if (!state()?.loaded) return
    persistedStateLoaded = true
    const savedWrap = file.wordWrap(p)
    if (savedWrap != null) setWordWrapSignal(Boolean(savedWrap))
    const savedEditing = file.isEditing(p)
    if (
      canRestoreEditor({
        ready: file.ready(),
        loaded: !!state()?.loaded,
        text: isTextFile(),
        editing: !!savedEditing,
      })
    ) {
      setEditContentSignal(editorValue({ draft: file.draft(p), content: contents() }))
      setIsEditingSignal(true)
      return
    }
    if (savedEditing) {
      file.setIsEditing(p, false)
      file.clearDraft(p)
    }
  }

  const setIsEditing = (val: boolean) => {
    setIsEditingSignal(val)
    const p = path()
    if (p) file.setIsEditing(p, val)
  }

  const setWordWrap = (val: boolean) => {
    setWordWrapSignal(val)
    const p = path()
    if (p) file.setWordWrap(p, val)
  }

  const setEditContent = (value: string) => {
    setEditContentSignal(value)
    const p = path()
    if (!p) return
    file.setDraft(p, value)
  }

  const setEditorScroll = (pos: { x: number; y: number }) => {
    const p = path()
    if (!p) return
    file.setScrollLeft(p, pos.x)
    file.setScrollTop(p, pos.y)
  }

  const startEditing = () => {
    // 进入编辑模式前，从预览视口中心提取文本锚点（用于定位到编辑器对应位置）
    if (scroll) {
      const maxScroll = scroll.scrollHeight - scroll.clientHeight
      switchScrollRatio = maxScroll > 0 ? scroll.scrollTop / maxScroll : 0
      switchAnchorText = extractPreviewAnchor(scroll, contents())
    }
    setEditContent(contents())
    setIsEditing(true)
  }

  const cancelEditing = () => {
    const p = path()
    setIsEditing(false)
    setEditContentSignal("")
    if (p) file.clearDraft(p)
  }

  const saveEditing = async () => {
    const p = path()
    if (!p) return
    setIsSaving(true)
    try {
      await sdk.client.file.write({ path: p, content: editContent() })
      setIsEditing(false)
      setEditContentSignal("")
      file.clearDraft(p)
      void file.load(p, { force: true })
      if (params.id) void sync.session.diff(params.id, { force: true })
    } catch (e) {
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: String(e),
      })
    } finally {
      setIsSaving(false)
    }
  }

  const { params, sessionKey, tabs, view } = useSessionLayout()
  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  }).activeFileTab

  let scroll: HTMLDivElement | undefined
  let scrollFrame: number | undefined
  let restoreFrame: number | undefined
  let pending: { x: number; y: number } | undefined
  let codeScroll: HTMLElement[] = []
  let find: FileSearchHandle | null = null
  /** 模式切换时记录的文本锚点（优先）和滚动比例（fallback） */
  let switchAnchorText: string | null = null
  let switchScrollRatio: number | null = null

  const search = {
    register: (handle: FileSearchHandle | null) => {
      find = handle
    },
  }

  const path = createMemo(() => file.pathFromTab(props.tab))
  const editorScroll = createMemo(() => {
    const p = path()
    if (!p) return
    return {
      x: file.scrollLeft(p) ?? 0,
      y: file.scrollTop(p) ?? 0,
    }
  })

  const isMarkdown = createMemo(() => {
    const p = path()
    if (!p) return false
    const ext = p.split(".").pop()?.toLowerCase() ?? ""
    return ext === "md" || ext === "mdx" || ext === "markdown"
  })

  const isPython = createMemo(() => {
    const p = path()
    if (!p) return false
    const ext = p.split(".").pop()?.toLowerCase() ?? ""
    return ext === "py" || ext === "pyw"
  })

  const isPDF = createMemo(() => {
    const p = path()
    if (!p) return false
    return p.split(".").pop()?.toLowerCase() === "pdf"
  })

  const [isRunning, setIsRunning] = createSignal(false)

  const runPython = async () => {
    const p = path()
    if (!p) return
    setIsRunning(true)
    try {
      const fileName = p.split("/").pop() ?? p
      await terminal.run("bash", ["-c", `python3 ${JSON.stringify(p)}; exec bash --noediting`], fileName)
      view().terminal.open()
    } catch (e) {
      showToast({
        variant: "error",
        title: "运行失败",
        description: String(e),
      })
    } finally {
      setIsRunning(false)
    }
  }
  const state = createMemo(() => {
    const p = path()
    if (!p) return
    return file.get(p)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")
  
  const isTextFile = createMemo(() => {
    const content = state()?.content
    if (!content) return true
    if (content.type === "binary") return false
    const mimeType = content.mimeType
    if (mimeType && !mimeType.startsWith("text/") && mimeType !== "application/json") return false
    return true
  })
  const cacheKey = createMemo(() => sampledChecksum(contents()))
  const selectedLines = createMemo<SelectedLineRange | null>(() => {
    const p = path()
    if (!p) return null
    if (file.ready()) return (file.selectedLines(p) as SelectedLineRange | undefined) ?? null
    return (getSessionHandoff(sessionKey())?.files[p] as SelectedLineRange | undefined) ?? null
  })

  const selectionPreview = (source: string, selection: FileSelection) => {
    return previewSelectedLines(source, {
      start: selection.startLine,
      end: selection.endLine,
    })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview =
      input.preview ??
      (() => {
        if (input.file === path()) return selectionPreview(contents(), selection)
        const source = file.get(input.file)?.content?.content
        if (!source) return undefined
        return selectionPreview(source, selection)
      })()

    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    const preview =
      input.file === path() ? selectionPreview(contents(), selectionFromLines(input.selection)) : undefined
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(preview ? { preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const fileComments = createMemo(() => {
    const p = path()
    if (!p) return []
    return comments.list(p)
  })

  const commentedLines = createMemo(() => fileComments().map((comment) => comment.selection))

  const [note, setNote] = createStore({
    openedComment: null as string | null,
    commenting: null as SelectedLineRange | null,
    selected: null as SelectedLineRange | null,
  })

  const syncSelected = (range: SelectedLineRange | null) => {
    const p = path()
    if (!p) return
    file.setSelectedLines(p, range ? cloneSelectedLineRange(range) : null)
  }

  const activeSelection = () => note.selected ?? selectedLines()

  const commentsUi = createLineCommentController({
    comments: fileComments,
    label: language.t("ui.lineComment.submit"),
    draftKey: () => path() ?? props.tab,
    state: {
      opened: () => note.openedComment,
      setOpened: (id) => setNote("openedComment", id),
      selected: () => note.selected,
      setSelected: (range) => setNote("selected", range),
      commenting: () => note.commenting,
      setCommenting: (range) => setNote("commenting", range),
      syncSelected,
      hoverSelected: syncSelected,
    },
    getHoverSelectedRange: activeSelection,
    cancelDraftOnCommentToggle: true,
    clearSelectionOnSelectionEndNull: true,
    onSubmit: ({ comment, selection }) => {
      const p = path()
      if (!p) return
      addCommentToContext({ file: p, selection, comment, origin: "file" })
    },
    onUpdate: ({ id, comment, selection }) => {
      const p = path()
      if (!p) return
      updateCommentInContext({ id, file: p, selection, comment })
    },
    onDelete: (comment) => {
      const p = path()
      if (!p) return
      removeCommentFromContext({ id: comment.id, file: p })
    },
    editSubmitLabel: language.t("common.save"),
    renderCommentActions: (_, controls) => (
      <FileCommentMenu
        moreLabel={language.t("common.moreOptions")}
        editLabel={language.t("common.edit")}
        deleteLabel={language.t("common.delete")}
        onEdit={controls.edit}
        onDelete={controls.remove}
      />
    ),
  })

  createEffect(() => {
    if (typeof window === "undefined") return

    const onKeyDown = (event: KeyboardEvent) => {
      if (activeFileTab() !== props.tab) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== "f") return

      event.preventDefault()
      event.stopPropagation()
      find?.focus()
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, { capture: true }))
  })

  createEffect(
    on(
      path,
      () => {
        persistedStateLoaded = false
        setIsEditingSignal(false)
        setEditContentSignal("")
        setWordWrapSignal(false)
        commentsUi.note.reset()
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const focus = comments.focus()
    const p = path()
    if (!focus || !p) return
    if (focus.file !== p) return
    if (activeFileTab() !== props.tab) return

    const target = fileComments().find((comment) => comment.id === focus.id)
    if (!target) return

    commentsUi.note.openComment(target.id, target.selection, { cancelDraft: true })
    requestAnimationFrame(() => comments.clearFocus())
  })

  const getCodeScroll = () => {
    const el = scroll
    if (!el) return []

    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return []

    const root = host.shadowRoot
    if (!root) return []

    return Array.from(root.querySelectorAll("[data-code]")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.clientWidth > 0,
    )
  }

  const queueScrollUpdate = (next: { x: number; y: number }) => {
    pending = next
    if (scrollFrame !== undefined) return

    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined

      const out = pending
      pending = undefined
      if (!out) return

      view().setScroll(props.tab, out)
    })
  }

  const handleCodeScroll = (event: Event) => {
    const el = scroll
    if (!el) return

    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return

    queueScrollUpdate({
      x: target.scrollLeft,
      y: el.scrollTop,
    })
  }

  const syncCodeScroll = () => {
    const next = getCodeScroll()
    if (next.length === codeScroll.length && next.every((el, i) => el === codeScroll[i])) return

    for (const item of codeScroll) {
      item.removeEventListener("scroll", handleCodeScroll)
    }

    codeScroll = next

    for (const item of codeScroll) {
      item.addEventListener("scroll", handleCodeScroll)
    }
  }

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll(props.tab)
    if (!s) return

    syncCodeScroll()

    if (codeScroll.length > 0) {
      for (const item of codeScroll) {
        if (item.scrollLeft !== s.x) item.scrollLeft = s.x
      }
    }

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (codeScroll.length > 0) return
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const queueRestore = () => {
    if (restoreFrame !== undefined) return

    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined
      restoreScroll()
    })
  }

  /**
   * 从预览视口中心提取文本锚点。
   * 跳过 KaTeX 渲染的数学内容（与原始 LaTeX 文本不同），
   * 找最接近视口中心的普通文本节点，且该文本存在于原始内容中。
   */
  const extractPreviewAnchor = (scrollEl: HTMLDivElement, rawContent: string): string | null => {
    const scrollRect = scrollEl.getBoundingClientRect()
    const centerScreenY = scrollRect.top + scrollEl.clientHeight / 2

    const walker = document.createTreeWalker(scrollEl, NodeFilter.SHOW_TEXT)
    let bestAnchor: string | null = null
    let bestDist = Infinity
    let node: Node | null

    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim() ?? ""
      if (text.length < 15) continue

      // 跳过 KaTeX 渲染的数学公式内容（渲染后与原始 LaTeX 不同）
      let el: Element | null = node.parentElement
      let inMath = false
      while (el && el !== scrollEl) {
        if (el.classList?.contains("katex")) { inMath = true; break }
        el = el.parentElement
      }
      if (inMath) continue

      const range = document.createRange()
      range.selectNodeContents(node)
      const rects = range.getClientRects()
      if (!rects.length) continue

      const r = rects[0]
      const dist = Math.abs((r.top + r.bottom) / 2 - centerScreenY)
      const candidate = text.slice(0, 35)

      if (dist < bestDist && rawContent.includes(candidate)) {
        bestDist = dist
        bestAnchor = candidate
      }
    }

    return bestAnchor
  }

  /**
   * 在预览 DOM 中搜索锚点文本并滚动到对应位置（居中显示）。
   * 若未找到则 fallback 到比例定位。
   * 使用 setTimeout 等待 markdown 渲染完成。
   */
  const scrollPreviewToAnchor = (scrollEl: HTMLDivElement, anchor: string | null, ratio: number) => {
    const doScroll = () => {
      if (anchor) {
        const walker = document.createTreeWalker(scrollEl, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          if (!node.textContent?.includes(anchor.slice(0, 20))) continue
          const parent = node.parentElement
          if (!parent) continue
          const range = document.createRange()
          range.selectNodeContents(node)
          const rects = range.getClientRects()
          if (!rects.length) continue
          const r = rects[0]
          const scrollRect = scrollEl.getBoundingClientRect()
          const nodeScrollY = scrollEl.scrollTop + r.top - scrollRect.top
          scrollEl.scrollTop = Math.max(0, nodeScrollY - scrollEl.clientHeight / 2 + r.height / 2)
          return
        }
      }
      // fallback：比例定位
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight
      if (maxScroll > 0 && ratio > 0) scrollEl.scrollTop = ratio * maxScroll
    }
    // 等待 markdown 渲染（通常同步，但给一帧余量）
    requestAnimationFrame(() => {
      doScroll()
    })
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (codeScroll.length === 0) syncCodeScroll()

    queueScrollUpdate({
      x: codeScroll[0]?.scrollLeft ?? event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    })
  }

  const cancelCommenting = () => {
    const p = path()
    if (p) file.setSelectedLines(p, null)
    setNote("commenting", null)
  }

  let prev = {
    loaded: false,
    ready: false,
    active: false,
  }

  createEffect(() => {
    const loaded = !!state()?.loaded
    const ready = file.ready()
    const active = activeFileTab() === props.tab
    const restore = (loaded && !prev.loaded) || (ready && !prev.ready) || (active && loaded && !prev.active)
    prev = { loaded, ready, active }
    if (!restore) return
    // 文件加载完成时，恢复持久化的 wordWrap / isEditing 状态
    loadPersistedFileState()
    queueRestore()
  })

  onCleanup(() => {
    for (const item of codeScroll) {
      item.removeEventListener("scroll", handleCodeScroll)
    }

    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
  })

  /** 将 markdown 中的相对图片路径重写为服务器 /file/raw URL */
  const rewriteImagePaths = (md: string): string => {
    const p = path()
    if (!p) return md
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""
    const baseUrl = sdk.url
    const directory = encodeURIComponent(sdk.directory)
    return md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
      // 跳过已经是 URL 的路径
      if (/^https?:\/\/|^data:/.test(src)) return match
      // 将相对路径解析为工作目录下的绝对路径
      const absImagePath = dir ? `${dir}/${src}` : src
      const encodedPath = encodeURIComponent(absImagePath)
      return `![${alt}](${baseUrl}/file/raw?path=${encodedPath}&directory=${directory})`
    })
  }

  const renderFile = (source: string) => {
    if (isMarkdown()) {
      const processed = rewriteImagePaths(source)
      return (
        <div class="relative px-6 pb-40 select-text" data-file-content>
          <Markdown text={processed} cacheKey={cacheKey()} />
        </div>
      )
    }
    if (wordWrap()) {
      return (
        <div class="relative px-6 pb-40 select-text" data-file-content>
          <pre class="text-sm font-mono leading-relaxed whitespace-pre-wrap break-words text-text-base">{source}</pre>
        </div>
      )
    }
    return (
      <div class={`relative overflow-hidden ${isPDF() ? "" : "pb-40"}`} data-file-content>
        <Dynamic
          component={fileComponent}
          mode="text"
          file={{
            name: path() ?? "",
            contents: source,
            cacheKey: cacheKey(),
          }}
          enableLineSelection
          enableHoverUtility
          selectedLines={activeSelection()}
          commentedLines={commentedLines()}
          onRendered={() => {
            queueRestore()
          }}
          annotations={commentsUi.annotations()}
          renderAnnotation={commentsUi.renderAnnotation}
          renderHoverUtility={commentsUi.renderHoverUtility}
          onLineSelected={(range: SelectedLineRange | null) => {
            commentsUi.onLineSelected(range)
          }}
          onLineNumberSelectionEnd={commentsUi.onLineNumberSelectionEnd}
          onLineSelectionEnd={(range: SelectedLineRange | null) => {
            commentsUi.onLineSelectionEnd(range)
          }}
          search={search}
          overflow="scroll"
          class="select-text"
          media={{
            mode: "auto",
            path: path(),
            current: state()?.content,
            onLoad: queueRestore,
            actions: isPDF() ? () => (
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
                onClick={() => {
                  const p = path()
                  if (!p) return
                  dialog.showModeless(() => <DialogPdfToMarkdown pdfPath={p} />)
                }}
              >
                转换为 Markdown
              </button>
            ) : undefined,
            onError: (args: { kind: "image" | "audio" | "svg" }) => {
              if (args.kind !== "svg") return
              showToast({
                variant: "error",
                title: language.t("toast.file.loadFailed.title"),
              })
            },
          }}
        />
      </div>
    )
  }

  return (
    <Tabs.Content value={props.tab} class="mt-3 relative flex h-full min-h-0 flex-col overflow-hidden contain-strict">
      <Show when={state()?.loaded}>
        <div class="flex justify-end px-3 pb-1 shrink-0 gap-1.5">
          <Show when={!isEditing() && isPython()}>
            <IconButton
              icon="console"
              variant="ghost"
              size="small"
              aria-label="运行 Python 文件"
              onClick={runPython}
              disabled={isRunning()}
            />
          </Show>
          <Show when={!isEditing() && isMarkdown()}>
            <button
              type="button"
              class="flex items-center justify-center rounded-md px-2 h-5 text-xs text-text-weak hover:bg-surface-raised-base-hover transition-colors cursor-pointer leading-none"
              onClick={() => {
                const p = path()
                if (!p) return
                dialog.showModeless(() => <DialogTranslateMarkdown mdPath={p} />)
              }}
            >
              翻译为中文
            </button>
          </Show>
          <Show when={isTextFile()}>
            <Tooltip placement="top" gutter={4} value={wordWrap() ? "关闭自动换行" : "开启自动换行"}>
              <IconButton
                icon="align-right"
                variant={wordWrap() ? "secondary" : "ghost"}
                size="small"
                aria-label={wordWrap() ? "关闭自动换行" : "开启自动换行"}
                onClick={() => setWordWrap(!wordWrap())}
              />
            </Tooltip>
          </Show>
          <Show
            when={isEditing() && isTextFile()}
            fallback={
              <Show when={isTextFile()}>
                <IconButton
                  icon="pencil-line"
                  variant="ghost"
                  size="small"
                  aria-label={language.t("common.edit")}
                  onClick={startEditing}
                />
              </Show>
            }
          >
            <IconButton
              icon="close"
              variant="ghost"
              size="small"
              aria-label={language.t("common.cancel")}
              onClick={cancelEditing}
              disabled={isSaving()}
            />
            <IconButton
              icon="check"
              variant="ghost"
              size="small"
              aria-label={language.t("common.save")}
              onClick={saveEditing}
              disabled={isSaving()}
            />
          </Show>
        </div>
      </Show>
      <Show
        when={isEditing()}
        fallback={
          <ScrollView
            class="h-full min-h-0 flex-1"
            viewportRef={(el: HTMLDivElement) => {
              scroll = el
              if (switchAnchorText !== null || switchScrollRatio !== null) {
                // 从编辑模式切回：用文本锚点定位（fallback 到比例）
                const anchor = switchAnchorText
                const ratio = switchScrollRatio ?? 0
                switchAnchorText = null
                switchScrollRatio = null
                scrollPreviewToAnchor(el, anchor, ratio)
              } else {
                restoreScroll()
              }
            }}
            onScroll={handleScroll as any}
          >
            <Switch>
              <Match when={state()?.loaded}>{renderFile(contents())}</Match>
              <Match when={state()?.loading}>
                <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
              </Match>
              <Match when={state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Match>
            </Switch>
          </ScrollView>
        }
      >
        <CodeEditor
          content={editContent()}
          filename={path() ?? ""}
          onChange={setEditContent}
          disabled={isSaving()}
          wordWrap={wordWrap()}
          initialScroll={switchAnchorText === null && switchScrollRatio === null ? editorScroll() : undefined}
          initialAnchorText={switchAnchorText ?? undefined}
          initialScrollRatio={switchScrollRatio ?? 0}
          onScroll={setEditorScroll}
          onUnmount={(centerText, ratio) => {
            switchAnchorText = centerText || null
            switchScrollRatio = ratio
          }}
        />
      </Show>
    </Tabs.Content>
  )
}
