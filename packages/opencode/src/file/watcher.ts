import { Cause, Effect, Layer, ServiceMap } from "effect"
import { createInterface } from "readline"
import type ParcelWatcher from "@parcel/watcher"
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
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { Config } from "../config/config"
import * as Parcel from "./parcel-watcher"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import { Glob } from "../util/glob"
import { Process } from "../util/process"
import { Log } from "../util/log"

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })
  const SUBSCRIBE_TIMEOUT_MS = 5_000
  const SUBSCRIBE_COOLDOWN_MS = 60_000
  const SUBPROCESS_KILL_TIMEOUT_MS = 500
  const worker = fileURLToPath(new URL("./watcher-child.ts", import.meta.url))
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

  function isglob(value: string) {
    return /[*?[\]{}()!]/.test(value)
  }

  function ignored(root: string, target: string, ignore: string[]) {
    const rel = path.relative(root, target)
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false
    for (const item of ignore) {
      if (!isglob(item)) {
        const abs = path.resolve(root, item)
        if (target === abs || target.startsWith(abs + path.sep)) return true
        continue
      }
      if (Glob.match(item, rel)) return true
    }
    return false
  }

  async function count(root: string, ignore: string[]) {
    const start = Date.now()
    const list = [root]
    let watched = 0
    let skipped = 0
    let failed = 0
    while (list.length) {
      const dir = list.pop()!
      if (dir !== root && ignored(root, dir, ignore)) {
        skipped += 1
        continue
      }
      watched += 1
      const items = await readdir(dir, { withFileTypes: true }).catch(() => undefined)
      if (!items) {
        failed += 1
        continue
      }
      for (const item of items) {
        if (!item.isDirectory()) continue
        list.push(path.join(dir, item.name))
      }
    }
    return {
      watched,
      skipped,
      failed,
      elapsedMs: Date.now() - start,
    }
  }

  function cool(dir: string) {
    const item = cooldown.get(dir)
    if (!item) return
    if (item.until > Date.now()) return item
    cooldown.delete(dir)
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

            const subs: ParcelWatcher.AsyncSubscription[] = []
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => Promise.allSettled(subs.map((sub) => sub.unsubscribe()))),
            )

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

            const subscribe = (dir: string, ignore: string[], kind: "worktree" | "git") => {
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
                return limited(dir, item.reason)
              }
              const start = Date.now()
              let state = "pending" as "pending" | "ok" | "timeout" | "error"
              inflight += 1
              const input =
                process.platform === "linux" && kind === "worktree"
                  ? child({
                      dir,
                      ignore,
                      backend,
                      cb,
                    })
                  : {
                      pending: w.subscribe(dir, cb, { ignore, backend }),
                      cancel: () => void w.unsubscribe(dir, cb, { ignore, backend }).catch(() => undefined),
                    }
              const pending = input.pending
              pending
                .then((sub) => {
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
                  return sub.unsubscribe().catch(() => {})
                })
                .catch((error) => {
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
                })
              return Effect.gen(function* () {
                const sub = yield* Effect.promise(() => pending)
                state = "ok"
                cooldown.delete(dir)
                subs.push(sub)
              }).pipe(
                Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    const reason = Cause.isTimeoutError(Cause.squash(cause)) ? "timeout" : "error"
                    state = reason
                    cooldown.set(dir, { reason, until: Date.now() + SUBSCRIBE_COOLDOWN_MS })
                    const stats = yield* Effect.promise(() => linux())
                    const tree =
                      process.platform === "linux" && kind === "worktree"
                        ? yield* Effect.promise(() => count(dir, ignore))
                        : undefined
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
                      tree,
                      cause: Cause.pretty(cause),
                    })
                    input.cancel?.()
                    yield* limited(dir, reason)
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    inflight = Math.max(0, inflight - 1)
                  }),
                ),
              )
            }

            const cfg = yield* Effect.promise(() => Config.get())
            const cfgIgnores = cfg.watcher?.ignore ?? []
            const ignore = [...FileIgnore.WATCH, ...cfgIgnores, ...protecteds(Instance.directory)]

            if (enabled) {
              yield* subscribe(Instance.directory, ignore, "worktree")
            }
            if (!enabled) {
              log.info("worktree watcher disabled", { directory: Instance.directory })
            }

            if (Instance.project.vcs === "git") {
              const result = yield* Effect.promise(() =>
                Git.run(["rev-parse", "--git-dir"], {
                  cwd: Instance.project.worktree,
                }),
              )
              const vcsDir =
                result.exitCode === 0 ? path.resolve(Instance.project.worktree, result.text().trim()) : undefined
              if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
                const ignore = (yield* Effect.promise(() => readdir(vcsDir).catch(() => []))).filter(
                  (entry) => entry !== "HEAD",
                )
                yield* subscribe(vcsDir, ignore, "git")
              }
            }
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
    backend: ParcelWatcher.BackendType
    cb: ParcelWatcher.SubscribeCallback
  }) {
    const abort = new AbortController()
    const proc = Process.spawn(
      [
        BunProc.which(),
        worker,
        Buffer.from(JSON.stringify({ dir: input.dir, ignore: input.ignore, backend: input.backend })).toString(
          "base64url",
        ),
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
          | { type: "ready" }
          | { type: "event"; path: string; event: "add" | "change" | "unlink" }
          | { type: "error"; stage: string; error: string }

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
