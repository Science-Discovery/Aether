import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSdkForServer } from "@/utils/server"
import type { ServerConnection } from "@/context/server"

type SSEvent = { directory?: string; payload: Event }

type Msg = { kind: "event"; data: SSEvent } | { kind: "heartbeat"; id: string } | { kind: "claim"; id: string }

type Opts = {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
  signal: AbortSignal
  onSseError?: (error: unknown) => void
}

type Conn = {
  stream: AsyncIterable<SSEvent>
  destroy: () => void
}

const CHANNEL = "aether:sse"
const HB_MS = 2000
const TIMEOUT_MS = 5000

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

export function connectShared(opts: Opts): Conn {
  if (typeof BroadcastChannel === "undefined") return connectDirect(opts)

  const ch = new BroadcastChannel(CHANNEL)
  const id = uid()
  let dead = false
  let wake: (() => void) | undefined

  const destroy = () => {
    dead = true
    ch.close()
    wake?.()
  }

  opts.signal.addEventListener("abort", destroy, { once: true })

  const notify = () => wake?.()

  async function* run(): AsyncGenerator<SSEvent> {
    if (dead || opts.signal.aborted) return

    ch.postMessage({ kind: "claim", id } satisfies Msg)
    await sleep(500)
    if (dead) return

    let isLeader = true
    const detect = (e: MessageEvent<Msg>) => {
      if (e.data.kind === "heartbeat" && e.data.id !== id) isLeader = false
    }
    ch.addEventListener("message", detect)
    await sleep(500)
    ch.removeEventListener("message", detect)
    if (dead) return

    if (isLeader) {
      const hb = setInterval(() => ch.postMessage({ kind: "heartbeat", id } satisfies Msg), HB_MS)
      try {
        const sdk = createSdkForServer({ server: opts.server, fetch: opts.fetch, signal: opts.signal })
        const result = await sdk.global.event({ signal: opts.signal, onSseError: opts.onSseError })
        for await (const ev of result.stream) {
          if (dead) return
          ch.postMessage({ kind: "event", data: ev as SSEvent } satisfies Msg)
          yield ev as SSEvent
        }
      } finally {
        clearInterval(hb)
      }
    } else {
      const q: SSEvent[] = []
      let timer: ReturnType<typeof setTimeout> | undefined

      const resetTimer = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(notify, TIMEOUT_MS)
      }

      const onMsg = (e: MessageEvent<Msg>) => {
        const msg = e.data
        if (msg.kind === "event") {
          q.push(msg.data)
          notify()
        } else if (msg.kind === "heartbeat") {
          resetTimer()
        }
      }
      ch.addEventListener("message", onMsg)
      resetTimer()

      try {
        while (!dead) {
          if (q.length > 0) {
            yield q.shift()!
            continue
          }
          await new Promise<void>((r) => (wake = r))
          wake = undefined
        }
      } finally {
        if (timer) clearTimeout(timer)
        ch.removeEventListener("message", onMsg)
      }
    }
  }

  return { stream: { [Symbol.asyncIterator]: run }, destroy }
}

function connectDirect(opts: Opts): Conn {
  let ctrl: AbortController | undefined
  return {
    stream: {
      async *[Symbol.asyncIterator]() {
        ctrl = new AbortController()
        const link = new AbortController()
        opts.signal.addEventListener("abort", () => link.abort(), { once: true })
        const sdk = createSdkForServer({ server: opts.server, fetch: opts.fetch, signal: link.signal })
        const result = await sdk.global.event({ signal: link.signal, onSseError: opts.onSseError })
        for await (const ev of result.stream) yield ev as SSEvent
      },
    },
    destroy() {
      ctrl?.abort()
    },
  }
}
