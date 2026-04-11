import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import type { FileSearchHandle } from "@opencode-ai/ui/file"
import { Button } from "@opencode-ai/ui/button"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { cloneSelectedLineRange, previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { createLineCommentController } from "@opencode-ai/ui/line-comment-annotations"
import { checksum, sampledChecksum } from "@opencode-ai/util/encode"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Markdown } from "@opencode-ai/ui/markdown"
import { CodeEditor } from "@/components/code-editor"
import { PdfViewerShell } from "@/components/pdf-viewer-shell-official"
import { registerOpenFileCallback, registerRefreshDirCallback, restoreActiveTasks } from "@/components/pdf-convert-progress"
import { useSDK } from "@/context/sdk"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { getSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { draftState, editorValue } from "@/pages/session/file-tab-state"
import { createSessionTabs } from "@/pages/session/helpers"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogDraftConflict } from "@/components/dialog-draft-conflict"
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
  const server = useServer()
  const terminal = useTerminal()
  const dialog = useDialog()
  const [isEditing, setIsEditingSignal] = createSignal(false)
  const [editContent, setEditContentSignal] = createSignal("")
  const [isSaving, setIsSaving] = createSignal(false)
  const [isStale, setIsStale] = createSignal(false)
  const [needsConfirm, setNeedsConfirm] = createSignal(false)
  const [wordWrap, setWordWrapSignal] = createSignal(false)

  // Build fetchApi for progress recovery and modal actions.
  const fetchApi = (urlPath: string, options: RequestInit = {}): Promise<Response> => {
    const baseUrl = sdk.url
    const s = server.current?.http
    const authHeader: Record<string, string> = s?.password
      ? { Authorization: `Basic ${btoa(`${s.username ?? "opencode"}:${s.password}`)}` }
      : {}
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...authHeader,
      ...(options.headers as Record<string, string> ?? {}),
    }
    const separator = urlPath.includes("?") ? "&" : "?"
    return fetch(`${baseUrl}${urlPath}${separator}directory=${encodeURIComponent(sdk.directory)}`, {
      ...options,
      headers,
    })
  }

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
    const saved = draftState({
      ready: file.ready(),
      loaded: !!state()?.loaded,
      text: isTextFile(),
      editing: !!file.isEditing(p),
      draft: file.draft(p),
      draftBase: file.draftBase(p),
      content: contents(),
    })
    if (saved === "fresh") {
      setEditContentSignal(editorValue({ draft: file.draft(p), content: contents() }))
      setIsEditingSignal(true)
      setIsStale(false)
      setNeedsConfirm(false)
      return
    }
    if (saved === "stale") {
      setIsEditingSignal(false)
      setEditContentSignal("")
      setIsStale(true)
      setNeedsConfirm(file.draftBase(p) === undefined)
      return
    }
    if (file.isEditing(p)) {
      file.clearDraftMeta(p)
    }
    setIsStale(false)
    setNeedsConfirm(false)
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
    const p = path()
    if (!p) return
    // 进入编辑模式前，从预览视口中心提取文本锚点（用于定位到编辑器对应位置）
    if (scroll) {
      const maxScroll = scroll.scrollHeight - scroll.clientHeight
      switchScrollRatio = maxScroll > 0 ? scroll.scrollTop / maxScroll : 0
      switchAnchorText = extractPreviewAnchor(scroll, contents())
    }
    const next = contents()
    setEditContent(next)
    file.setDraftBase(p, checksum(next) ?? "")
    setIsStale(false)
    setNeedsConfirm(false)
    setIsEditing(true)
  }

  const discardDraft = () => {
    const p = path()
    if (!p) return
    setIsEditing(false)
    setEditContentSignal("")
    setIsStale(false)
    setNeedsConfirm(false)
    file.clearDraftMeta(p)
    void file.load(p, { force: true })
  }

  const restoreDraft = () => {
    const p = path()
    if (!p) return
    setEditContentSignal(editorValue({ draft: file.draft(p), content: contents() }))
    setIsStale(false)
    setNeedsConfirm(file.draftBase(p) === undefined)
    setIsEditing(true)
  }

  const cancelEditing = () => {
    discardDraft()
  }

  const done = (p: string) => {
    setIsEditing(false)
    setEditContentSignal("")
    setIsStale(false)
    setNeedsConfirm(false)
    file.clearDraftMeta(p)
    void file.load(p, { force: true })
    if (params.id) void sync.session.diff(params.id, { force: true })
  }

  const isConflict = (
    err: unknown,
  ): err is {
    error: "conflict"
    currentChecksum: string
    currentContent: string
  } => {
    if (!err || typeof err !== "object") return false
    if ((err as { error?: string }).error !== "conflict") return false
    if (typeof (err as { currentChecksum?: unknown }).currentChecksum !== "string") return false
    return typeof (err as { currentContent?: unknown }).currentContent === "string"
  }

  const writeEditing = (p: string, force = false) =>
    sdk.client.file.write(
      {
        path: p,
        content: editContent(),
        ...(force || file.draftBase(p) === undefined ? {} : { expectedChecksum: file.draftBase(p) }),
      },
      { throwOnError: true },
    )

  const acceptConflict = async (p: string) => {
    setIsSaving(true)
    try {
      await writeEditing(p, true)
      done(p)
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

  const saveEditing = async () => {
    const p = path()
    if (!p) return
    if (needsConfirm()) {
      dialog.show(() => (
        <DialogDraftConflict
          onAccept={() => void acceptConflict(p)}
          onDiscard={discardDraft}
        />
      ))
      return
    }
    setIsSaving(true)
    try {
      await writeEditing(p)
      done(p)
    } catch (e) {
      if (isConflict(e)) {
        if (editContent() === e.currentContent) {
          done(p)
          return
        }
        dialog.show(() => (
          <DialogDraftConflict
            onAccept={() => void acceptConflict(p)}
            onDiscard={discardDraft}
          />
        ))
        return
      }
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

  // Register the callback that opens files after PDF conversion completes.
  registerOpenFileCallback(async (filePath: string) => {
    const parentDir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ""
    await file.tree.refresh(parentDir)
    const tab = file.tab(filePath)
    tabs().open(tab)
    tabs().setActive(tab)
    await file.load(filePath, { force: true })
  })

  // Register the directory refresh callback after each conversion finishes.
  registerRefreshDirCallback((dirPath: string) => {
    void file.tree.refresh(dirPath)
  })

  // Restore conversion progress from any active backend tasks during page load.
  void restoreActiveTasks(fetchApi, sdk.url, sdk.directory)
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

  const pdfPreviewUrl = createMemo(() => {
    const p = path()
    if (!p) return ""
    return `${sdk.url}/file/raw?path=${encodeURIComponent(p)}&directory=${encodeURIComponent(sdk.directory)}`
  })
  const pdfPreviewPage = createMemo(() => {
    const p = path()
    if (!p) return 1
    return file.pdfPage(p) ?? 1
  })
  const quickReadingOwnsPdfPage = createMemo(() => {
    const p = path()
    if (!p) return false
    return view().quickReading.active() && view().quickReading.pdfPath() === p
  })

  const pdfAuthHeader = createMemo(() => {
    const http = server.current?.http
    if (!http?.password) return undefined
    return `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`
  })

  const openPdfToMarkdown = () => {
    const p = path()
    if (!p) return
    dialog.show(() => <DialogPdfToMarkdown pdfPath={p} />)
  }

  const openPdfInReadingMode = async () => {
    const p = path()
    if (!p || !params.id) return
    view().quickReading.open(p, p.split("/").pop() ?? "document.pdf")
  }

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
        title: "杩愯澶辫触",
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
        setIsStale(false)
        setNeedsConfirm(false)
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

  /** Rewrite relative image paths in markdown to server /file/raw URLs. */
  const rewriteImagePaths = (md: string): string => {
    const p = path()
    if (!p) return md
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""
    const baseUrl = sdk.url
    const directory = encodeURIComponent(sdk.directory)
    return md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
      // 璺宠繃宸茬粡鏄?URL 鐨勮矾寰?
      if (/^https?:\/\/|^data:/.test(src)) return match
      // 灏嗙浉瀵硅矾寰勮В鏋愪负宸ヤ綔鐩綍涓嬬殑缁濆璺緞
      const absImagePath = dir ? `${dir}/${src}` : src
      const encodedPath = encodeURIComponent(absImagePath)
      return `![${alt}](${baseUrl}/file/raw?path=${encodedPath}&directory=${directory})`
    })
  }

  const renderFile = (source: string) => {
    if (isPDF()) {
      return (
        <div class="relative h-full min-h-0 overflow-hidden" data-file-content>
          <PdfViewerShell
            src={pdfPreviewUrl()}
            authHeader={pdfAuthHeader()}
            mode="compact"
            class="size-full"
            page={quickReadingOwnsPdfPage() ? undefined : pdfPreviewPage()}
            onPageChange={(page) => {
              const p = path()
              if (!p || quickReadingOwnsPdfPage()) return
              file.setPdfPage(p, page)
            }}
            onPdfToMarkdown={openPdfToMarkdown}
            onOpenReadingMode={openPdfInReadingMode}
          />
        </div>
      )
    }
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
        <div class="px-3 pb-1 shrink-0">
          <Show when={isStale() && isTextFile()}>
            <div class="mb-2 flex items-center justify-between gap-3 rounded-md border border-yellow-500/25 bg-yellow-500/10 px-3 py-2">
              <div class="min-w-0">
                <div class="text-xs font-medium text-text-base">检测到未保存草稿</div>
                <div class="text-xs text-text-weak">当前文件已发生变化，review 中显示的是当前真实文件。</div>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <Button size="small" variant="ghost" onClick={discardDraft}>
                  放弃草稿
                </Button>
                <Button size="small" onClick={restoreDraft}>
                  恢复旧草稿
                </Button>
              </div>
            </div>
          </Show>
          <div class="flex justify-end gap-1.5">
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
                <Show when={isTextFile() && !isStale()}>
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
        </div>
      </Show>
      <Show
        when={isEditing()}
        fallback={
          <Show
            when={isPDF()}
            fallback={
              <ScrollView
                class="h-full min-h-0 flex-1"
                viewportRef={(el: HTMLDivElement) => {
                  scroll = el
                  if (switchAnchorText !== null || switchScrollRatio !== null) {
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
            <div class="h-full min-h-0 flex-1 overflow-hidden">
              <Switch>
                <Match when={state()?.loaded}>{renderFile(contents())}</Match>
                <Match when={state()?.loading}>
                  <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
                </Match>
                <Match when={state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Match>
              </Switch>
            </div>
          </Show>
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



