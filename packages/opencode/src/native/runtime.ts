import { registerDisposer } from "@/effect/instance-registry"
import { Codex } from "./codex"
import { Protocol } from "./protocol"

/** A connection is owned by one Aether session, never shared between conversations. */
export namespace NativeRuntime {
  type Settings = { path?: string; enabled?: boolean; limit?: number }
  type Options = Pick<Protocol.Options, "args" | "onNotification" | "onRequest" | "signal"> & {
    id: string
    directory: string
  }
  type Entry = {
    id: string
    directory: string
    path?: string
    home?: string
    active: boolean
    retain: boolean
    order: number
    thread?: string
    timer?: ReturnType<typeof setTimeout>
    client?: Protocol.Client
    opening?: ReturnType<typeof Codex.connect>
    closing?: Promise<void>
    abort: AbortController
    retired: Set<string>
  }

  export function create(opts: { idle?: number } = {}) {
    const entries = new Map<string, Entry>()
    let config: Settings = {}
    const enabled = () => config.enabled !== false
    let sequence = 0
    let generation = 0

    function close(entry: Entry) {
      if (entry.closing) return entry.closing
      entry.retain = false
      clearTimeout(entry.timer)
      entry.abort.abort()
      return (entry.closing = (async () => {
        const client = entry.client ?? (await entry.opening?.catch(() => undefined))?.client
        await client?.close()
      })().finally(() => {
        if (entries.get(entry.id) === entry) entries.delete(entry.id)
      }))
    }

    async function trim() {
      const idle = [...entries.values()].filter((entry) => !entry.active).sort((a, b) => b.order - a.order)
      await Promise.all(
        idle
          .filter((entry, index) => !entry.retain || config.enabled === false || index >= (config.limit ?? 4))
          .map(close),
      )
    }

    async function configure(value: Settings = {}, expected?: number) {
      // An async configuration read must not undo a newer settings update.
      if (expected !== undefined && expected !== generation) return
      generation++
      const changed = config.path !== value.path || value.enabled === false
      config = { ...value }
      if (changed) entries.forEach((entry) => (entry.retain = false))
      await trim()
    }

    // Keep long-lived process/timer callbacks outside a lease's lexical scope:
    // retaining that scope would also retain its assistant, tree and input.
    function watch(entry: Entry) {
      entry.client!.onExit(() => void close(entry).catch(() => undefined))
    }

    function idle(entry: Entry) {
      entry.timer = setTimeout(() => void close(entry).catch(() => undefined), opts.idle ?? 30 * 60_000)
      entry.timer.unref()
    }

    async function acquire(input: Options) {
      input.signal?.throwIfAborted()
      if (!enabled()) throw new Error("The native Codex backend is disabled in Aether settings.")
      const previous = entries.get(input.id)
      if (previous?.active) throw new Error("This Codex session already has an active turn.")
      if (previous && (previous.directory !== input.directory || !previous.retain || previous.client?.closed))
        await close(previous)
      input.signal?.throwIfAborted()
      if (!enabled()) throw new Error("The native Codex backend is disabled in Aether settings.")
      if (entries.get(input.id)?.active) throw new Error("This Codex session already has an active turn.")
      const entry: Entry = entries.get(input.id) ?? {
        id: input.id,
        directory: input.directory,
        path: config.path,
        active: false,
        retain: true,
        order: 0,
        abort: new AbortController(),
        retired: new Set<string>(),
      }
      // Reserve before opening: concurrent callers cannot initialize two engines for one session.
      entry.active = true
      clearTimeout(entry.timer)
      entries.set(input.id, entry)
      const abort = new AbortController()
      const signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal
      const completed = new Set<string>()
      const key = (value: unknown) => {
        if (!value || typeof value !== "object") return
        const data = value as Record<string, unknown>
        const turn =
          data.turn && typeof data.turn === "object" ? (data.turn as Record<string, unknown>).id : data.turnId
        if (typeof data.threadId !== "string" || typeof turn !== "string") return
        return JSON.stringify([data.threadId, turn])
      }
      const handlers: Pick<Protocol.Options, "onNotification" | "onRequest"> = {
        onNotification: (method, value) => {
          if (signal.aborted) return
          const turn = key(value)
          if (turn && entry.retired.has(turn)) return
          if (turn && method === "turn/completed") completed.add(turn)
          return input.onNotification?.(method, value)
        },
        onRequest: (method, value, cancelled) => {
          signal.throwIfAborted()
          const turn = key(value)
          if (turn && entry.retired.has(turn)) throw new Protocol.RpcError(-32602, "The Codex turn has ended.")
          if (!input.onRequest) throw new Protocol.RpcError(-32601, "Unsupported client request")
          return input.onRequest(method, value, AbortSignal.any([signal, cancelled]))
        },
      }
      const cancel = () => void close(entry).catch(() => undefined)
      input.signal?.addEventListener("abort", cancel, { once: true })
      try {
        if (!entry.client) {
          entry.opening = Codex.connect({
            executable: entry.path,
            args: input.args,
            cwd: entry.directory,
            signal: entry.abort.signal,
            ...handlers,
          })
          const opened = await entry.opening
          entry.client = opened.client
          entry.home = opened.home
          watch(entry)
        }
        signal.throwIfAborted()
        if (entry.client.closed || entry.closing) throw new Error("The Codex connection closed before the turn began.")
        entry.client.listen(handlers)
        let released = false
        return {
          client: entry.client,
          thread: entry.thread,
          home: entry.home,
          bind(thread: string) {
            if (entry.thread && entry.thread !== thread)
              throw new Error("The native connection belongs to another thread.")
            entry.thread = thread
          },
          async release(success: boolean) {
            if (released) return
            released = true
            entry.client!.listen({})
            abort.abort()
            await entry.client!.drain()
            completed.forEach((turn) => entry.retired.add(turn))
            entry.active = false
            entry.order = ++sequence
            if (!success || input.signal?.aborted || entry.client!.closed || entry.client!.busy) return close(entry)
            if (!entry.retain || config.enabled === false || (config.limit ?? 4) === 0) return close(entry)
            // Bound bookkeeping as well as child process retention.
            if (entry.retired.size > 4096) return close(entry)
            idle(entry)
            await trim()
          },
        }
      } catch (error) {
        await close(entry)
        throw error
      } finally {
        input.signal?.removeEventListener("abort", cancel)
      }
    }

    async function remove(id: string) {
      const entry = entries.get(id)
      if (!entry) return
      entry.retain = false
      if (!entry.active) await close(entry)
    }

    async function handoff(
      id: string,
      check?: (entry: { client: Protocol.Client; thread?: string; directory: string; home?: string }) => Promise<void>,
    ) {
      const entry = entries.get(id)
      if (!entry) return false
      if (entry.active) throw new Error("Wait for the Codex task to finish before releasing this chat.")
      if (check && entry.client) await check({ ...entry, client: entry.client })
      if (entries.get(id) !== entry || entry.active)
        throw new Error("This Codex connection changed. Refresh the chat before releasing it.")
      await close(entry)
      return true
    }

    async function refresh(input: { directory: string; home: string }) {
      const results = await Promise.all(
        [...entries.values()]
          .filter(
            (entry) =>
              entry.directory === input.directory &&
              entry.home === input.home &&
              entry.client &&
              !entry.client.closed &&
              !entry.closing,
          )
          .map(async (entry) => {
            // The native server queues MCP reloads for loaded threads. Do not
            // close apparently idle processes: native goals can still be live.
            const client = entry.client!
            const accepted = await client.request("config/mcpServer/reload", null, { timeout: 10_000 }).then(
              () => true,
              () => false,
            )
            return accepted || entries.get(entry.id) !== entry || client.closed || !!entry.closing
          }),
      )
      return results.every(Boolean)
    }

    async function inspect<T>(
      input: { id: string; directory: string; thread: string; home: string },
      read: (client: Protocol.Client) => Promise<T>,
    ): Promise<T | undefined> {
      const entry = entries.get(input.id)
      const valid = () =>
        enabled() &&
        entry !== undefined &&
        entries.get(input.id) === entry &&
        entry.directory === input.directory &&
        entry.thread === input.thread &&
        entry.home === input.home &&
        entry.retain &&
        !entry.closing &&
        entry.client !== undefined &&
        !entry.client.closed
      if (!valid() || !entry?.client) return
      // Queries must not acquire a writer, replace turn handlers or extend the idle lease.
      try {
        const result = await read(entry.client)
        if (valid()) return result
      } catch (error) {
        if (valid()) throw error
      }
    }

    async function dispose(directory?: string) {
      await Promise.all(
        [...entries.values()].filter((entry) => directory === undefined || entry.directory === directory).map(close),
      )
    }

    return { acquire, configure, remove, handoff, refresh, inspect, dispose, revision: () => generation }
  }

  const pool = create()
  export const acquire = pool.acquire
  export const configure = pool.configure
  export const remove = pool.remove
  export const handoff = pool.handoff
  export const refresh = pool.refresh
  export const inspect = pool.inspect
  export const dispose = pool.dispose
  export const revision = pool.revision
  registerDisposer(dispose)
}
