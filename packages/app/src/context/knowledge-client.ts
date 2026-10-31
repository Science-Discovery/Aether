export function createKnowledgeClient(input: {
  url: () => string
  auth: () => Record<string, string>
  enabled: () => boolean
  disabled: () => string
  fetch?: (url: string, options: RequestInit) => Promise<Response>
}) {
  const requests = new Map<AbortController, boolean>()
  let version = 0

  const reset = (work = false) => {
    if (!work) version += 1
    for (const [abort, active] of requests) {
      if (work && !active) continue
      abort.abort()
      requests.delete(abort)
    }
  }

  const open = async (path: string, options: RequestInit = {}, work = true) => {
    if (work && !input.enabled()) throw new Error(input.disabled())
    const url = input.url()
    const serial = version
    const abort = new AbortController()
    const cancel = () => abort.abort()
    const close = () => {
      options.signal?.removeEventListener("abort", cancel)
      requests.delete(abort)
    }
    const check = () => {
      if (abort.signal.aborted || serial !== version || url !== input.url()) {
        throw new DOMException("The request was cancelled", "AbortError")
      }
      if (work && !input.enabled()) throw new Error(input.disabled())
    }
    options.signal?.addEventListener("abort", cancel, { once: true })
    if (options.signal?.aborted) cancel()
    requests.set(abort, work)
    try {
      const headers = new Headers({ "Content-Type": "application/json", ...input.auth() })
      new Headers(options.headers).forEach((value, key) => headers.set(key, value))
      const response = await (input.fetch ?? fetch)(`${url}${path}`, {
        ...options,
        headers,
        signal: abort.signal,
      })
      check()
      if (!response.ok) {
        const text = await response.text()
        check()
        throw new Error(text || `Knowledge request failed (${response.status})`)
      }
      return { response, signal: abort.signal, check, close }
    } catch (error) {
      close()
      throw error
    }
  }

  const request = async <T>(path: string, options: RequestInit = {}, work = true) => {
    const pending = await open(path, options, work)
    try {
      const data = (await pending.response.json()) as T
      pending.check()
      return data
    } finally {
      pending.close()
    }
  }

  return { open, request, reset }
}
