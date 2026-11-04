// Realtime display-list rendering for the regular PDF viewer. rtex exports the layout PDF that
// the viewer shows; this controller paints live paragraph rows into transparent page images on
// top of it. Adapted from realtime-tex-vsc-plugin (MIT; see latex-realtime/LICENSE).
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLatex } from "@/context/latex"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { FontStore, ImageStore, Painter, type Mat } from "./latex-realtime/render"
import { fontKey, type FontResource } from "./latex-realtime/fontKey"
import { PreviewModel } from "./latex-realtime/model"
import type { DisplayList, RtexEvent } from "./latex-realtime/protocol"

const CHANNEL = "aether-pdf-viewer"
const MAX_SIDE = 8192
const MAX_PIXELS = 24_000_000

export type RealtimePost = (message: unknown, transfer?: Transferable[]) => void
export type RealtimeRequest = { page: number; width: number; height: number; dpr: number; src?: string }

export type RealtimeController = {
  src: Accessor<string | undefined>
  status: Accessor<string>
  error: Accessor<string>
  attach: (post: RealtimePost) => void
  request: (input: RealtimeRequest) => void
}

export function createRealtime(active: Accessor<boolean>): RealtimeController {
  const global = useGlobalSDK()
  const sdk = useSDK()
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

  const headers = () => ({
    ...global.auth(),
    "Content-Type": "application/json",
    "x-opencode-directory": encodeURIComponent(sdk.directory),
  })
  const root = () => latex.state.project?.root ?? "."
  const main = () => latex.state.project?.binding?.main ?? latex.state.main

  async function call<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${global.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
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
    },
  }
}
