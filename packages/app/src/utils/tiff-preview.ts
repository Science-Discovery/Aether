import type { decodeTiff as decode } from "./tiff"

export type TiffResult = Awaited<ReturnType<typeof decode>>
export type TiffReply = { result: TiffResult } | { error: { name: string; message: string } }

/** Transfer the input to an isolated decoder that can be stopped even if it hangs. */
export function decodeTiff(input: ArrayBuffer, signal?: AbortSignal): Promise<TiffResult> {
  if (signal?.aborted) return Promise.reject(new DOMException("TIFF preview cancelled", "AbortError"))
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./tiff-worker.ts", import.meta.url), { type: "module" })
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      complete()
    }
    const cancel = () => finish(() => reject(new DOMException("TIFF preview cancelled", "AbortError")))
    const timer = setTimeout(
      () => finish(() => reject(new DOMException("TIFF preview timed out", "TimeoutError"))),
      5000,
    )
    worker.onmessage = (event: MessageEvent<TiffReply>) => {
      const reply = event.data
      finish(() => {
        if (
          reply &&
          typeof reply === "object" &&
          "result" in reply &&
          reply.result?.data instanceof Uint8ClampedArray
        ) {
          resolve(reply.result)
          return
        }
        if (reply && typeof reply === "object" && "error" in reply && typeof reply.error?.message === "string") {
          reject(
            reply.error.name === "RangeError" ? new RangeError(reply.error.message) : new Error(reply.error.message),
          )
          return
        }
        reject(new Error("Invalid TIFF worker response"))
      })
    }
    worker.onerror = (event) => {
      event.preventDefault()
      finish(() => reject(new Error(event.message || "TIFF worker failed")))
    }
    worker.onmessageerror = () => finish(() => reject(new Error("TIFF worker response could not be read")))
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) {
      cancel()
      return
    }
    try {
      worker.postMessage(input, [input])
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error("TIFF worker failed", { cause: error })))
    }
  })
}
