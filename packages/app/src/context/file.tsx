import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { getFilename } from "@opencode-ai/util/path"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { createPathHelpers } from "./file/path"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"
import { createFileViewCache } from "./file/view-cache"
import { createFileTreeStore } from "./file/tree-store"
import { invalidateFromWatcher } from "./file/watcher"
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "./file/types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

export const { use: useFile, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    useSync()
    const params = useParams()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk.directory)
    const path = createPathHelpers(scope)

    // 文件树中选中的文件/文件夹路径（共享状态，供聊天面板读取）
    const [selectedPaths, setSelectedPaths] = createSignal<Set<string>>(new Set())

    // 编辑器中选中的文字（共享状态，供聊天面板读取）
    // 当用户点击聊天框或文件树时保留高亮，点击文件阅读区域时正常清除
    const [selectedText, setSelectedText] = createSignal("")
    let savedRange: Range | null = null
    const MARK_CLASS = "saved-selection-mark"

    // 检测 CSS Highlight API 是否可用
    const hasHighlightAPI = typeof globalThis.Highlight !== "undefined" && !!CSS.highlights

    // 使用 CSS Highlight API 或 DOM mark 包裹方式保留视觉高亮
    const applyHighlight = (range: Range) => {
      if (hasHighlightAPI) {
        try {
          CSS.highlights!.set("editor-saved-selection", new Highlight(range))
        } catch { /* 静默失败 */ }
      } else {
        // 备用方案：用 <mark> 包裹选中内容
        try {
          clearDomMarks()
          const contents = range.cloneContents()
          // 只在单个文本节点或简单内容时包裹
          const mark = document.createElement("mark")
          mark.className = MARK_CLASS
          mark.style.backgroundColor = "rgba(0, 100, 200, 0.2)"
          mark.style.color = "inherit"
          range.surroundContents(mark)
        } catch {
          // surroundContents 对跨元素的 range 会失败，用 fallback
          clearDomMarks()
        }
      }
    }

    const clearDomMarks = () => {
      document.querySelectorAll(`.${MARK_CLASS}`).forEach((mark) => {
        const parent = mark.parentNode
        if (!parent) return
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
        parent.removeChild(mark)
      })
    }

    const clearHighlight = () => {
      if (hasHighlightAPI) {
        try { CSS.highlights?.delete("editor-saved-selection") } catch {}
      } else {
        clearDomMarks()
      }
    }

    const isFileContentArea = (el: HTMLElement | null) =>
      !!el && (
        !!el.closest("[data-file-content]") ||
        el.tagName === "EMBED" ||
        el.tagName === "IFRAME"
      )

    // mousedown: 点击文件内容区域→清除；点击其他任何地方→立刻应用高亮
    const handleMousedown = (e: MouseEvent) => {
      try {
        const target = e.target as HTMLElement | null
        if (isFileContentArea(target)) {
          clearHighlight()
          savedRange = null
          setSelectedText("")
        } else if (savedRange) {
          applyHighlight(savedRange)
        }
      } catch { /* 静默失败，绝不能阻塞其他事件处理 */ }
    }
    document.addEventListener("mousedown", handleMousedown, true)

    // selectionchange: 只用来捕获文件内容区域内的新选中
    const handleSelectionChange = () => {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed) return

      // 只关心文件内容区域内产生的选中
      const anchor = selection.anchorNode
      const el = anchor instanceof HTMLElement ? anchor : anchor?.parentElement
      if (!isFileContentArea(el ?? null)) return

      const text = selection.toString().trim()
      if (text) {
        clearHighlight()
        setSelectedText(text)
        try {
          savedRange = selection.getRangeAt(0).cloneRange()
        } catch {
          savedRange = null
        }
      }
    }
    document.addEventListener("selectionchange", handleSelectionChange)
    onCleanup(() => {
      document.removeEventListener("selectionchange", handleSelectionChange)
      document.removeEventListener("mousedown", handleMousedown, true)
      clearHighlight()
    })
    const tabs = layout.tabs(() => `${params.dir}${params.id ? "/" + params.id : ""}`)

    const inflight = new Map<string, Promise<void>>()
    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: {},
    })

    const tree = createFileTreeStore({
      scope,
      normalizeDir: path.normalizeDir,
      list: (dir) => sdk.client.file.list({ path: dir }).then((x) => x.data ?? []),
      onError: (message) => {
        showToast({
          variant: "error",
          title: language.t("toast.file.listFailed.title"),
          description: message,
        })
      },
    })

    const evictContent = (keep?: Set<string>) => {
      evictContentLru(keep, (target) => {
        if (!store.file[target]) return
        setStore(
          "file",
          target,
          produce((draft) => {
            draft.content = undefined
            draft.loaded = false
          }),
        )
      })
    }

    createEffect(() => {
      scope()
      inflight.clear()
      resetFileContentLru()
      batch(() => {
        setStore("file", reconcile({}))
        tree.reset()
      })
    })

    const viewCache = createFileViewCache()
    const view = createMemo(() => viewCache.load(scope(), params.id))

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore("file", file, { path: file, name: getFilename(file) })
    }

    const setLoading = (file: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = true
          draft.error = undefined
        }),
      )
    }

    const setLoaded = (file: string, content: FileState["content"]) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loaded = true
          draft.loading = false
          draft.content = content
        }),
      )
    }

    const setLoadError = (file: string, message: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.error = message
        }),
      )
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: message,
      })
    }

    const load = (input: string, options?: { force?: boolean }) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()

      const directory = scope()
      const key = `${directory}\n${file}`
      ensure(file)

      const current = store.file[file]
      if (!options?.force && current?.loaded) return Promise.resolve()

      const pending = inflight.get(key)
      if (pending) return pending

      setLoading(file)

      const promise = sdk.client.file
        .read({ path: file })
        .then((x) => {
          if (scope() !== directory) return
          const content = x.data
          setLoaded(file, content)

          if (!content) return
          touchFileContent(file, approxBytes(content))
          evictContent(new Set([file]))
        })
        .catch((e) => {
          if (scope() !== directory) return
          setLoadError(file, errorMessage(e, language.t("error.chain.unknown")))
        })
        .finally(() => {
          inflight.delete(key)
        })

      inflight.set(key, promise)
      return promise
    }

    const search = (query: string, dirs: "true" | "false") =>
      sdk.client.find.files({ query, dirs }).then(
        (x) => (x.data ?? []).map(path.normalize),
        () => [],
      )

    const stop = sdk.event.listen((e) => {
      invalidateFromWatcher(e.details, {
        normalize: path.normalize,
        hasFile: (file) => Boolean(store.file[file]),
        isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
        loadFile: (file) => {
          void load(file, { force: true })
        },
        closeFile: (file) => {
          const tab = tabs.all().find((tab) => path.pathFromTab(tab) === file)
          if (tab) tabs.close(tab)
        },
        node: tree.node,
        isDirLoaded: tree.isLoaded,
        refreshDir: (dir) => {
          void tree.listDir(dir, { force: true })
        },
      })
    })

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(file)) {
        touchFileContent(file)
        return state
      }
      touchFileContent(file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))

    onCleanup(() => {
      stop()
      viewCache.clear()
    })

    return {
      ready: () => view().ready(),
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: tree.listDir,
        refresh: (input: string) => tree.listDir(input, { force: true }),
        state: tree.dirState,
        children: tree.children,
        expand: tree.expandDir,
        collapse: tree.collapseDir,
        toggle(input: string) {
          if (tree.dirState(input)?.expanded) {
            tree.collapseDir(input)
            return
          }
          tree.expandDir(input)
        },
      },
      get,
      load,
      scrollTop,
      scrollLeft,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      searchFiles: (query: string) => search(query, "false"),
      searchFilesAndDirectories: (query: string) => search(query, "true"),
      selectedPaths,
      setSelectedPaths,
      selectedText,
      clearSelectedText: () => {
        setSelectedText("")
        savedRange = null
        clearHighlight()
      },
    }
  },
})
