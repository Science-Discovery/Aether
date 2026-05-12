import { Cause, Effect, Layer, ServiceMap } from "effect"
import { createInterface } from "readline"
import type ParcelWatcher from "@parcel/watcher"
import { existsSync } from "fs"
import { readdir } from "fs/promises"
import { fileURLToPath } from "url"
import path from "path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { BunProc } from "@/bun"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Flag } from "@/flag/flag"
import { Git } from "@/git"
import { Installation } from "@/installation"
import { ActiveDirectory } from "@/project/active-directory"
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
  const SUBSCRIBE_TIMEOUT_MS = 5_000
  const SUBSCRIBE_COOLDOWN_MS = 60_000
  const SUBPROCESS_KILL_TIMEOUT_MS = 500
  const worker = fileURLToPath(new URL("./watcher-child.ts", import.meta.url))
  const sidecarDir = fileURLToPath(new URL("../../../go-watcher/bin/", import.meta.url))
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
      const file = path.join(sidecarDir, name)
      if (existsSync(file)) return file
      return
    }
    const file = path.join(path.dirname(process.execPath), "native", name)
    if (existsSync(file)) return file
  }

  export const hasNativeBinding = () => !!watcher()

  export interface Interface {
    readonly init: () => Effect.Effect<void>
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
            const filter = [...cfgIgnores, ...keep]
            const skip = (file: string) => FileIgnore.filter(filter, file, Instance.directory)

            const cb: ParcelWatcher.SubscribeCallback = Instance.bind((err, evts) => {
              if (err) {
                log.error("watcher callback error", { directory: Instance.directory, error: err })
                return
              }
              for (const evt of evts) {
                if (skip(evt.path)) continue
                if (evt.type === "create") Bus.publish(Event.Updated, { file: evt.path, event: "add" })
                if (evt.type === "update") Bus.publish(Event.Updated, { file: evt.path, event: "change" })
                if (evt.type === "delete") Bus.publish(Event.Updated, { file: evt.path, event: "unlink" })
              }
            })

            const subscribe = async (dir: string, ignore: string[], kind: "worktree" | "git") => {
              const item = cool(dir)
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
              const input =
                process.platform === "linux" && kind === "worktree"
                  ? child({
                      dir,
                      ignore,
                      filter,
                      backend,
                      cb,
                    })
                  : {
                      pending: w.subscribe(dir, cb, { ignore, backend }),
                      cancel: () => void w.unsubscribe(dir, cb, { ignore, backend }).catch(() => undefined),
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
                  ignoreCount: ignore.length,
                  ignorePreview: ignore.slice(0, 20),
                  directory: Instance.directory,
                  worktree: Instance.project.worktree,
                  projectID: Instance.project.id,
                  linux: stats,
                  cause: error instanceof Error ? error.stack ?? error.message : error,
                })
                input.cancel?.()
                await Effect.runPromise(limited(dir, reason))
                return
              } finally {
                inflight = Math.max(0, inflight - 1)
              }
            }

            const ignore = [...FileIgnore.WATCH, ...cfgIgnores, ...keep]
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

            let worktree: ParcelWatcher.AsyncSubscription | undefined
            let git: ParcelWatcher.AsyncSubscription | undefined
            let queue = Promise.resolve()

            const stop = async (sub?: ParcelWatcher.AsyncSubscription) => {
              if (!sub) return
              subs.delete(sub)
              await sub.unsubscribe().catch(() => undefined)
            }

            const sync = async (directory?: string) => {
              const active = directory === Instance.directory

              if (!enabled || !active) {
                await stop(worktree)
                worktree = undefined
              }
              if (enabled && active && !worktree) {
                worktree = await subscribe(Instance.directory, ignore, "worktree")
              }
              if (!enabled) {
                log.info("worktree watcher disabled", { directory: Instance.directory })
              }

              if (!active || !vcsDir || !gitIgnore) {
                await stop(git)
                git = undefined
                return
              }
              if (git) return
              git = await subscribe(vcsDir, gitIgnore, "git")
            }

            const run = (directory?: string) => {
              queue = queue
                .then(() => sync(directory))
                .catch((error) => {
                  log.error("failed to sync watcher activity", {
                    directory: Instance.directory,
                    active_directory: directory,
                    error,
                  })
                })
              return queue
            }

            const off = ActiveDirectory.subscribe(Instance.bind((directory) => void run(directory)))
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                off()
                await queue
              }),
            )

            yield* Effect.promise(() => run(ActiveDirectory.get()))
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
  }) {
    const abort = new AbortController()
    const file = sidecar()
    const proc = file
      ? Process.spawn([file], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          abort: abort.signal,
          timeout: SUBPROCESS_KILL_TIMEOUT_MS,
        })
      : Process.spawn(
          [
            BunProc.which(),
            worker,
            Buffer.from(
              JSON.stringify({
                dir: input.dir,
                ignore: input.ignore,
                filter: input.filter,
                backend: input.backend,
              }),
            ).toString("base64url"),
          ],
          {
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
            abort: abort.signal,
            timeout: SUBPROCESS_KILL_TIMEOUT_MS,
            env: {
              BUN_BE_BUN: "1",
            },
          },
        )
    if (!proc.stdout || !proc.stderr) throw new Error("watcher child output not available")
    if (file) {
      if (!proc.stdin) throw new Error("watcher child input not available")
      proc.stdin.end(
        JSON.stringify({
          v: 1,
          type: "start",
          root: input.dir,
          ignore: input.ignore,
          filter: input.filter,
        }) + "\n",
      )
    }

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

    const pending = new Promise<ParcelWatcher.AsyncSubscription>((resolve, reject) => {
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
          resolve({
            unsubscribe() {
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
          input.cb(new Error(`watcher child ${msg.stage}: ${msg.error}`), [])
          return
        }

        fail(new Error(`watcher child ${msg.stage}: ${msg.error}`))
      })

      proc.once("error", (error) => {
        fail(error)
      })

      proc.once("exit", (code, signal) => {
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
      abort.abort()
        log.warn("watcher child aborted", { dir: input.dir })
      },
    }
  }
}
