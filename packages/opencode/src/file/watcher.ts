import { Cause, Effect, Layer, ServiceMap } from "effect"
import { createInterface } from "readline"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { existsSync, statSync } from "fs"
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
import { childArg } from "./watcher-child"
import { Protected } from "./protected"
import { Process } from "../util/process"
import { Log } from "../util/log"

declare const OPENCODE_LIBC: string | undefined

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })
  const SUBSCRIBE_TIMEOUT_MS = 10_000
  const SUBPROCESS_KILL_TIMEOUT_MS = 500
  const RESPAWN_MAX = 5
  const RESPAWN_BASE_MS = 500
  const RESPAWN_CAP_MS = 8_000
  const RESPAWN_RESET_MS = 60_000
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

  // JS sidecar (watcher-child.ts): hosts @parcel/watcher in a child process
  // so a watcher.node segfault cannot kill the server. On Windows this is
  // the default because the in-process backend has proven crash-prone;
  // OPENCODE_WATCHER_SIDECAR=0 restores the in-process backend. From source
  // the child runs watcher-child.ts directly; a packaged binary has no
  // source file on disk, so it re-executes itself with --watcher-child and
  // the bundled copy of the sidecar hosts the watcher instead.
  function jsSidecar(): string | undefined {
    if (process.platform !== "win32") return undefined
    if (process.env.OPENCODE_WATCHER_SIDECAR === "0") return undefined
    const file = Bun.fileURLToPath(new URL("./watcher-child.ts", import.meta.url))
    if (existsSync(file)) return file
    // Packaged binaries have no source files on disk: import.meta.url then
    // points into the embedded bunfs instead of a real path, so the sidecar
    // runs by re-executing this binary with --watcher-child.
    const url = import.meta.url.toLowerCase()
    if (url.includes("%7ebun") || url.includes("/$bunfs/")) return childArg
    return undefined
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
    readonly refreshGit: () => Effect.Effect<void>
    readonly deactivate: () => Effect.Effect<void>
    readonly deactivateFull: () => Effect.Effect<void>
    readonly deactivateAll: () => Effect.Effect<void>
  }

  export type Subscription = ParcelWatcher.AsyncSubscription & {
    readonly sync?: (dirs: string[]) => Promise<void>
  }

  // @parcel/watcher's Windows backend segfaults under rapid
  // subscribe/unsubscribe churn on the same path (watcher.node node tree),
  // and every sandbox instance watches the project's shared .git dir. Share
  // one native subscription per (backend, dir, ignore) and fan events out to
  // all listeners, serializing every native subscribe/unsubscribe call
  // process-wide.
  type SharedWatch = {
    listeners: Set<ParcelWatcher.SubscribeCallback>
    fanout: ParcelWatcher.SubscribeCallback
  }
  const sharedWatches = new Map<string, SharedWatch>()
  let nativeChain: Promise<void> = Promise.resolve()

  function native<T>(fn: () => Promise<T>): Promise<T> {
    const run = nativeChain.then(fn, fn)
    nativeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function sharedKey(opts: { ignore: string[]; backend?: "windows" | "fs-events" | "inotify" }, dir: string) {
    return `${opts.backend}\u0000${dir}\u0000${opts.ignore.join("\u0001")}`
  }

  function sharedUnsubscribe(
    dir: string,
    cb: ParcelWatcher.SubscribeCallback,
    opts: { ignore: string[]; backend?: "windows" | "fs-events" | "inotify" },
  ): Promise<void> {
    const key = sharedKey(opts, dir)
    const entry = sharedWatches.get(key)
    if (!entry) return Promise.resolve()
    entry.listeners.delete(cb)
    if (entry.listeners.size > 0) return Promise.resolve()
    sharedWatches.delete(key)
    const w = watcher()
    if (!w) return Promise.resolve()
    return native(() =>
      w.unsubscribe(dir, entry.fanout, { ignore: opts.ignore, backend: opts.backend }).catch(() => undefined),
    )
  }

  async function sharedSubscribe(
    dir: string,
    cb: ParcelWatcher.SubscribeCallback,
    opts: { ignore: string[]; backend?: "windows" | "fs-events" | "inotify" },
  ): Promise<Subscription> {
    const key = sharedKey(opts, dir)
    let entry = sharedWatches.get(key)
    if (!entry) {
      const fresh: SharedWatch = {
        listeners: new Set([cb]),
        fanout: (err, evts) => {
          for (const listener of [...fresh.listeners]) listener(err, evts)
        },
      }
      entry = fresh
      sharedWatches.set(key, fresh)
      const w = watcher()
      try {
        if (!w) throw new Error("watcher binding unavailable")
        await native(() => w.subscribe(dir, fresh.fanout, { ignore: opts.ignore, backend: opts.backend }))
      } catch (e) {
        sharedWatches.delete(key)
        fresh.listeners.delete(cb)
        throw e
      }
    } else {
      entry.listeners.add(cb)
    }
    return {
      unsubscribe: async () => {
        await sharedUnsubscribe(dir, cb, opts)
      },
    }
  }

  export type Outcome = { sub?: Subscription; fail?: "timeout" | "error" | "notfound" }

  export interface SuperviseInput {
    readonly dir: string
    readonly kind: "worktree" | "git"
    readonly ignore: string[]
    readonly filter: string[]
    readonly backend: "windows" | "fs-events" | "inotify"
    readonly cb: ParcelWatcher.SubscribeCallback
    readonly js?: string
    readonly sidecar: boolean
    readonly native: boolean
    readonly subs: Set<Subscription>
    readonly scope?: { directory: string; worktree: string; projectID: string }
    readonly disposed: () => boolean
    readonly degrade?: () => Promise<void> | void
    readonly onSpawn?: (proc: Process.Child) => void
    readonly onReady?: () => void
    readonly delay?: (attempt: number) => number
    readonly resetMs?: number
  }

  // Keeps one live subscription for `dir`. Launches the sidecar (falling back
  // to the shared in-process watch when the sidecar cannot attach) and, when
  // a sidecar dies after becoming ready, respawns it with capped exponential
  // backoff instead of leaving the watch silently dead. Consecutive fast
  // crashes give up and report `degrade`; a generation that lives past
  // RESPAWN_RESET_MS resets the attempt budget.
  export async function supervise(input: SuperviseInput): Promise<Outcome> {
    const start = Date.now()
    let born = start
    let attempt = 0
    let gaveUp = false
    let live: Subscription | undefined
    let current: { pending: Promise<Subscription>; cancel?: () => void } | undefined
    let mode = "in-process"

    const attach = async (candidate: { pending: Promise<Subscription> }) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const next = await Promise.race([
          candidate.pending,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("subscribe timeout")), SUBSCRIBE_TIMEOUT_MS)
          }),
        ])
        log.info("subscribe ready", {
          dir: input.dir,
          kind: input.kind,
          backend: input.backend,
          mode,
          respawned: attempt,
          elapsedMs: Date.now() - start,
          ...(input.scope ?? {}),
        })
        input.onReady?.()
        return next
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    const abandon = (candidate: typeof current) => {
      candidate?.cancel?.()
      candidate?.pending.then((sub) => sub.unsubscribe()).catch(() => {})
    }

    const accept = (next: Subscription): Outcome => {
      if (input.disposed()) {
        void next.unsubscribe()
        return {}
      }
      live = next
      born = Date.now()
      input.subs.add(next)
      return { sub: next }
    }

    const respawn = () => {
      if (gaveUp || input.disposed()) return
      const dead = live
      live = undefined
      if (dead) {
        input.subs.delete(dead)
        void dead.unsubscribe()
      }
      if (Date.now() - born >= (input.resetMs ?? RESPAWN_RESET_MS)) attempt = 0
      if (attempt >= RESPAWN_MAX) {
        gaveUp = true
        log.error("watcher respawn gave up", {
          dir: input.dir,
          kind: input.kind,
          mode,
          attempts: attempt,
          ...(input.scope ?? {}),
        })
        void Promise.resolve(input.degrade?.()).catch(() => undefined)
        return
      }
      attempt++
      const wait = input.delay ? input.delay(attempt) : Math.min(RESPAWN_BASE_MS * 2 ** (attempt - 1), RESPAWN_CAP_MS)
      log.warn("watcher respawn scheduled", {
        dir: input.dir,
        kind: input.kind,
        mode,
        attempt,
        delayMs: wait,
        ...(input.scope ?? {}),
      })
      setTimeout(() => {
        if (input.disposed()) return
        launch(true).catch(() => undefined)
      }, wait)
    }

    const launch = async (retry: boolean): Promise<Outcome> => {
      try {
        if (input.sidecar) {
          mode = input.js ? "js-sidecar" : "go-sidecar"
          current = child({
            dir: input.dir,
            ignore: input.ignore,
            filter: input.filter,
            backend: input.backend,
            cb: input.cb,
            js: input.js,
            died: respawn,
            onSpawn: input.onSpawn,
          })
        } else if (input.native) {
          current = { pending: sharedSubscribe(input.dir, input.cb, { ignore: input.ignore, backend: input.backend }) }
        } else {
          current = child({
            dir: input.dir,
            ignore: input.ignore,
            filter: input.filter,
            backend: input.backend,
            cb: input.cb,
            died: respawn,
            onSpawn: input.onSpawn,
          })
        }
        return accept(await attach(current))
      } catch (cause) {
        const first = reason(cause)
        abandon(current)

        // The sidecar is a crash-containment boundary, not a hard
        // requirement: if it cannot run, retry with the in-process
        // backend rather than losing file watching entirely.
        if (input.sidecar && input.native) {
          log.warn("watcher sidecar failed, falling back in-process", {
            dir: input.dir,
            kind: input.kind,
            mode,
            reason: first,
            ...(input.scope ?? {}),
          })
          mode = "in-process"
          current = { pending: sharedSubscribe(input.dir, input.cb, { ignore: input.ignore, backend: input.backend }) }
          try {
            return accept(await attach(current))
          } catch (retryError) {
            abandon(current)
            cause = retryError
          }
        }

        const why = reason(cause)
        log.error("failed to subscribe", {
          dir: input.dir,
          kind: input.kind,
          retry,
          reason: why,
          backend: input.backend,
          elapsedMs: Date.now() - start,
          timeoutMs: SUBSCRIBE_TIMEOUT_MS,
          ignoreCount: input.ignore.length,
          ignorePreview: input.ignore.slice(0, 20),
          ...(input.scope ?? {}),
          cause: cause instanceof Error ? (cause.stack ?? cause.message) : cause,
        })
        if (retry) {
          gaveUp = true
          await Promise.resolve(input.degrade?.()).catch(() => undefined)
        }
        return { fail: why }
      }
    }

    return launch(false)
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

        // Watching a missing directory is both useless and dangerous: stale
        // UI entries have segfaulted watcher.node this way. Skip cleanly.
        if (statSync(Instance.directory, { throwIfNoEntry: false }) === undefined) {
          log.warn("directory missing, skipping watcher", { directory: Instance.directory })
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
            const watchIgnore = process.platform === "linux" && kind === "worktree" ? sidecarIgnore : ignore
            const jsSidecarFile = jsSidecar()
            const useSidecar = !w || (process.platform === "linux" && kind === "worktree") || !!jsSidecarFile
            const filter = kind === "worktree" ? sidecarFilter : []

            const outcome = await supervise({
              dir,
              kind,
              ignore: watchIgnore,
              filter,
              backend,
              cb,
              js: jsSidecarFile,
              sidecar: useSidecar,
              native: !!w,
              subs,
              scope: {
                directory: Instance.directory,
                worktree: Instance.project.worktree,
                projectID: Instance.project.id,
              },
              disposed: () => disposed,
              degrade: () => Effect.runPromise(warn({ dir, reason: "error" })).catch(() => undefined),
            })

            if (outcome.fail && kind === "worktree" && process.platform === "linux") {
              await Effect.runPromise(outcome.fail === "notfound" ? notfound(dir) : warn({ dir, reason: outcome.fail }))
            }
            return outcome.sub
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
        refreshGit: Effect.fn("FileWatcher.refreshGit")(function* () {
          yield* InstanceState.invalidate(git)
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

  export function refreshGit() {
    return runPromise((svc) => svc.refreshGit())
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
    js?: string
    died?: () => void
    onSpawn?: (proc: Process.Child) => void
  }) {
    const abort = new AbortController()
    const command = input.js ? [process.execPath, input.js] : [requireSidecar()]
    const start = Date.now()
    let why = "unknown"
    const proc = Process.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      abort: abort.signal,
      timeout: SUBPROCESS_KILL_TIMEOUT_MS,
    })
    input.onSpawn?.(proc)
    log.info("watcher child spawn", {
      dir: input.dir,
      backend: input.backend,
      file: input.js ?? "go-sidecar",
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
        abort.abort()
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

      // died is a once-per-generation signal: a fatal line racing the process
      // exit (or two fatal lines) must not schedule two respawns.
      let announced = false
      const announce = () => {
        if (announced) return
        announced = true
        input.died?.()
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
          if (msg.fatal) announce()
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
        if (ready) {
          if (abort.signal.aborted) return
          announce()
          return
        }
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
