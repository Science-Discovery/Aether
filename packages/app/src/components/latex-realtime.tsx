// Realtime display-list rendering for the regular PDF viewer. rtex exports the layout PDF that
// the viewer shows; this controller paints live paragraph rows into transparent page images on
// top of it. Adapted from realtime-tex-vsc-plugin (MIT; see latex-realtime/LICENSE).
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { contains } from "@/components/latex-drafts"
import { useFile } from "@/context/file"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLatex } from "@/context/latex"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { FontStore, ImageStore, Painter, type Mat } from "./latex-realtime/render"
import { fontKey, type FontResource } from "./latex-realtime/fontKey"
import { charAtOffset, caretAt, clickedChar, matchScore, sourceOffset, unitRows } from "./latex-realtime/glyph"
import { PreviewModel } from "./latex-realtime/model"
import type { DisplayList, RtexEvent } from "./latex-realtime/protocol"
import { anchorsFor, pageBlocks, reproject, same } from "./latex-realtime/annotations"
import { glyphTextOf, type GlyphText } from "./latex-realtime/text"
import type { PdfAnnotationFile, PdfAnnotationStore } from "./pdf-viewer-shell-official"
import {
  byteOffset,
  hitTest,
  lineColumn,
  spanAt,
  targetInFragments,
  utf16Offset,
  type Span,
} from "./latex-realtime/source"

const CHANNEL = "aether-pdf-viewer"
const MAX_SIDE = 8192
const MAX_PIXELS = 24_000_000
const SP_PER_PT = 65536
const TEX_TO_BP = 72 / 72.27
const BP_TO_SP = SP_PER_PT * (72.27 / 72)

export type RealtimePost = (message: unknown, transfer?: Transferable[]) => void
export type RealtimeRequest = { page: number; width: number; height: number; dpr: number; src?: string }
export type RealtimeLocate = { page: number; x: number; y: number }
export type RealtimeSource = { path: string; line: number; column: number }

export type RealtimeController = {
  src: Accessor<string | undefined>
  status: Accessor<string>
  error: Accessor<string>
  attach: (post: RealtimePost) => void
  request: (input: RealtimeRequest) => void
  locate: (input: RealtimeLocate) => Promise<RealtimeSource | undefined>
  annotationStore: PdfAnnotationStore
}

