// A per-request input byte budget, not a measured memory/performance boundary.
export const budget = 64 * 1024 * 1024

export async function read(response: Response, signal: AbortSignal, limit = budget) {
  signal.throwIfAborted()
  if (Number(response.headers.get("Content-Length")) > limit) {
    await response.body?.cancel()
    throw new DOMException("Preview exceeds the 64 MiB input budget", "QuotaExceededError")
  }
  if (!response.body) return new ArrayBuffer(0)
  const reader = response.body.getReader()
  const abort = () => {
    // Cancelling resolves an outstanding read even when the source has stopped
    // producing chunks. Checking the signal only between reads cannot do that.
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener("abort", abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new DOMException("Preview exceeds the 64 MiB input budget", "QuotaExceededError")
      }
      chunks.push(chunk.value)
    }
    signal.throwIfAborted()
    const result = new Uint8Array(size)
    let offset = 0
    chunks.forEach((chunk) => {
      result.set(chunk, offset)
      offset += chunk.byteLength
    })
    return result.buffer
  } finally {
    signal.removeEventListener("abort", abort)
    if (signal.aborted) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
