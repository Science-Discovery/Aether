import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { Reference } from "@/utils/ask-reference"
import { PdfViewerShell, type PdfAnnotation, type PdfTextSelection } from "./pdf-viewer-shell-official"

const state = vi.hoisted(() => ({
  directory: "",
  toasts: [] as Array<{ title?: string; actions?: Array<{ label: string; onClick: () => void }> }>,
  download: vi.fn(),
}))

vi.mock("@/context/sdk", () => ({
  useSDK: () => ({ url: "http://localhost:4096", directory: state.directory }),
}))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ saveFileDialog: state.download }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: (input: (typeof state.toasts)[number]) => state.toasts.push(input),
}))

type Message = {
  type: string
  document?: string
  config?: { document: string; selectionDocument: string; features: { annotations: boolean } }
  annotations?: PdfAnnotation[]
}

const cleanups: Array<() => void> = []

function annotation(note: string): PdfAnnotation {
  return {
    id: "note-1",
    type: "note",
    color: "yellow",
    pages: [{ page: 1, quads: [[10, 30, 50, 30, 10, 20, 50, 20]] }],
    selectedText: "Selected text",
    note,
    createdAt: 1,
    updatedAt: 2,
  }
}

function file(path: string, note = "loaded") {
  return {
    version: "1.2" as const,
    source: { path, fingerprint: `fingerprint:${path}` },
    annotations: [annotation(note)],
  }
}

function network(
  options: {
    write?: (data: ReturnType<typeof file>, path: string) => Response | Promise<Response>
    read?: (path: string) => Response | Promise<Response>
  } = {},
) {
  const writes: Array<{ path: string; data: ReturnType<typeof file> }> = []
  const exports: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as (typeof writes)[number]
        writes.push(body)
        return options.write ? options.write(body.data, body.path) : Response.json(body.data)
      }
      if (init?.method === "POST") {
        expect(url.pathname).toBe("/file/pdf-annotations/export")
        exports.push(JSON.parse(String(init.body)).path)
        return new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "Content-Type": "application/pdf" } })
      }
      const path = url.searchParams.get("path")!
      return options.read ? options.read(path) : Response.json({ status: "ready", data: file(path) })
    }),
  )
  return { writes, exports }
}

async function mount(ready = true, callback?: (input: PdfTextSelection) => void, references: Reference[] = []) {
  const [props, set] = createStore({ path: "a.pdf", session: "session-a" })
  const host = document.createElement("div")
  document.body.append(host)
  const off = render(
    () => (
      <PdfViewerShell
        src={`/raw/${props.path}`}
        annotationPath={props.path}
        askScope={props.session}
        onTextSelectionAction={callback}
        references={references}
        mode="full"
      />
    ),
    host,
  )
  cleanups.push(() => {
    off()
    host.remove()
  })
  const frame = host.querySelector("iframe")!.contentWindow!
  const messages: Message[] = []
  vi.spyOn(frame, "postMessage").mockImplementation((value: Message) => {
    messages.push(value)
  })
  const key = () => messages.findLast((message) => message.type === "config")!.config!.document
  const send = (type: string, data: object = {}) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame,
        origin: window.location.origin,
        data: { channel: "aether-pdf-viewer", type, ...data },
      }),
    )
  send("ready")
  if (ready)
    await vi.waitFor(() =>
      expect(messages.findLast((message) => message.type === "config")?.config?.features.annotations).toBe(true),
    )
  return { set, key, send, messages }
}

