import type { NamedError } from "@opencode-ai/util/error"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
  export const TIMEOUT_RETRY_INITIAL_DELAY = 30_000 // 30 seconds for timeout retries
  export const TIMEOUT_RETRY_MAX_DELAY = 120_000 // 120 seconds cap for timeout retries

  // Long-window retry for upstream connection-class failures: sustained
  // retries for the first hour, then hourly, giving up after 10 days.
  export const WINDOW_HIGH = 60 * 60 * 1000
  export const WINDOW_TOTAL = 10 * 24 * 60 * 60 * 1000
  export const LONG_INITIAL_DELAY = 60_000
  export const LONG_HOURLY_DELAY = 60 * 60 * 1000

  const BILLING =
    /insufficient_quota|insufficient (credit|balance|funds)|credit balance is too low|quota.{0,20}exceed|exceed.{0,20}quota|billing (hard )?limit|FreeUsageLimitError|out of credits|欠费|余额不足/i

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", abortHandler)
          resolve()
        },
        Math.min(ms, RETRY_MAX_DELAY),
      )
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    const kind = error?.data.metadata?.kind
    const slow = kind === "timeout" || kind === "conn"
    const base = slow ? TIMEOUT_RETRY_INITIAL_DELAY : RETRY_INITIAL_DELAY
    const cap = slow ? TIMEOUT_RETRY_MAX_DELAY : RETRY_MAX_DELAY_NO_HEADERS
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return parsedMs
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return Math.ceil(parsedSeconds * 1000)
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return Math.ceil(parsed)
          }
        }

        return Math.min(base * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), cap)
      }
    }

    return Math.min(base * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), cap)
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    // context overflow errors should not be retried
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return undefined
      if (error.data.responseBody?.includes("FreeUsageLimitError"))
        return `Free usage exceeded, add credits https://opencode.ai/zen`
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    const text = typeof error.data?.message === "string" ? error.data.message : ""
    if (/certificate verification error|socket hang up|connection (refused|reset|closed)|fetch failed/i.test(text)) {
      return "Connection error"
    }

    const json = iife(() => {
      try {
        if (typeof error.data?.message === "string") {
          const parsed = JSON.parse(error.data.message)
          return parsed
        }

        return JSON.parse(error.data.message)
      } catch {
        return undefined
      }
    })
    try {
      if (!json || typeof json !== "object") return undefined
      const code = typeof json.code === "string" ? json.code : ""

      if (json.type === "error" && json.error?.type === "too_many_requests") {
        return "Too Many Requests"
      }
      if (code.includes("exhausted") || code.includes("unavailable")) {
        return "Provider is overloaded"
      }
      if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
        return "Rate Limited"
      }
      return JSON.stringify(json)
    } catch {
      return undefined
    }
  }

  export function deadline(started: number) {
    return started + WINDOW_TOTAL
  }

  export function expired(started: number, now = Date.now()) {
    return now >= deadline(started)
  }

  export function longDelay(elapsed: number) {
    return elapsed < WINDOW_HIGH ? LONG_INITIAL_DELAY : LONG_HOURLY_DELAY
  }

  export function connection(error: ReturnType<NamedError["toObject"]>) {
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    if (MessageV2.AbortedError.isInstance(error)) return undefined
    const api = MessageV2.APIError.isInstance(error) ? error : undefined
    const text = [error.data?.message, api?.data.responseBody]
      .filter((item): item is string => typeof item === "string")
      .join("\n")
    if (BILLING.test(text)) return "Upstream billing or quota limit reached"
    if (!api) {
      const fallback = retryable(error)
      // retryable()'s JSON catch-all returns truthy for arbitrary unknown
      // errors; only its specific transient signals justify a 10-day park.
      if (fallback === undefined || fallback.startsWith("{")) return undefined
      return fallback
    }
    const status = api.data.statusCode
    if (status !== undefined && (status === 402 || status === 408 || status === 429 || status >= 500)) {
      return api.data.message
    }
    // 4xx mislabeled as retryable by the provider (e.g. the OpenAI 404 quirk)
    // is a request/class error that does not self-heal; the short in-loop
    // retries already covered the transient part.
    if (status !== undefined && status >= 400) return undefined
    if (!api.data.isRetryable) return undefined
    return api.data.message
  }
}
