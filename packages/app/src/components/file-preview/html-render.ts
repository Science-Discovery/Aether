import type { HtmlRead } from "./html-convert"
import type { HtmlOutput, HtmlRequest, HtmlResponse } from "./html-bridge"

export async function htmlRender(input: {
  path: string
  source: string
  signal: AbortSignal
  read: HtmlRead
  draft?: (path: string) => string | undefined
  worker?: () => Worker
}) {
  input.signal.throwIfAborted()
  const worker = input.worker?.() ?? new Worker(new URL("./html-worker.ts", import.meta.url), { type: "module" })
  const controller = new AbortController()
  return new Promise<HtmlOutput>((resolve, reject) => {
    const finish = (result?: HtmlOutput, error?: unknown) => {
      if (controller.signal.aborted) return
      controller.abort()
      worker.terminate()
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      input.signal.removeEventListener("abort", abort)
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      if (result) resolve(result)
    }
    const abort = () => finish(undefined, input.signal.reason ?? new DOMException("Aborted", "AbortError"))
    const timer = setTimeout(
      () => finish(undefined, new DOMException("HTML preview timed out", "TimeoutError")),
      45_000,
    )
    const send = (message: HtmlRequest, transfer: Transferable[] = []) => {
      if (controller.signal.aborted) return
      try {
        worker.postMessage(message, transfer)
      } catch (error) {
        finish(undefined, error)
      }
    }
    worker.onmessage = (event: MessageEvent<HtmlResponse>) => {
      const message = event.data
      if (message.type === "done") return finish(message.result)
      if (message.type === "error") return finish(undefined, new Error(message.message))
      const task = Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        const draft = /\.css$/i.test(message.path) ? input.draft?.(message.path) : undefined
        if (draft !== undefined) return { data: new TextEncoder().encode(draft).buffer, mime: "text/css" }
        return input.read(message.path, controller.signal)
      })
      void task.then(
        (file) => send({ type: "resource", id: message.id, ...file }, [file.data]),
        (error: unknown) =>
          send({ type: "failure", id: message.id, message: error instanceof Error ? error.message : String(error) }),
      )
    }
    worker.onerror = (event) => {
      event.preventDefault()
      finish(undefined, new Error(event.message || "HTML preview worker failed"))
    }
    worker.onmessageerror = () => finish(undefined, new Error("HTML preview worker returned an invalid response"))
    input.signal.addEventListener("abort", abort, { once: true })
    if (input.signal.aborted) return abort()
    send({ type: "render", path: input.path, source: input.source })
  })
}