beforeEach(() => {
  state.directory = `/test/${crypto.randomUUID()}`
  state.toasts.length = 0
  state.download.mockReset()
})

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("PDF annotation persistence in the real viewer shell", () => {
  test("blocks export after a failed save and retries the retained draft before downloading", async () => {
    let attempts = 0
    const calls = network({
      write: (data) => (++attempts === 1 ? new Response("failed", { status: 503 }) : Response.json(data)),
    })
    const viewer = await mount()
    viewer.send("annotationchange", { document: viewer.key(), annotations: [annotation("unsaved draft")] })
    await vi.waitFor(() => expect(state.toasts.some((toast) => toast.title === "pdf.annotation.saveFailed")).toBe(true))
    expect(viewer.messages.findLast((message) => message.type === "annotations")?.annotations?.[0].note).toBe(
      "unsaved draft",
    )
    viewer.send("exportannotations", { document: viewer.key() })
    await vi.waitFor(() =>
      expect(state.toasts.some((toast) => toast.title === "pdf.annotation.exportFailed")).toBe(true),
    )
    expect(calls.exports).toEqual([])
    expect(state.download).not.toHaveBeenCalled()

    const retry = state.toasts.findLast((toast) => toast.title === "pdf.annotation.saveFailed")!.actions![0]
    expect(retry.label).toBe("pdf.annotation.saveRetry")
    retry.onClick()
    viewer.send("exportannotations", { document: viewer.key() })
    await vi.waitFor(() => expect(state.download).toHaveBeenCalledTimes(1))
    expect(calls.writes).toHaveLength(2)
    expect(calls.writes.map((write) => write.data.annotations[0].note)).toEqual(["unsaved draft", "unsaved draft"])
    expect(calls.exports).toEqual(["a.pdf"])
    expect(state.download.mock.calls[0][0].name).toBe("a-annotated.pdf")
  })

  test("serializes saves without replacing a newer draft with an older response and waits before export", async () => {
    const first = Promise.withResolvers<Response>()
    const second = Promise.withResolvers<Response>()
    const calls = network({ write: (data) => (data.annotations[0].note === "first" ? first.promise : second.promise) })
    const viewer = await mount()
    viewer.send("annotationchange", { document: viewer.key(), annotations: [annotation("first")] })
    await vi.waitFor(() => expect(calls.writes).toHaveLength(1))
    viewer.send("annotationchange", { document: viewer.key(), annotations: [annotation("latest")] })
    viewer.send("exportannotations", { document: viewer.key() })
    const offset = viewer.messages.length
    expect(viewer.messages.findLast((message) => message.type === "annotations")?.annotations?.[0].note).toBe("latest")
    first.resolve(Response.json(file("a.pdf", "stale server response")))
    await vi.waitFor(() => expect(calls.writes).toHaveLength(2))
    expect(calls.exports).toEqual([])
    expect(state.download).not.toHaveBeenCalled()
    expect(
      viewer.messages
        .slice(offset)
        .flatMap((message) => message.annotations ?? [])
        .map((item) => item.note),
    ).not.toContain("stale server response")
    second.resolve(Response.json(file("a.pdf", "latest saved")))
    await vi.waitFor(() => expect(state.download).toHaveBeenCalledTimes(1))
    expect(viewer.messages.findLast((message) => message.type === "annotations")?.annotations?.[0].note).toBe(
      "latest saved",
    )
    expect(calls.writes.map((write) => write.data.annotations[0].note)).toEqual(["first", "latest"])
    expect(calls.exports).toEqual(["a.pdf"])
  })

  test("isolates a pending save and ignores messages from the previous document after switching", async () => {
    const pending = Promise.withResolvers<Response>()
    const calls = network({ write: () => pending.promise })
    const viewer = await mount()
    const source = viewer.key()
    viewer.send("annotationchange", { document: source, annotations: [annotation("old document draft")] })
    await vi.waitFor(() => expect(calls.writes).toHaveLength(1))
    viewer.set("path", "b.pdf")
    await vi.waitFor(() => expect(viewer.key()).not.toBe(source))
    const target = viewer.key()
    await vi.waitFor(() =>
      expect(viewer.messages.findLast((message) => message.type === "config")?.config?.features.annotations).toBe(true),
    )
    const offset = viewer.messages.length
    viewer.send("annotationchange", { document: source, annotations: [annotation("late iframe message")] })
    viewer.send("exportannotations", { document: source })
    pending.resolve(Response.json(file("a.pdf", "late saved response")))
    viewer.send("exportannotations", { document: target })
    await vi.waitFor(() => expect(state.download).toHaveBeenCalledTimes(1))
    expect(calls.writes).toHaveLength(1)
    expect(calls.writes[0].path).toBe("a.pdf")
    expect(calls.exports).toEqual(["b.pdf"])
    const updates = viewer.messages.slice(offset).filter((message) => message.type === "annotations")
    expect(updates.every((message) => message.document === target)).toBe(true)
    expect(updates.flatMap((message) => message.annotations ?? []).map((item) => item.note)).not.toContain(
      "late saved response",
    )
    expect(viewer.messages.findLast((message) => message.type === "annotations")?.annotations?.[0].note).toBe("loaded")
  })

  test("does not restore the previous document when its initial load resolves late", async () => {
    const pending = Promise.withResolvers<Response>()
    const calls = network({
      read: (path) =>
        path === "a.pdf" ? pending.promise : Response.json({ status: "ready", data: file(path, "new document") }),
    })
    const viewer = await mount(false)
    const source = viewer.key()
    viewer.set("path", "b.pdf")
    await vi.waitFor(() =>
      expect(viewer.messages.findLast((message) => message.type === "annotations")?.annotations?.[0].note).toBe(
        "new document",
      ),
    )
    const offset = viewer.messages.length
    pending.resolve(Response.json({ status: "ready", data: file("a.pdf", "late old document") }))
    viewer.send("exportannotations", { document: viewer.key() })
    await vi.waitFor(() => expect(state.download).toHaveBeenCalledTimes(1))
    expect(viewer.key()).not.toBe(source)
    expect(calls.exports).toEqual(["b.pdf"])
    expect(
      viewer.messages
        .slice(offset)
        .flatMap((message) => message.annotations ?? [])
        .map((item) => item.note),
    ).not.toContain("late old document")
    expect(viewer.messages.findLast((message) => message.type === "annotations")?.annotations?.[0].note).toBe(
      "new document",
    )
  })
})

