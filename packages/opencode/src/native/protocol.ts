import launch from "cross-spawn"
import { StringDecoder } from "node:string_decoder"
import { Shell } from "@/shell/shell"
import z from "zod"

/** Codex app-server uses newline-delimited JSON, without an LSP header. */
export namespace Protocol {
  const limit = 8 * 1024 * 1024
  const envelope = z.object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string() }).optional(),
  })

  export class RpcError extends Error {
    constructor(
      readonly code: number,
      message: string,
    ) {
      super(message)
      this.name = "NativeRpcError"
    }
  }

  function encode(value: unknown, reserve = 0) {
    const text = JSON.stringify(value) + "\n"
    if (Buffer.byteLength(text) + reserve > limit) throw new Error("Codex request exceeds the transport buffer limit")
    return text
  }

  /** Validate before persisting a dispatch cursor; reserve the largest request id. */
  export function check(method: string, params: unknown, reserve = 0) {
    encode({ id: Number.MAX_SAFE_INTEGER, method, params }, reserve)
  }

  export interface Options {
    executable: string
    args?: string[]
    cwd?: string
    signal?: AbortSignal
    onNotification?: (method: string, params: unknown) => void | Promise<void>
    onRequest?: (method: string, params: unknown, signal: AbortSignal) => unknown | Promise<unknown>
  }

  export interface Client {
    request<T = unknown>(
      method: string,
      params?: unknown,
      opts?: { signal?: AbortSignal; timeout?: number },
    ): Promise<T>
    notify(method: string, params?: unknown): Promise<void>
    close(): Promise<void>
    drain(): Promise<void>
    exited: Promise<number | null>
  }

  export function connect(opts: Options): Client {
    opts.signal?.throwIfAborted()
    const child = launch(opts.executable, opts.args ?? ["app-server"], {
      cwd: opts.cwd,
      stdio: "pipe",
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    const decoder = new StringDecoder("utf8")
    const controller = new AbortController()
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
    const incoming = new Map<string | number, { abort: AbortController; thread?: string }>()
    const completion = Promise.withResolvers<number | null>()
    let sequence = 0
    let buffer = ""
    let ended = false
    let discarded = false
    let queued = 0
    let requests = 0
    let failure: Error | undefined
    let closing: Promise<void> | undefined
    let notifications = Promise.resolve()

    function terminate(error: Error) {
      if (failure) return
      failure = error
      controller.abort(error)
      incoming.clear()
      opts.signal?.removeEventListener("abort", abort)
      for (const request of pending.values()) request.reject(error)
      pending.clear()
    }

    function close() {
      discarded = true
      terminate(new Error("Codex connection closed"))
      return (closing ??= (async () => {
        const timeout = Promise.withResolvers<void>()
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          timeout.reject(new Error("Timed out stopping Codex app-server"))
        }, 5_000)
        // Kill the process group before closing stdin: wrappers can otherwise
        // exit first and leave their children running with the session lock.
        await Promise.race([
          (async () => {
            if (!ended) {
              await Shell.killTree(child, { exited: () => ended })
              // A restricted host may refuse the platform process-tree helper.
              // Still terminate our direct child rather than leave it running.
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
            }
            child.stdin?.destroy()
            child.stdout?.destroy()
            child.stderr?.destroy()
            await completion.promise
          })(),
          timeout.promise,
        ]).finally(() => {
          clearTimeout(timer)
          child.stdin?.destroy()
          child.stdout?.destroy()
          child.stderr?.destroy()
        })
      })())
    }

    function fail(error: Error) {
      terminate(error)
      void close().catch(() => undefined)
    }

    function abort() {
      fail(new Error("Codex connection aborted"))
    }

    async function send(value: unknown): Promise<void> {
      if (failure) return Promise.reject(failure)
      const input = child.stdin
      if (!input || input.destroyed) return Promise.reject(new Error("Codex input is unavailable"))
      const text = encode(value)
      if (Buffer.byteLength(text) + input.writableLength > limit) {
        return Promise.reject(new Error("Codex request exceeds the transport buffer limit"))
      }
      return new Promise<void>((resolve, reject) => {
        input.write(text, (error) => {
          if (!error) return resolve()
          reject(new Error("Unable to write to Codex"))
          fail(new Error("Codex input closed"))
        })
      })
    }

    function receive(line: string) {
      const parsed = envelope.safeParse(JSON.parse(line))
      if (!parsed.success) throw new Error("Codex sent an invalid protocol message")
      const message = parsed.data
      if (message.method !== undefined) {
        if (message.id !== undefined) {
          if (++requests > 64) throw new Error("Too many pending Codex client requests")
          if (incoming.has(message.id)) throw new Error("Codex repeated an active client request id")
          const scope = z.object({ threadId: z.string() }).safeParse(message.params)
          const request = { abort: new AbortController(), thread: scope.success ? scope.data.threadId : undefined }
          const signal = AbortSignal.any([controller.signal, request.abort.signal])
          incoming.set(message.id, request)
          // Do not await interactive requests in the stdout reader: approvals
          // can remain open while the server sends other events or responses.
          void Promise.resolve()
            .then(() => {
              if (failure) throw failure
              signal.throwIfAborted()
              if (!opts.onRequest) throw new RpcError(-32601, "Unsupported client request")
              return opts.onRequest(message.method!, message.params, signal)
            })
            .then(
              (result) => (signal.aborted ? undefined : send({ id: message.id, result: result ?? null })),
              (error: unknown) =>
                signal.aborted
                  ? undefined
                  : send({
                      id: message.id,
                      error: {
                        code: error instanceof RpcError ? error.code : -32603,
                        message: error instanceof RpcError ? error.message : "Client request failed",
                      },
                    }),
            )
            .catch(() => undefined)
            .finally(() => {
              if (incoming.get(message.id!) === request) incoming.delete(message.id!)
              requests--
            })
          return
        }
        if (message.method === "serverRequest/resolved") {
          const resolved = z
            .object({ threadId: z.string(), requestId: z.union([z.string(), z.number()]) })
            .safeParse(message.params)
          if (resolved.success) {
            const request = incoming.get(resolved.data.requestId)
            if (request?.thread === resolved.data.threadId) {
              incoming.delete(resolved.data.requestId)
              request.abort.abort(new Error("Codex withdrew the client request"))
            }
          }
        }
        const size = Buffer.byteLength(line)
        queued += size
        if (queued > limit * 2) throw new Error("Codex notification queue exceeds the transport buffer limit")
        notifications = notifications
          .then(() => {
            if (!discarded) return opts.onNotification?.(message.method!, message.params)
          })
          .catch(() => fail(new Error("Unable to process a Codex notification")))
          .finally(() => {
            queued -= size
          })
        return
      }
      if (typeof message.id !== "number") return
      const request = pending.get(message.id)
      if (!request) return
      if (message.error) {
        request.reject(new RpcError(message.error.code, message.error.message))
        return
      }
      if (!Object.hasOwn(message, "result")) {
        request.reject(new Error("Codex response has no result"))
        return
      }
      request.resolve(message.result)
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return
      buffer += decoder.write(chunk)
      try {
        let end = buffer.indexOf("\n")
        while (end !== -1) {
          if (Buffer.byteLength(buffer.slice(0, end)) > limit)
            throw new Error("Codex response exceeds the transport buffer limit")
          const line = buffer.slice(0, end).trim()
          buffer = buffer.slice(end + 1)
          if (line) receive(line)
          end = buffer.indexOf("\n")
        }
        if (Buffer.byteLength(buffer) > limit) throw new Error("Codex response exceeds the transport buffer limit")
      } catch {
        // Neither raw stdout nor stderr belongs in a UI error: agent output
        // can contain credentials and private document contents.
        fail(new Error("Codex sent an invalid or oversized protocol message"))
      }
    })
    // Drain diagnostics without retaining potentially sensitive server output.
    child.stderr?.resume()
    child.stdin?.on("error", () => fail(new Error("Codex input closed")))
    child.once("error", () => fail(new Error("Unable to start Codex app-server")))
    child.once("close", (code) => {
      ended = true
      terminate(new Error(`Codex app-server exited${code === null ? "" : ` (${code})`}`))
      completion.resolve(code)
    })
    opts.signal?.addEventListener("abort", abort, { once: true })
    if (opts.signal?.aborted) abort()

    return {
      request<T = unknown>(method: string, params?: unknown, options?: { signal?: AbortSignal; timeout?: number }) {
        if (failure) return Promise.reject<T>(failure)
        if (pending.size >= 128) return Promise.reject<T>(new Error("Too many pending Codex requests"))
        if (options?.signal?.aborted) return Promise.reject<T>(new Error("Codex request aborted"))
        const id = ++sequence
        return new Promise<T>((resolve, reject) => {
          const finish = (error?: Error, result?: unknown) => {
            if (!pending.delete(id)) return
            clearTimeout(timer)
            options?.signal?.removeEventListener("abort", cancel)
            if (error) reject(error)
            else resolve(result as T)
          }
          const cancel = () => finish(new Error("Codex request aborted"))
          const timer = setTimeout(
            () => finish(new Error(`Codex request timed out: ${method}`)),
            options?.timeout ?? 30_000,
          )
          pending.set(id, {
            resolve: (value) => finish(undefined, value),
            reject: (error) => finish(error),
          })
          options?.signal?.addEventListener("abort", cancel, { once: true })
          if (options?.signal?.aborted) cancel()
          void send({ id, method, ...(params === undefined ? {} : { params }) }).catch((error: unknown) => {
            finish(error instanceof Error ? error : new Error("Unable to send Codex request"))
          })
        })
      },
      notify: (method, params) => send({ method, ...(params === undefined ? {} : { params }) }),
      close,
      drain: () => notifications,
      exited: completion.promise,
    }
  }
}
