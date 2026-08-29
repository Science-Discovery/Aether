import { Cause, Effect, Layer, ServiceMap } from "effect"
import { createInterface } from "readline"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { existsSync } from "fs"
import { readdir } from "fs/promises"
import path from "path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Flag } from "@/flag/flag"
import { Git } from "@/git"
import { Installation } from "@/installation"
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { Config } from "../config/config"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import { Process } from "../util/process"
import { Log } from "../util/log"

declare const OPENCODE_LIBC: string | undefined

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })
  const SUBSCRIBE_TIMEOUT_MS = 10_000
  const SUBPROCESS_KILL_TIMEOUT_MS = 500
  const sidecarDir = new URL("../../../go-watcher/bin/", import.meta.url)

  export const Event = {
    Updated: BusEvent.define(
      "file.watcher.updated",
      z.object({
        file: z.string(),
        event: z.union([z.literal("add"), z.literal("change"), z.literal("unlink")]),
      }),
    ),
    Limited: BusEvent.define(
      "file.watcher.limited",
      z.object({
        dir: z.string(),
        reason: z.enum(["limit", "timeout", "error"]),
      }),
    ),
    NotFound: BusEvent.define(
      "file.watcher.notfound",
      z.object({
        dir: z.string(),
      }),
    ),
  }

  function libc() {
    if (process.platform !== "linux") return
    if (process.env.OPENCODE_LIBC) return process.env.OPENCODE_LIBC
    if (typeof OPENCODE_LIBC !== "undefined" && OPENCODE_LIBC) return OPENCODE_LIBC
    const report = process.report?.getReport?.()
    const header =
      typeof report === "object" && report && "header" in report && typeof report.header === "object" && report.header
        ? report.header
        : undefined
    return typeof header === "object" &&
      header &&
      "glibcVersionRuntime" in header &&
      typeof header.glibcVersionRuntime === "string"
      ? "glibc"
      : "musl"
  }

  function binding() {
    if (process.platform === "darwin" && process.arch === "arm64") return require("@parcel/watcher-darwin-arm64")
    if (process.platform === "darwin" && process.arch === "x64") return require("@parcel/watcher-darwin-x64")
    if (process.platform === "linux" && process.arch === "arm64" && libc() === "glibc")
      return require("@parcel/watcher-linux-arm64-glibc")
    if (process.platform === "linux" && process.arch === "arm64" && libc() === "musl")
      return require("@parcel/watcher-linux-arm64-musl")
    if (process.platform === "linux" && process.arch === "x64" && libc() === "glibc")
      return require("@parcel/watcher-linux-x64-glibc")
    if (process.platform === "linux" && process.arch === "x64" && libc() === "musl")
      return require("@parcel/watcher-linux-x64-musl")
    if (process.platform === "win32" && process.arch === "arm64") return require("@parcel/watcher-win32-arm64")
    if (process.platform === "win32" && process.arch === "x64") return require("@parcel/watcher-win32-x64")
  }

  const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
    const abi = libc()
    const name = `@parcel/watcher-${process.platform}-${process.arch}${abi ? `-${abi}` : ""}`
    try {
      const value = binding()
      if (!value) return require("@parcel/watcher") as typeof import("@parcel/watcher")
      return createWrapper(value) as typeof import("@parcel/watcher")
    } catch (error) {
      try {
        return require("@parcel/watcher") as typeof import("@parcel/watcher")
      } catch (fallback) {
        log.error("failed to load watcher binding", {
          error,
          fallback,
          name,
        })
        return
      }
    }
  })

  function getBackend() {
    if (process.platform === "win32") return "windows"
    if (process.platform === "darwin") return "fs-events"
    if (process.platform === "linux") return "inotify"
  }

  function protecteds(dir: string) {
    return Protected.paths().filter((item) => {
      const rel = path.relative(dir, item)
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
    })
  }

  function warn(input: { dir: string; reason: "limit" | "timeout" | "error" }) {
    log.warn("watcher degraded", {
      dir: input.dir,
      reason: input.reason,
    })
    return Effect.promise(() => Bus.publish(Event.Limited, { dir: input.dir, reason: input.reason })).pipe(
      Effect.catchCause(() => Effect.void),
    )
  }

  function notfound(dir: string) {
    return Effect.promise(() => Bus.publish(Event.NotFound, { dir })).pipe(Effect.catchCause(() => Effect.void))
  }

  function reason(input: unknown): "timeout" | "error" | "notfound" {
    const text = input instanceof Error ? input.message : String(input)
    if (text === "subscribe timeout" || text.includes("TimeoutException")) return "timeout"
    if (text.includes("go watcher binary not found")) return "notfound"
    return "error"
  }

  function sidecar() {
    const env = process.env.OPENCODE_GO_WATCHER_PATH
    if (env && existsSync(env)) return env
    const name = process.platform === "win32" ? "opencode-watcher.exe" : "opencode-watcher"
    if (Installation.isLocal()) {
      const file = Bun.fileURLToPath(new URL(name, sidecarDir))
      if (existsSync(file)) return file
      return
    }
    const file = path.join(path.dirname(process.execPath), "native", name)
    if (existsSync(file)) return file
  }

  function requireSidecar() {
    const file = sidecar()
    if (file) return file
    const name = process.platform === "win32" ? "opencode-watcher.exe" : "opencode-watcher"
    if (Installation.isLocal()) {
      const local = Bun.fileURLToPath(new URL(name, sidecarDir))
      throw new Error(`go watcher binary not found: ${local}`)
    }
    throw new Error(`go watcher binary not found: ${path.join(path.dirname(process.execPath), "native", name)}`)
  }

  export const hasNativeBinding = () => !!watcher()

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly initFull: () => Effect.Effect<void>
    readonly initGit: () => Effect.Effect<void>
    readonly deactivate: () => Effect.Effect<void>
    readonly deactivateFull: () => Effect.Effect<void>
    readonly deactivateAll: () => Effect.Effect<void>
  }

  type Subscription = ParcelWatcher.AsyncSubscription & {
    readonly sync?: (dirs: string[]) => Promise<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/FileWatcher") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const setup = Effect.fn("FileWatcher.setup")(function* () {
        const disabled = yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER

        if (disabled) {
          log.info("watcher disabled by flag", { directory: Instance.directory })
          return
        }

        const backend = getBackend()
        if (!backend) {
          log.error("watcher backend not supported", { directory: Instance.directory, platform: process.platform })
          return
        }

        const w = watcher()
        if (!w && process.platform !== "linux") return

        log.info("watcher backend", { directory: Instance.directory, platform: process.platform, backend })

        const subs = new Set<Subscription>()
        let disposed = false
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            disposed = true
            const results = yield* Effect.promise(() => Promise.allSettled([...subs].map((sub) => sub.unsubscribe())))
            const failed = results.filter((r) => r.status === "rejected")
            if (failed.length > 0) {
              log.error("watcher unsubscribe partially failed", {
                directory: Instance.directory,
                failedCount: failed.length,
                totalCount: subs.size,
                errors: failed.map((r) => String((r as PromiseRejectedResult).reason)),
              })
            } else {
              log.info("watcher unsubscribed", {
                directory: Instance.directory,
                subscriptionCount: subs.size,
              })
            }
          }),
        )

        const cfg = yield* Effect.promise(() => Config.get())
        const cfgIgnores = cfg.watcher?.ignore ?? []
        const keep = protecteds(Instance.directory)
        const sidecarIgnore = FileIgnore.watch(cfgIgnores, keep)
        const sidecarFilter = FileIgnore.event(cfgIgnores, keep)

        const cb: ParcelWatcher.SubscribeCallback = Instance.bind((err, evts) => {
          if (disposed) return
          if (err) {
            log.error("watcher callback error", { directory: Instance.directory, error: err })
            return
          }
          for (const evt of evts) {
            if (evt.type === "create") Bus.publish(Event.Updated, { file: evt.path, event: "add" })
            if (evt.type === "update") Bus.publish(Event.Updated, { file: evt.path, event: "change" })
            if (evt.type === "delete") Bus.publish(Event.Updated, { file: evt.path, event: "unlink" })
          }
        })

        const subscribe = (dir: string, ignore: string[], kind: "worktree" | "git") =>
          Effect.promise(async () => {
            const start = Date.now()
            const watchIgnore = process.platform === "linux" && kind === "worktree" ? sidecarIgnore : ignore
            const useSidecar = !w || (process.platform === "linux" && kind === "worktree")
            const filter = kind === "worktree" ? sidecarFilter : []
            let input:
              | {
                  pending: Promise<Subscription>
                  cancel?: () => void
                }
              | undefined

            try {
              if (!useSidecar && w) {
                input = {
                  pending: w.subscribe(dir, cb, { ignore: watchIgnore, backend }),
                  cancel: () => void w.unsubscribe(dir, cb, { ignore: watchIgnore, backend }).catch(() => undefined),
                }
              } else {
                input = child({ dir, ignore: watchIgnore, filter, backend, cb })
              }

              const pending = input.pending
              const sub = await Promise.race([
                pending,
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("subscribe timeout")), SUBSCRIBE_TIMEOUT_MS),
                ),
              ])
              subs.add(sub)
              log.info("subscribe ready", {
                dir,
                kind,
                backend,
                elapsedMs: Date.now() - start,
                directory: Instance.directory,
                worktree: Instance.project.worktree,
                projectID: Instance.project.id,
              })
              return sub
            } catch (error) {
              const why = reason(error)
              log.error("failed to subscribe", {
                dir,
                kind,
                reason: why,
                backend,
                elapsedMs: Date.now() - start,
                timeoutMs: SUBSCRIBE_TIMEOUT_MS,
                ignoreCount: watchIgnore.length,
                ignorePreview: watchIgnore.slice(0, 20),
                directory: Instance.directory,
                worktree: Instance.project.worktree,
                projectID: Instance.project.id,
                cause: error instanceof Error ? error.stack ?? error.message : error,
              })
              input?.cancel?.()
              input?.pending.then((sub) => sub.unsubscribe()).catch(() => {})
              if (kind === "worktree" && process.platform === "linux") {
                await Effect.runPromise(why === "notfound" ? notfound(dir) : warn({ dir, reason: why }))
              }
            }
          })

        return {
          backend,
          subscribe,
        }
      })

      const full = yield* InstanceState.make(
        Effect.fn("FileWatcher.full")(
          function* () {
            const disabled = yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
            const enabled = yield* Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER

            if (disabled) {
              log.info("watcher disabled by flag", { directory: Instance.directory })
              return
            }

            log.info("init", { directory: Instance.directory })

            const state = yield* setup()
            if (!state) return

            const cfg = yield* Effect.promise(() => Config.get())
            const ignore = [...FileIgnore.PATTERNS, ...(cfg.watcher?.ignore ?? []), ...protecteds(Instance.directory)]

            if (enabled) {
              yield* state.subscribe(Instance.directory, ignore, "worktree")
            }
            if (!enabled) {
              log.info("worktree watcher disabled", { directory: Instance.directory })
            }
          },
          Effect.catchCause((cause) => {
            log.error("failed to init full watcher service", { cause: Cause.pretty(cause) })
            return Effect.void
          }),
        ),
      )

      const git = yield* InstanceState.make(
        Effect.fn("FileWatcher.git")(
          function* () {
            if (Instance.project.vcs === "git") {
              const state = yield* setup()
              if (!state) return

              const result = yield* Effect.promise(() =>
                Git.run(["rev-parse", "--git-dir"], {
                  cwd: Instance.project.worktree,
                }),
              )
              const vcsDir =
                result.exitCode === 0 ? path.resolve(Instance.project.worktree, result.text().trim()) : undefined
              if (vcsDir) {
                const ignore = (yield* Effect.promise(() => readdir(vcsDir).catch(() => []))).filter(
                  (entry) => entry !== "HEAD",
                )
                yield* state.subscribe(vcsDir, ignore, "git")
              }
            }
          },
          Effect.catchCause((cause) => {
            log.error("failed to init git watcher service", { cause: Cause.pretty(cause) })
            return Effect.void
          }),
        ),
      )

      return Service.of({
        init: Effect.fn("FileWatcher.init")(function* () {
          yield* InstanceState.get(full)
          yield* InstanceState.get(git)
        }),
        initFull: Effect.fn("FileWatcher.initFull")(function* () {
          yield* InstanceState.get(full)
        }),
        initGit: Effect.fn("FileWatcher.initGit")(function* () {
          yield* InstanceState.get(git)
        }),
        deactivate: Effect.fn("FileWatcher.deactivate")(function* () {
          yield* InstanceState.invalidate(full)
          yield* InstanceState.invalidate(git)
        }),
        deactivateFull: Effect.fn("FileWatcher.deactivateFull")(function* () {
          yield* InstanceState.invalidate(full)
        }),
        deactivateAll: Effect.fn("FileWatcher.deactivateAll")(function* () {
          yield* InstanceState.invalidate(full)
          yield* InstanceState.invalidate(git)
        }),
      })
    }),
  )

  const { runPromise } = makeRuntime(Service, layer)

  export function init() {
    return runPromise((svc) => svc.init())
  }

  export function initFull() {
    return runPromise((svc) => svc.initFull())
  }

  export function initGit() {
    return runPromise((svc) => svc.initGit())
  }

  export function deactivate() {
    return runPromise((svc) => svc.deactivate())
  }

  export function deactivateFull() {
    return runPromise((svc) => svc.deactivateFull())
  }

  export function deactivateAll() {
    return runPromise((svc) => svc.deactivateAll())
  }

  function child(input: {
    dir: string
    ignore: string[]
    filter: string[]
    backend: ParcelWatcher.BackendType
    cb: ParcelWatcher.SubscribeCallback
  }) {
    const abort = new AbortController()
    const file = requireSidecar()
    const start = Date.now()
    let why = "unknown"
    const proc = Process.spawn([file], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      abort: abort.signal,
      timeout: SUBPROCESS_KILL_TIMEOUT_MS,
    })
    log.info("watcher child spawn", {
      dir: input.dir,
      backend: input.backend,
      file,
    })
    if (!proc.stdout || !proc.stderr) throw new Error("watcher child output not available")
    const stdin = proc.stdin
    if (!stdin) throw new Error("watcher child input not available")
    const send = (msg: Record<string, unknown>) => {
      if (stdin.destroyed || abort.signal.aborted) return
      stdin.write(JSON.stringify(msg) + "\n")
    }
    const err = createInterface({
      input: proc.stderr,
      crlfDelay: Infinity,
    })
    err.on("line", (line) => {
      if (!line.trim()) return
      log.warn("watcher child stderr", {
        dir: input.dir,
        line,
      })
    })

    const out = createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    })

    const pending = new Promise<Subscription>((resolve, reject) => {
      let ready = false
      let done = false

      const fail = (error: Error) => {
        if (done) return
        done = true
        out.close()
        err.close()
        reject(error)
      }

      const stop = async () => {
        if (done && !ready) return
        done = true
        out.close()
        err.close()
        abort.abort()
        await proc.exited.catch(() => undefined)
      }

      out.on("line", (line) => {
        let msg:
          | { type: "ready"; watched?: number; ignored?: number }
          | { type: "event"; path: string; event: "add" | "change" | "unlink" }
          | { type: "error"; stage: string; error: string; fatal?: boolean }

        try {
          msg = JSON.parse(line)
        } catch (error) {
          fail(new Error(`invalid watcher child message: ${error instanceof Error ? error.message : String(error)}`))
          return
        }

        if (msg.type === "ready") {
          if (done) return
          ready = true
          done = true
          log.info("watcher child ready", {
            dir: input.dir,
            backend: input.backend,
            elapsedMs: Date.now() - start,
            watched: msg.watched,
            ignored: msg.ignored,
            pid: proc.pid,
          })
          resolve({
            unsubscribe() {
              why = "unsubscribe"
              return stop()
            },
          })
          return
        }

        if (msg.type === "event") {
          input.cb(null, [
            {
              path: msg.path,
              type: msg.event === "add" ? "create" : msg.event === "change" ? "update" : "delete",
            },
          ] as ParcelWatcher.Event[])
          return
        }

        if (ready) {
          log.warn("watcher child runtime error", {
            dir: input.dir,
            stage: msg.stage,
            error: msg.error,
            fatal: msg.fatal,
            pid: proc.pid,
          })
          input.cb(new Error(`watcher child ${msg.stage}: ${msg.error}`), [])
          return
        }

        fail(new Error(`watcher child ${msg.stage}: ${msg.error}`))
      })

      proc.once("error", (error) => {
        log.error("watcher child process error", {
          dir: input.dir,
          pid: proc.pid,
          reason: why,
          error,
        })
        fail(error)
      })

      proc.once("exit", (code, signal) => {
        log.info("watcher child exit", {
          dir: input.dir,
          pid: proc.pid,
          ready,
          aborted: abort.signal.aborted,
          reason: why,
          code,
          signal,
          elapsedMs: Date.now() - start,
        })
        if (ready) return
        if (abort.signal.aborted) {
          fail(new Error(`watcher child aborted before ready: ${input.dir}`))
          return
        }
        fail(new Error(`watcher child exited before ready: code=${code ?? "null"} signal=${signal ?? "null"}`))
      })
    })

    send({
      v: 1,
      type: "start",
      root: input.dir,
      ignore: input.ignore,
      filter: input.filter,
      mode: "full",
      dirs: [],
    })

    return {
      pending,
      cancel() {
        if (abort.signal.aborted) return
        why = "cancel"
        abort.abort()
        log.warn("watcher child aborted", { dir: input.dir, pid: proc.pid, reason: why })
      },
    }
  }
}