describe("PDF selection questions in the real viewer shell", () => {
  test("loads the saved question only for the same PDF page and selection", async () => {
    network()
    const base = {
      id: "image-1",
      version: 1,
      question: "First page question",
      text: "",
      summary: "Region",
      kind: "pdf" as const,
      mode: "quick" as const,
      path: "a.pdf",
      filename: "a.pdf",
      startPage: 1,
      endPage: 1,
      selection: "same-rectangle",
      content: "image" as const,
      settings: { questionPrompt: "Answer" },
    }
    const viewer = await mount(true, undefined, [
      base,
      { ...base, id: "image-2", startPage: 2, endPage: 2, question: "Second page question" },
    ])
    const key = viewer.messages.findLast((item) => item.type === "config")!.config!.selectionDocument
    viewer.send("imageselectionaction", {
      document: key,
      action: "ask",
      selection: "same-rectangle",
      page: 2,
      imageDataUrl: "data:image/png;base64,AA==",
      rect: { top: 10, left: 10, right: 120, bottom: 50 },
    })
    const input = document.querySelector<HTMLTextAreaElement>('[data-component="ask-editor"] textarea')!
    expect(input.value).toBe("Second page question")
    input.value = "Discard this edit"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(document.querySelector('[data-component="ask-editor"]')).toBeNull()
    expect(base.question).toBe("First page question")
  })

  test("opens a local editor, saves once, and rejects old document and session events", async () => {
    network()
    const save = vi.fn()
    const viewer = await mount(true, save)
    const key = () => viewer.messages.findLast((item) => item.type === "config")!.config!.selectionDocument
    const data = () => ({
      document: key(),
      action: "ask",
      selection: "page1-quad",
      startPage: 1,
      endPage: 1,
      text: "Quoted text",
      rect: { top: 10, left: 10, right: 120, bottom: 50 },
    })
    viewer.send("textselectionaction", data())
    const editor = () => document.querySelector<HTMLFormElement>('[data-component="ask-editor"]')
    await vi.waitFor(() => expect(editor()).not.toBeNull())
    expect(save).not.toHaveBeenCalled()
    const input = editor()!.querySelector("textarea")!
    input.value = "Why?"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    editor()!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(save).toHaveBeenCalledOnce()
    expect(save.mock.calls[0][0]).toMatchObject({ question: "Why?", selection: "page1-quad", text: "Quoted text" })
    expect(editor()).toBeNull()
    expect(viewer.messages.at(-1)?.type).toBe("askclose")

    const old = data()
    viewer.send("textselectionaction", old)
    expect(editor()).not.toBeNull()
    viewer.set("session", "session-b")
    await vi.waitFor(() => expect(editor()).toBeNull())
    viewer.send("textselectionaction", old)
    expect(editor()).toBeNull()
    viewer.send("textselectionaction", data())
    expect(editor()).not.toBeNull()
    const previous = data()
    viewer.set("path", "b.pdf")
    await vi.waitFor(() => expect(editor()).toBeNull())
    viewer.send("textselectionaction", previous)
    expect(editor()).toBeNull()
    expect(save).toHaveBeenCalledOnce()
  })
})
