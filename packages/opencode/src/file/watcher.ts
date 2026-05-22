import { Cause, Effect, Layer, ServiceMap } from "effect"
import { createInterface } from "readline"
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
import { ActiveDirectory } from "@/project/active-directory"
import { WatcherHint } from "@/project/watcher-hint"
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { Config } from "../config/config"
import * as Parcel from "./parcel-watcher"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import { Process } from "../util/process"
import { Log } from "../util/log"

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })
  const SUBSCRIBE_TIMEOUT_MS = 10_000
  const SUBSCRIBE_COOLDOWN_MS = 60_000
  const SUBPROCESS_KILL_TIMEOUT_MS = 500
  const sidecarDir = new URL("../../../go-watcher/bin/", import.meta.url)
  let inflight = 0
  const cooldown = new Map<string, { until: number; reason: "timeout" | "error" }>()

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
  }

  const watcher = lazy(() => {
    const loaded = Parcel.load()
    if (loaded.value) return loaded.value
    log.error("failed to load watcher binding", loaded)
    return
  })

  function getBackend() {
    return Parcel.backend()
  }

  function protecteds(dir: string) {
    return Protected.paths().filter((item) => {
      const rel = path.relative(dir, item)
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
    })
  }

  function limited(dir: string, reason: "timeout" | "error") {
    return Effect.promise(() => Bus.publish(Event.Limited, { dir, reason })).pipe(
      Effect.catchCause(() => Effect.void),
    )
  }

  async function linux() {
    if (process.platform !== "linux") return
    const [watches, instances, fds] = await Promise.all([
      Bun.file("/proc/sys/fs/inotify/max_user_watches")
        .text()
        .then((x) => x.trim())
        .catch(() => undefined),
      Bun.file("/proc/sys/fs/inotify/max_user_instances")
        .text()
        .then((x) => x.trim())
        .catch(() => undefined),
      readdir("/proc/self/fd")
        .then((x) => x.length)
        .catch(() => undefined),
    ])
    return {
      max_user_watches: watches,
      max_user_instances: instances,
      fd_count: fds,
    }
  }

  function cool(dir: string) {
    const item = cooldown.get(dir)
    if (!item) return
    if (item.until > Date.now()) return item
    cooldown.delete(dir)
  }

  function sidecar() {
    const env = process.env.OPENCODE_GO_WATCHER_PATH
    if (env && existsSync(env)) return env
    const name = process.platform === "win32" ? "opencode-watcher.exe" : "opencode-watcher"
    if (Installation.isLocal()) {
      const file = new URL(name, sidecarDir)
      const path = Bun.fileURLToPath(file)
      if (existsSync(path)) return path
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
      const file = Bun.fileURLToPath(new URL(name, sidecarDir))
      if (existsSync(file)) return file
      throw new Error(`go watcher binary not found: ${file}`)
    }
    throw new Error(`go watcher binary not found: ${path.join(path.dirname(process.execPath), "native", name)}`)
  }

  export const hasNativeBinding = () => !!watcher()

  export interface Interface {
    readonly init: () => Effect.Effect<void>
  }

  type Subscription = ParcelWatcher.AsyncSubscription & {
    readonly sync?: (dirs: string[]) => Promise<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/FileWatcher") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make(
        Effect.fn("FileWatcher.state")(
          function* () {
            const disabled = yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
            const enabled = yield* Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER

            if (disabled) {
              log.info("watcher disabled by flag", { directory: Instance.directory })
              return
            }

            log.info("init", { directory: Instance.directory })

            const backend = getBackend()
            if (!backend) {
              log.error("watcher backend not supported", { directory: Instance.directory, platform: process.platform })
              return
            }

            const w = watcher()
            if (!w) return

            log.info("watcher backend", { directory: Instance.directory, platform: process.platform, backend })

            const subs = new Set<ParcelWatcher.AsyncSubscription>()
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => Promise.allSettled([...subs].map((sub) => sub.unsubscribe()))),
            )

            const cfg = yield* Effect.promise(() => Config.get())
            const cfgIgnores = cfg.watcher?.ignore ?? []
            const keep = protecteds(Instance.directory)
            const parcelIgnore = FileIgnore.event(cfgIgnores, keep)
            const sidecarIgnore = FileIgnore.watch(cfgIgnores, keep)
            const sidecarFilter = FileIgnore.event(cfgIgnores, keep)

            const cb: ParcelWatcher.SubscribeCallback = Instance.bind((err, evts) => {
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

            const subscribe = async (
              dir: string,
              ignore: string[],
              kind: "worktree" | "git",
              fallback?: (reason: "timeout" | "error") => Promise<Subscription | undefined>,
            ) => {
              const item = cool(dir)
              const watchIgnore = process.platform === "linux" && kind === "worktree" ? sidecarIgnore : ignore
              if (item) {
                log.warn("subscribe skipped during cooldown", {
                  dir,
                  kind,
                  pid: process.pid,
                  backend,
                  cooldownMs: Math.max(0, item.until - Date.now()),
                  reason: item.reason,
                  directory: Instance.directory,
                  worktree: Instance.project.worktree,
                  projectID: Instance.project.id,
                })
                await Effect.runPromise(limited(dir, item.reason))
                return
              }
              const start = Date.now()
              inflight += 1
              let state = "pending" as "pending" | "ok" | "timeout" | "error"
              log.info("subscribe start", {
                dir,
                kind,
                pid: process.pid,
                backend,
                inflight,
                ignoreCount: watchIgnore.length,
                directory: Instance.directory,
                worktree: Instance.project.worktree,
                projectID: Instance.project.id,
              })
              const input =
                process.platform === "linux" && kind === "worktree"
                  ? child({
                      dir,
                      ignore: watchIgnore,
                      filter: sidecarFilter,
                      backend,
                      cb,
                    })
                  : {
                      pending: w.subscribe(dir, cb, { ignore: watchIgnore, backend }),
                      cancel: () => void w.unsubscribe(dir, cb, { ignore: watchIgnore, backend }).catch(() => undefined),
                    }
              const pending = input.pending
              pending.then(
                (sub) => {
                  if (state !== "timeout") return
                  log.warn("subscribe resolved after timeout", {
                    dir,
                    kind,
                    pid: process.pid,
                    backend,
                    elapsedMs: Date.now() - start,
                    directory: Instance.directory,
                    worktree: Instance.project.worktree,
                    projectID: Instance.project.id,
                  })
                  void sub.unsubscribe().catch(() => {})
                },
                (error) => {
                  if (state !== "timeout") return
                  log.warn("subscribe rejected after timeout", {
                    dir,
                    kind,
                    pid: process.pid,
                    backend,
                    elapsedMs: Date.now() - start,
                    directory: Instance.directory,
                    worktree: Instance.project.worktree,
                    projectID: Instance.project.id,
                    error,
                  })
                },
              )
              try {
                const sub = await Promise.race([
                  pending,
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("subscribe timeout")), SUBSCRIBE_TIMEOUT_MS),
                  ),
                ])
                state = "ok"
                cooldown.delete(dir)
                subs.add(sub)
                log.info("subscribe ready", {
                  dir,
                  kind,
                  pid: process.pid,
                  backend,
                  elapsedMs: Date.now() - start,
                  inflight,
                  directory: Instance.directory,
                  worktree: Instance.project.worktree,
                  projectID: Instance.project.id,
                })
                return sub
              } catch (error) {
                const reason = error instanceof Error && error.message === "subscribe timeout" ? "timeout" : "error"
                state = reason
                cooldown.set(dir, { reason, until: Date.now() + SUBSCRIBE_COOLDOWN_MS })
                const stats = await linux()
                log.error("failed to subscribe", {
                  dir,
                  kind,
                  pid: process.pid,
                  reason,
                  backend,
                  elapsedMs: Date.now() - start,
                  inflight,
                  timeoutMs: SUBSCRIBE_TIMEOUT_MS,
                  cooldownMs: SUBSCRIBE_COOLDOWN_MS,
                  ignoreCount: watchIgnore.length,
                  ignorePreview: watchIgnore.slice(0, 20),
                  directory: Instance.directory,
                  worktree: Instance.project.worktree,
                  projectID: Instance.project.id,
                  linux: stats,
                  cause: error instanceof Error ? error.stack ?? error.message : error,
                })
                input.cancel?.()
                const sub = await fallback?.(reason)
                if (sub) {
                  state = "ok"
                  subs.add(sub)
                  return sub
                }
                await Effect.runPromise(limited(dir, reason))
                return
              } finally {
                inflight = Math.max(0, inflight - 1)
              }
            }

            const result =
              Instance.project.vcs === "git"
                ? yield* Effect.promise(() =>
                    Git.run(["rev-parse", "--git-dir"], {
                      cwd: Instance.project.worktree,
                    }),
                  )
                : undefined
            const vcsDir =
              result && result.exitCode === 0 ? path.resolve(Instance.project.worktree, result.text().trim()) : undefined
            const gitIgnore =
              vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)
                ? (yield* Effect.promise(() => readdir(vcsDir).catch(() => []))).filter((entry) => entry !== "HEAD")
                : undefined

            let worktree: Subscription | undefined
            let limitedWorktree: Subscription | undefined
            let git: Subscription | undefined
            let queue = Promise.resolve()
            let degraded = false

            const stop = async (
              sub: Subscription | undefined,
              kind: "worktree" | "git" | "limited",
              reason: string,
            ) => {
              if (!sub) return
              subs.delete(sub)
              log.info("unsubscribe start", {
                kind,
                reason,
                directory: Instance.directory,
                active_directory: ActiveDirectory.get(),
                active_directories: ActiveDirectory.list(),
                leases: ActiveDirectory.count(Instance.directory),
              })
              await sub.unsubscribe().catch(() => undefined)
              log.info("unsubscribe done", {
                kind,
                reason,
                directory: Instance.directory,
              })
            }

            const limitedChild = async (reason?: "timeout" | "error") => {
              if (process.platform !== "linux") return
              degraded = true
              if (reason) {
                await Effect.runPromise(limited(Instance.directory, reason))
              }
              return child({
                dir: Instance.directory,
                ignore: sidecarIgnore,
                filter: sidecarFilter,
                backend,
                cb,
                mode: "limited",
                dirs: WatcherHint.watch(Instance.directory),
              }).pending
            }

            const sync = async () => {
              const active = Instance.source !== "web" || ActiveDirectory.has(Instance.directory)
              const hinted = WatcherHint.watch(Instance.directory)
              log.info("sync watcher activity", {
                directory: Instance.directory,
                source: Instance.source,
                enabled,
                active,
                degraded,
                hinted: hinted.length,
                active_directory: ActiveDirectory.get(),
                active_directories: ActiveDirectory.list(),
                leases: ActiveDirectory.count(Instance.directory),
                worktree: !!worktree,
                limited: !!limitedWorktree,
                git: !!git,
              })

              if (!enabled || !active) {
                await stop(worktree, "worktree", !enabled ? "disabled" : "lease-missing")
                worktree = undefined
                await stop(limitedWorktree, "limited", !enabled ? "disabled" : "lease-missing")
                limitedWorktree = undefined
              }
              if (enabled && active && !worktree && !degraded) {
                worktree = await subscribe(Instance.directory, parcelIgnore, "worktree", async (reason) => {
                  limitedWorktree = await limitedChild(reason)
                  return limitedWorktree
                })
              }
              if (enabled && active && degraded) {
                if (!limitedWorktree) {
                  limitedWorktree = await limitedChild()
                } else {
                  await limitedWorktree.sync?.(hinted)
                }
              }
              if (!enabled) {
                log.info("worktree watcher disabled", { directory: Instance.directory })
              }

              if (!active || !vcsDir || !gitIgnore) {
                await stop(git, "git", !active ? "lease-missing" : !vcsDir ? "no-vcs-dir" : "no-git-ignore")
                git = undefined
                return
              }
              if (git) return
              git = await subscribe(vcsDir, gitIgnore, "git")
            }

            const run = () => {
              queue = queue
                .then(() => sync())
                .catch((error) => {
                  log.error("failed to sync watcher activity", {
                    directory: Instance.directory,
                    active_directory: ActiveDirectory.get(),
                    active_directories: ActiveDirectory.list(),
                    error,
                  })
                })
              return queue
            }

            const off = ActiveDirectory.subscribe(Instance.bind(() => void run()))
            const offHint = WatcherHint.subscribe(Instance.bind(() => void run()))
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                off()
                offHint()
                await stop(worktree, "worktree", "finalizer")
                await stop(limitedWorktree, "limited", "finalizer")
                await stop(git, "git", "finalizer")
                await queue
              }),
            )

            yield* Effect.promise(() => run())
          },
          Effect.catchCause((cause) => {
            log.error("failed to init watcher service", { cause: Cause.pretty(cause) })
            return Effect.void
          }),
        ),
      )

      return Service.of({
        init: Effect.fn("FileWatcher.init")(function* () {
          yield* InstanceState.get(state)
        }),
      })
    }),
  )

  const { runPromise } = makeRuntime(Service, layer)

  export function init() {
    return runPromise((svc) => svc.init())
  }

  function child(input: {
    dir: string
    ignore: string[]
    filter: string[]
    backend: ParcelWatcher.BackendType
    cb: ParcelWatcher.SubscribeCallback
    mode?: "full" | "limited"
    dirs?: string[]
  }) {
    const abort = new AbortController()
    const file = requireSidecar()
    const start = Date.now()
    let reason = "unknown"
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
      mode: "sidecar",
      file,
    })
    if (!proc.stdout || !proc.stderr) throw new Error("watcher child output not available")
    const stdin = proc.stdin
    if (!stdin) throw new Error("watcher child input not available")
    const send = (msg: Record<string, unknown>) => {
      if (stdin.destroyed || abort.signal.aborted) return
      stdin.write(JSON.stringify(msg) + "\n")
    }
    send({
      v: 1,
      type: "start",
      root: input.dir,
      ignore: input.ignore,
      filter: input.filter,
      mode: input.mode ?? "full",
      dirs: input.dirs ?? [],
    })

    const stderr = createInterface({
      input: proc.stderr,
      crlfDelay: Infinity,
    })
    stderr.on("line", (line) => {
      if (!line.trim()) return
      log.warn("watcher child stderr", {
        dir: input.dir,
        line,
      })
    })

    const stdout = createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    })

    const pending = new Promise<Subscription>((resolve, reject) => {
      let ready = false
      let done = false

      const fail = (error: Error) => {
        if (done) return
        done = true
        stdout.close()
        stderr.close()
        reject(error)
      }

      const stop = async () => {
        if (done && !ready) return
        done = true
        stdout.close()
        stderr.close()
        abort.abort()
        await proc.exited.catch(() => undefined)
      }

      stdout.on("line", (line) => {
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
              reason = "unsubscribe"
              return stop()
            },
            sync(dirs: string[]) {
              reason = "sync"
              send({
                v: 1,
                type: "sync",
                dirs,
              })
              return Promise.resolve()
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
          reason,
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
          reason,
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

    return {
      pending,
      cancel() {
        if (abort.signal.aborted) return
        reason = "cancel"
        abort.abort()
        log.warn("watcher child aborted", { dir: input.dir, pid: proc.pid, reason })
      },
    }
  }
}