export function createRealtime(active: Accessor<boolean>): RealtimeController {
  const global = useGlobalSDK()
  const sdk = useSDK()
  const file = useFile()
  const latex = useLatex()
  const language = useLanguage()
  const model = new PreviewModel()
  const fonts = new FontStore()
  const images = new ImageStore(async () => {
    throw new Error("images are drawn from the layout PDF")
  })
  const sizes = new Map<number, RealtimeRequest>()
  const painted = new Set<number>()
  const tokens = new Map<number, number>()
  const loading = new Map<string, Promise<void>>()
  const sent = new Map<string, string>()
  const baselines = new Map<string, Promise<string | undefined>>()
  const [session, setSession] = createSignal("")
  const [layout, setLayout] = createSignal(0)
  const [status, setStatus] = createSignal("")
  const [error, setError] = createSignal("")
  const [tick, setTick] = createSignal(0)
  let post: RealtimePost | undefined
  let stream: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let paint: ReturnType<typeof setTimeout> | undefined
  let flushing = false
  let dirty = false
  let epoch = 0
  let lifecycle = 0
  let disposed = false
  // Overlays may only be painted once the viewer has rendered the layout PDF they belong to.
  let loaded = false
  let generation = 0
  let pendingReveal: RealtimeSource | undefined

  const headers = () => ({
    ...global.auth(),
    "Content-Type": "application/json",
    "x-opencode-directory": encodeURIComponent(sdk.directory),
  })
  const root = () => latex.state.project?.root ?? "."
  const main = () => latex.state.project?.binding?.main ?? latex.state.main

  async function call<T>(path: string, body?: unknown, method?: "POST" | "PUT"): Promise<T> {
    const response = await fetch(`${global.url}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      let message = text || `HTTP ${response.status}`
      try {
        const value = JSON.parse(text) as { error?: unknown }
        if (typeof value.error === "string") message = value.error
      } catch {
        /* keep the raw response */
      }
      throw new Error(message)
    }
    return (await response.json()) as T
  }

  async function open(owner: number) {
    if (session()) return
    const version = epoch
    setError("")
    setStatus(language.t("latex.realtime.starting"))
    try {
      const value = await call<{ id: string }>("/latex/realtime/open", { root: root(), main: main() })
      if (version !== epoch || owner !== lifecycle || disposed) {
        void call("/latex/realtime/close", { id: value.id }).catch(() => undefined)
        return
      }
      setSession(value.id)
      const ctrl = new AbortController()
      stream = ctrl
      void events(value.id, ctrl.signal).catch((cause: unknown) => {
        if (ctrl.signal.aborted) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      sendDrafts()
    } catch (cause) {
      if (version !== epoch || owner !== lifecycle || disposed) return
      setStatus("")
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function close() {
    epoch++
    clearTimeout(timer)
    clearTimeout(paint)
    paint = undefined
    dirty = false
    stream?.abort()
    stream = undefined
    const id = session()
    setSession("")
    setLayout(0)
    model.clear()
    sizes.clear()
    painted.clear()
    tokens.clear()
    loaded = false
    generation++
    pendingReveal = undefined
    loading.clear()
    sent.clear()
    baselines.clear()
    setStatus("")
    setError("")
    post?.({ channel: CHANNEL, type: "realtime-reset" })
    if (id) await call("/latex/realtime/close", { id }).catch(() => undefined)
  }

  async function events(id: string, signal: AbortSignal) {
    const response = await fetch(`${global.url}/latex/realtime/events?id=${id}`, {
      headers: headers(),
      signal,
    })
    if (!response.ok || !response.body) throw new Error(`The realtime event stream failed (HTTP ${response.status}).`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let at = buffer.indexOf("\n\n")
      while (at >= 0) {
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data) {
          try {
            handle(JSON.parse(data) as RtexEvent)
          } catch {
            /* ignore malformed frames */
          }
        }
        at = buffer.indexOf("\n\n")
      }
    }
  }

  function sendDrafts() {
    clearTimeout(timer)
    if (!session()) return
    timer = setTimeout(() => void flushDrafts(), 80)
  }

  function baseline(path: string) {
    let value = baselines.get(path)
    if (!value) {
      value = sdk.client.file
        .read({ path }, { throwOnError: true })
        .then((result) => (result.data?.type === "text" ? result.data.content : undefined))
        .catch(() => undefined)
      baselines.set(path, value)
    }
    return value
  }

  async function flushDrafts() {
    if (flushing) {
      dirty = true
      return
    }
    flushing = true
    try {
      const id = session()
      if (!id) return
      const project = root().replaceAll("\\", "/")
      for (const draft of latex.drafts()) {
        if (draft.content === undefined) continue
        const source = draft.path.replaceAll("\\", "/")
        if (project !== "." && project !== "" && !source.startsWith(`${project}/`)) continue
        const path = relative(source)
        const text = draft.content
        const previous = sent.get(path)
        if (previous !== undefined) {
          if (previous === text) continue
          const edit = diff(previous, text)
          sent.set(path, text)
          void call("/latex/realtime/edit", { id, path, ...edit }).catch(() => undefined)
          continue
        }
        // rtex loaded the file from disk when the session opened. Use that text as the edit
        // baseline so the first keystroke is a fast edit rather than a full set_document.
        const disk = await baseline(source)
        if (session() !== id) return
        if (disk === undefined) {
          sent.set(path, text)
          void call("/latex/realtime/document", { id, path, text }).catch(() => undefined)
          continue
        }
        sent.set(path, text)
        if (disk === text) continue
        const edit = diff(disk, text)
        void call("/latex/realtime/edit", { id, path, ...edit }).catch(() => undefined)
      }
    } finally {
      flushing = false
      if (dirty) {
        dirty = false
        sendDrafts()
      }
    }
  }

  function relative(value: string) {
    const project = root()
    if (project === "." || project === "") return value
    const prefix = `${project.replaceAll("\\", "/")}/`
    return value.startsWith(prefix) ? value.slice(prefix.length) : value
  }

  function diff(oldText: string, newText: string) {
    const encoder = new TextEncoder()
    let start = 0
    while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++
    let oldEnd = oldText.length
    let newEnd = newText.length
    while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
      oldEnd--
      newEnd--
    }
    return {
      start: encoder.encode(oldText.slice(0, start)).length,
      end: encoder.encode(oldText.slice(0, oldEnd)).length,
      text: newText.slice(start, newEnd),
    }
  }

  function handle(event: RtexEvent) {
    if (!session()) return
    switch (event.event) {
      case "LayoutUpdate":
        void applyLayout(event)
        return
      case "ParagraphUpdate":
        applyParagraph(event)
        return
      case "BackgroundScheduled":
        setStatus(language.t("latex.realtime.waiting"))
        return
      case "EngineState":
        setStatus(event.state)
        if (event.state === "Failed") setError(event.reason ?? "The realtime engine failed.")
        return
      case "Diagnostics":
        if (event.items.length) setStatus(language.t("latex.realtime.diagnostics", { count: event.items.length }))
        return
      case "SessionError":
        setError(event.message)
        return
      case "SessionExit":
        if (session()) setError(language.t("latex.realtime.exited"))
        return
    }
  }

  function applyLayout(event: Extract<RtexEvent, { event: "LayoutUpdate" }>) {
    setStatus(
      event.convergence.state === "Converged"
        ? language.t("latex.realtime.live")
        : language.t("latex.realtime.converging"),
    )
    const keepFromRevision = event.convergence.state === "Stale" ? event.convergence.pending_since : null
    model.applyLayout({
      pages: event.pages_changed,
      pagesTotal: event.pages_total,
      placements: event.placements,
      keepFromRevision,
    })
    const version = event.versions.layout_version
    if (version !== layout()) {
      setLayout(version)
      // The viewer is about to show another layout PDF; old overlay pixels belong to the old one.
      painted.clear()
      sizes.clear()
      loaded = false
      generation++
      post?.({ channel: CHANNEL, type: "realtime-reset" })
    }
    setTick((value) => value + 1)
    if (pendingReveal) void flushReveal()
    if (latex.drafts().length) sendDrafts()
  }

  function applyParagraph(event: Extract<RtexEvent, { event: "ParagraphUpdate" }>) {
    const pages =
      event.status === "removed"
        ? model.dropOverlays([event.par_id])
        : event.status === "error"
          ? new Set<number>()
          : model.applyParagraph(event.par_id, event.dl, event.fragments, event.versions.source_revision)
    if (event.status === "error" && event.diagnostics.length)
      setStatus(language.t("latex.realtime.diagnostics", { count: event.diagnostics.length }))
    if (pages.size) setTick((value) => value + 1)
  }

  function font(desc: DisplayList["fonts"][string]) {
    const key = fontKey(desc)
    if (fonts.has(key)) return Promise.resolve()
    let promise = loading.get(key)
    if (!promise) {
      const query = new URLSearchParams({ id: session() })
      if (desc.filename) query.set("filename", desc.filename)
      if (desc.name) query.set("name", desc.name)
      promise = (async () => {
        try {
          const response = await fetch(`${global.url}/latex/realtime/font?${query}`, { headers: headers() })
          if (response.ok) {
            const type = response.headers.get("content-type") ?? ""
            if (type.includes("application/json")) {
              const value = (await response.json()) as FontResource
              if (value.kind === "type1") fonts.add(key, value)
              else fonts.add(key, { kind: "missing", reason: "Unsupported font resource." })
            } else fonts.add(key, { kind: "sfnt", data: new Uint8Array(await response.arrayBuffer()) })
          } else fonts.add(key, { kind: "missing", reason: "font unavailable" })
        } catch {
          fonts.add(key, { kind: "missing", reason: "font unavailable" })
        } finally {
          loading.delete(key)
        }
      })()
      loading.set(key, promise)
    }
    return promise
  }

  function loadFonts(dl: DisplayList) {
    return Promise.all(Object.values(dl.fonts).map(font))
  }

  function schedule() {
    if (!loaded || paint) return
    paint = setTimeout(() => {
      paint = undefined
      for (const page of sizes.keys()) void render(page).catch(() => undefined)
    }, 16)
  }

  async function render(page: number) {
    const size = sizes.get(page)
    if (!size) return
    const token = (tokens.get(page) ?? 0) + 1
    tokens.set(page, token)
    const source = size.src || src()
    const gen = generation
    const rows = model.overlaysOn(page)
    if (!rows.length) {
      if (painted.delete(page)) post?.({ channel: CHANNEL, type: "realtime-page-clear", page, src: source })
      return
    }
    const update = model.pages.get(page)
    if (!update?.dl.page_width || !update.dl.page_height || !source) return
    const dpr = Math.min(3, Math.max(0.25, size.dpr))
    const scale = Math.min(1, MAX_SIDE / Math.max(1, size.width * dpr), MAX_SIDE / Math.max(1, size.height * dpr))
    const area = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, size.width * dpr * size.height * dpr)))
    const width = Math.max(1, Math.round(size.width * dpr * scale * area))
    const height = Math.max(1, Math.round(size.height * dpr * scale * area))
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) return
    const base: Mat = [width / update.dl.page_width, 0, 0, height / update.dl.page_height, 0, 0]
    context.clearRect(0, 0, width, height)
    const hidden = model.hiddenLines(page)
    if (hidden.size)
      new Painter(context, base, fonts, images).clearLines(
        update.dl.lines.filter((_, index) => hidden.has(index)).map((line) => ({ line, dx: 0, dy: 0 })),
        "#fff",
      )
    await Promise.all(rows.map((row) => loadFonts(row.overlay.dl)))
    if (token !== tokens.get(page) || gen !== generation || !post) return
    for (const row of rows) {
      const painter = new Painter(context, base, fonts, images)
      // the layout PDF already draws images; the live layer only supplies text and rules
      for (const item of row.rows)
        painter.draw(
          row.overlay.dl,
          item.line.items.filter((value) => value[0] !== "i"),
          item.dx,
          item.dy,
        )
    }
    const bitmap = await createImageBitmap(canvas)
    if (token !== tokens.get(page) || gen !== generation || !post) {
      bitmap.close()
      return
    }
    painted.add(page)
    post({ channel: CHANNEL, type: "realtime-page", page, src: source, bitmap }, [bitmap])
  }

  async function sourceText(path: string) {
    const draft = file.draft(path)
    if (draft !== undefined) return draft
    const content = file.get(path)?.content
    if (content?.type === "text") return content.content
    const result = await sdk.client.file.read({ path }, { throwOnError: true }).catch(() => undefined)
    return result?.data?.type === "text" ? result.data.content : undefined
  }

  async function getSpans(path: string) {
    const id = session()
    if (!id) return [] as Span[]
    const result = await call<{ spans: Span[] }>("/latex/realtime/spans", { id, path }).catch(() => undefined)
    return result?.spans ?? []
  }

  const emptyAnnotations = (): PdfAnnotationFile => ({
    version: "1.2",
    source: { path: "realtime", fingerprint: "realtime" },
    annotations: [],
  })

  async function loadAnnotations() {
    if (!session()) return { data: emptyAnnotations(), revision: "0" }
    const project = root()
    const name = main()
    const result = await call<{ data: PdfAnnotationFile; revision: string }>(
      `/latex/realtime/annotations?root=${encodeURIComponent(project)}&main=${encodeURIComponent(name)}`,
    )
    if (!model.hasLayout) return result
    const annotations = reproject(model, result.data.annotations)
    if (same(annotations, result.data.annotations)) return result
    const next = { ...result.data, annotations }
    const saved = await call<{ data: PdfAnnotationFile; revision: string }>(
      "/latex/realtime/annotations",
      { root: project, main: name, data: next, revision: result.revision },
      "PUT",
    ).catch(() => undefined)
    return saved ?? { data: next, revision: result.revision }
  }

  async function saveAnnotations(input: { data: PdfAnnotationFile; revision?: string }) {
    if (!session()) return input
    const data = {
      ...input.data,
      annotations: input.data.annotations.map((item) => {
        if (item.anchor || item.anchors) return item
        const anchors = anchorsFor(model, item)
        return anchors.length ? { ...item, anchors } : item
      }),
    }
    return call<{ data: PdfAnnotationFile; revision: string }>(
      "/latex/realtime/annotations",
      { root: root(), main: main(), data, revision: input.revision },
      "PUT",
    )
  }

  const annotationStore: PdfAnnotationStore = { load: loadAnnotations, save: saveAnnotations }

  function sources() {
    const project = latex.state.project
    const root = project?.root ?? "."
    const list = new Set<string>()
    if (latex.state.path) list.add(latex.state.path)
    if (project?.binding?.main) list.add(join(root, project.binding.main))
    for (const draft of latex.drafts()) list.add(draft.path)
    for (const editor of project?.editors ?? []) list.add(editor.path)
    return [...list].filter((path) => !root || root === "." || contains(root, path))
  }

  function join(root: string, path: string) {
    const rel = path.replaceAll("\\", "/")
    const dir = root.replaceAll("\\", "/").replace(/\/$/, "")
    return !dir || dir === "." ? rel : `${dir}/${rel}`
  }

  async function findSpan(parIds: number[], glyphs?: GlyphText) {
    for (const path of sources()) {
      const spans = await getSpans(relative(path))
      const span = spans.find((item) => parIds.includes(item.id))
      if (!span) continue
      const value = await sourceText(path)
      if (value === undefined) continue
      const start = utf16Offset(value, span.range.start)
      const unit = value.slice(start, utf16Offset(value, span.range.end))
      if (glyphs && parIds.length > 1 && matchScore(glyphs, unit) < 0.5) continue
      return { path, span, text: value }
    }
    return undefined
  }

  function exactTarget(span: Span, text: string, byte: number) {
    const frags = model.currentPlacements().get(span.id)
    if (!frags?.length) return undefined
    const start = utf16Offset(text, span.range.start)
    const unit = text.slice(start, utf16Offset(text, span.range.end))
    const off = utf16Offset(text, byte) - start
    let best: ({ page: number; x: number; y: number; size: number } & { distance: number }) | undefined
    for (const page of new Set(frags.map((value) => value.page))) {
      const rows = unitRows(model, page).get(span.id)
      if (!rows?.length) continue
      const glyphs = glyphTextOf(rows)
      const char = charAtOffset(glyphs, unit, off)
      if (!char || char.distance > 40) continue
      const caret = caretAt(glyphs, char)
      if (caret && (!best || char.distance < best.distance)) best = { page, ...caret, distance: char.distance }
    }
    if (best) return { page: best.page, x: best.x, y: best.y, size: best.size }
    return targetInFragments(frags, (byte - span.range.start) / Math.max(1, span.range.end - span.range.start))
  }

  async function reveal(position: RealtimeSource) {
    const id = session()
    if (!id || !layout() || !contains(root(), position.path)) return
    const text = await sourceText(position.path)
    if (text === undefined || session() !== id) return
    const byte = byteOffset(text, position.line, position.column)
    const spans = await getSpans(relative(position.path))
    if (session() !== id) return
    const span = spanAt(spans, byte)
    if (!span) return
    const target = exactTarget(span, text, byte)
    if (!target) return
    const page = model.pages.get(target.page)
    const source = src()
    if (!page?.dl.page_height || !source) return
    post?.({
      channel: CHANNEL,
      type: "realtime-caret",
      src: source,
      page: target.page,
      x: (target.x / SP_PER_PT) * TEX_TO_BP,
      y: ((page.dl.page_height - target.y) / SP_PER_PT) * TEX_TO_BP,
      size: ((target.size ?? 655360) / SP_PER_PT) * TEX_TO_BP,
    })
  }

  async function flushReveal() {
    const position = pendingReveal
    if (!position) return
    pendingReveal = undefined
    if (!session() || !layout() || !loaded) {
      pendingReveal = position
      return
    }
    await reveal(position)
  }

  async function locate(input: RealtimeLocate): Promise<RealtimeSource | undefined> {
    const id = session()
    if (!id) return
    const update = model.pages.get(input.page)
    if (!update?.dl.page_height) return
    const x = input.x * BP_TO_SP
    const y = update.dl.page_height - input.y * BP_TO_SP
    const char = clickedChar(model, input.page, x, y)
    const rough = char ? undefined : hitTest(model.currentPlacements(), input.page, y)
    const parIds = char?.parIds ?? (rough ? [rough.parId] : [])
    if (!parIds.length) return
    const found = await findSpan(parIds, char?.gt)
    if (session() !== id) return
    if (!found) {
      showToast({ title: language.t("latex.sync.locate"), description: language.t("latex.sync.nomatch") })
      return
    }
    const start = utf16Offset(found.text, found.span.range.start)
    const unit = found.text.slice(start, utf16Offset(found.text, found.span.range.end))
    if (char) {
      const exact = sourceOffset(char.gt, char.index, char.after, unit)
      if (exact !== undefined) return { path: found.path, ...lineColumn(found.text, start + exact) }
    }
    const fraction = char ? char.index / Math.max(1, char.gt.text.length) : (rough?.fraction ?? 0)
    const byte =
      found.span.range.start + Math.floor(fraction * Math.max(0, found.span.range.end - found.span.range.start))
    const offset = utf16Offset(found.text, Math.min(byte, found.span.range.end))
    const at = lineColumn(found.text, offset)
    const lineStart = found.text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1
    const lineEnd = found.text.indexOf("\n", lineStart)
    const line = found.text.slice(lineStart, lineEnd < 0 ? found.text.length : lineEnd)
    const first = line.search(/\S/)
    return { path: found.path, line: at.line, column: first >= 0 ? first + 1 : at.column }
  }

  const src = () => {
    const id = session()
    const version = layout()
    if (!id || version < 1) return undefined
    return `${global.url}/latex/realtime/pdf?id=${encodeURIComponent(id)}&version=${version}&directory=${encodeURIComponent(sdk.directory)}`
  }
  const strip = (value: string) => value.replace(/([?&])r=\d+$/, "")
  const current = (value?: string) => !value || !src() || strip(value) === strip(src()!)

  createEffect(
    on(
      () => [active(), root(), main()] as const,
      ([value]) => {
        const owner = ++lifecycle
        void close().then(() => {
          if (owner !== lifecycle || !value || disposed) return
          void open(owner)
        })
      },
    ),
  )
  createEffect(
    on(
      () =>
        latex
          .drafts()
          .map((draft) => `${draft.path}\0${draft.content ?? ""}`)
          .join("\u0000"),
      sendDrafts,
      { defer: true },
    ),
  )
  createEffect(on(tick, schedule))
  createEffect(
    on(
      () => latex.state.locating.nonce,
      () => {
        const locating = latex.state.locating
        if (!active() || !locating.path) return
        pendingReveal = { path: locating.path, line: locating.line, column: locating.column }
        void flushReveal()
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    disposed = true
    void close()
  })

  return {
    src,
    status,
    error,
    attach(next) {
      post = next
      painted.clear()
      post?.({ channel: CHANNEL, type: "realtime-reset" })
      schedule()
    },
    request(input) {
      if (!active() || !current(input.src)) return
      loaded = true
      sizes.set(input.page, input)
      void render(input.page).catch(() => undefined)
      post?.({
        channel: CHANNEL,
        type: "realtime-blocks",
        src: input.src,
        page: input.page,
        blocks: pageBlocks(model, input.page),
      })
      if (pendingReveal) void flushReveal()
    },
    locate,
    annotationStore,
  }
}
