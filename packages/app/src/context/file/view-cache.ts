import { createEffect, createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { createScopedCache } from "@/utils/scoped-cache"
import type { FileViewState, SelectedLineRange } from "./types"

const WORKSPACE_KEY = "__workspace__"
const MAX_FILE_VIEW_SESSIONS = 20
const MAX_VIEW_FILES = 500

function normalizeSelectedLines(range: SelectedLineRange): SelectedLineRange {
  if (range.start <= range.end) return { ...range }

  const startSide = range.side
  const endSide = range.endSide ?? startSide

  return {
    ...range,
    start: range.end,
    end: range.start,
    side: endSide,
    endSide: startSide !== endSide ? startSide : undefined,
  }
}

function equalSelectedLines(a: SelectedLineRange | null | undefined, b: SelectedLineRange | null | undefined) {
  if (!a && !b) return true
  if (!a || !b) return false
  const left = normalizeSelectedLines(a)
  const right = normalizeSelectedLines(b)
  return (
    left.start === right.start && left.end === right.end && left.side === right.side && left.endSide === right.endSide
  )
}

function createViewSession(dir: string, id: string | undefined) {
  const legacyViewKey = `${dir}/file${id ? "/" + id : ""}.v1`

  const [view, setView, _, ready] = persisted(
    Persist.scoped(dir, id, "file-view", [legacyViewKey]),
    createStore<{
      file: Record<string, FileViewState>
    }>({
      file: {},
    }),
  )

  const meta = { pruned: false }

  const pruneView = (keep?: string) => {
    const keys = Object.keys(view.file)
    if (keys.length <= MAX_VIEW_FILES) return

    const drop = keys.filter((key) => key !== keep).slice(0, keys.length - MAX_VIEW_FILES)
    if (drop.length === 0) return

    setView(
      produce((draft) => {
        for (const key of drop) {
          delete draft.file[key]
        }
      }),
    )
  }

  createEffect(() => {
    if (!ready()) return
    if (meta.pruned) return
    meta.pruned = true
    pruneView()
  })

  const scrollTop = (path: string) => view.file[path]?.scrollTop
  const scrollLeft = (path: string) => view.file[path]?.scrollLeft
  const pdfPage = (path: string) => view.file[path]?.pdfPage
  const selectedLines = (path: string) => view.file[path]?.selectedLines
  const wordWrap = (path: string) => view.file[path]?.wordWrap
  const isEditing = (path: string) => view.file[path]?.isEditing
  const draft = (path: string) => view.file[path]?.draft
  const draftBase = (path: string) => view.file[path]?.draftBase

  const setScrollTop = (path: string, top: number) => {
    setView(
      produce((draft) => {
        const file = draft.file[path] ?? (draft.file[path] = {})
        if (file.scrollTop === top) return
        file.scrollTop = top
      }),
    )
    pruneView(path)
  }

  const setScrollLeft = (path: string, left: number) => {
    setView(
      produce((draft) => {
        const file = draft.file[path] ?? (draft.file[path] = {})
        if (file.scrollLeft === left) return
        file.scrollLeft = left
      }),
    )
    pruneView(path)
  }

  const setPdfPage = (path: string, page: number) => {
    const next = Number.isFinite(page) && page > 0 ? Math.round(page) : undefined
    if (!next) return
    setView(
      produce((draft) => {
        const file = draft.file[path] ?? (draft.file[path] = {})
        if (file.pdfPage === next) return
        file.pdfPage = next
      }),
    )
    pruneView(path)
  }

  const setSelectedLines = (path: string, range: SelectedLineRange | null) => {
    const next = range ? normalizeSelectedLines(range) : null
    setView(
      produce((draft) => {
        const file = draft.file[path] ?? (draft.file[path] = {})
        if (equalSelectedLines(file.selectedLines, next)) return
        file.selectedLines = next
      }),
    )
    pruneView(path)
  }

  const setWordWrap = (path: string, wrap: boolean) => {
    setView(
      produce((draft) => {
        const file = draft.file[path] ?? (draft.file[path] = {})
        if (file.wordWrap === wrap) return
        file.wordWrap = wrap
      }),
    )
    pruneView(path)
  }

  const setIsEditing = (path: string, editing: boolean) => {
    setView(
      produce((draft) => {
        const file = draft.file[path] ?? (draft.file[path] = {})
        if (file.isEditing === editing) return
        file.isEditing = editing
      }),
    )
    pruneView(path)
  }

  const setDraft = (path: string, value: string) => {
    setView(
      produce((draft) => {
        const file = draft.file[path] ?? (draft.file[path] = {})
        if (file.draft === value) return
        file.draft = value
      }),
    )
    pruneView(path)
  }

  const setDraftBase = (path: string, value: string) => {
    setView(
      produce((draft) => {
        const file = draft.file[path] ?? (draft.file[path] = {})
        if (file.draftBase === value) return
        file.draftBase = value
      }),
    )
    pruneView(path)
  }

  const clearDraftMeta = (path: string) => {
    setView(
      produce((draft) => {
        const file = draft.file[path]
        if (!file) return
        if (file.draft === undefined && file.draftBase === undefined && file.isEditing === undefined) return
        delete file.draft
        delete file.draftBase
        delete file.isEditing
      }),
    )
  }

  return {
    ready,
    scrollTop,
    scrollLeft,
    pdfPage,
    selectedLines,
    wordWrap,
    isEditing,
    draft,
    draftBase,
    setScrollTop,
    setScrollLeft,
    setPdfPage,
    setSelectedLines,
    setWordWrap,
    setIsEditing,
    setDraft,
    setDraftBase,
    clearDraftMeta,
  }
}

export function createFileViewCache() {
  const cache = createScopedCache(
    (key) => {
      const split = key.lastIndexOf("\n")
      const dir = split >= 0 ? key.slice(0, split) : key
      const id = split >= 0 ? key.slice(split + 1) : WORKSPACE_KEY
      return createRoot((dispose) => ({
        value: createViewSession(dir, id === WORKSPACE_KEY ? undefined : id),
        dispose,
      }))
    },
    {
      maxEntries: MAX_FILE_VIEW_SESSIONS,
      dispose: (entry) => entry.dispose(),
    },
  )

  return {
    load: (dir: string, id: string | undefined) => {
      const key = `${dir}\n${id ?? WORKSPACE_KEY}`
      return cache.get(key).value
    },
    clear: () => cache.clear(),
  }
}
