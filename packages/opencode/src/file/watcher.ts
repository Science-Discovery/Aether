import { Cause, Effect, Layer, Scope, ServiceMap } from "effect"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { readdir, stat } from "fs/promises"
import path from "path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Flag } from "@/flag/flag"
import { Git } from "@/git"
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { Config } from "../config/config"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import { Log } from "../util/log"

declare const OPENCODE_LIBC: string | undefined

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })
  const SUBSCRIBE_TIMEOUT_MS = 10_000
  const WATCH_POLL = 1500
  const LINUX_DIR_LIMIT = 4096
  const LINUX_SCAN_TIMEOUT_MS = 2_000

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

  function withSlash(value: string) {
    return value.replace(/\\/g, "/")
  }

  function ignored(file: string, root: string, ignore: string[]) {
    const rel = withSlash(path.relative(root, file))
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false
    for (const item of ignore) {
      const cur = withSlash(item)
      if (cur.startsWith("**/")) {
        const cut = cur.slice(3)
        if (rel === cut || rel.startsWith(`${cut}/`) || rel.includes(`/${cut}/`)) return true
        continue
      }
      if (cur.endsWith("/**")) {
        const cut = cur.slice(0, -3)
        if (rel === cut || rel.startsWith(`${cut}/`)) return true
        continue
      }
      if (rel === cur || rel.startsWith(`${cur}/`)) return true
    }
    return false
  }

  function protecteds(dir: string) {
    return Protected.paths().filter((item) => {
      const rel = path.relative(dir, item)
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
    })
  }

  async function count(root: string, ignore: string[]) {
    const end = Date.now() + LINUX_SCAN_TIMEOUT_MS
    const list = [root]
    let seen = 0

    while (list.length) {
      if (Date.now() > end) return { ok: false as const, reason: "timeout" as const, seen }

      const dir = list.pop()!
      seen += 1
      if (seen > LINUX_DIR_LIMIT) return { ok: false as const, reason: "limit" as const, seen }

      const rel = path.relative(root, dir)
      if (rel && FileIgnore.match(rel, { extra: ignore })) continue

      const items = await readdir(dir, { withFileTypes: true }).catch((error) => ({ error }))
      if ("error" in items) return { ok: false as const, reason: "error" as const, seen, error: items.error }

      for (const item of items) {
        if (!item.isDirectory()) continue
        const next = path.join(dir, item.name)
        const rel = path.relative(root, next)
        if (FileIgnore.match(rel, { extra: ignore })) continue
        list.push(next)
      }
    }

    return { ok: true as const, seen }
  }

  function warn(input: { dir: string; seen: number; reason: "limit" | "timeout" | "error" }) {
    const detail =
      input.reason === "limit"
        ? `more than ${LINUX_DIR_LIMIT} directories`
        : input.reason === "timeout"
          ? `directory scan exceeded ${LINUX_SCAN_TIMEOUT_MS}ms`
          : "directory scan failed"
    log.warn("watcher skipped for linux directory budget", {
      dir: input.dir,
      seen: input.seen,
      limit: LINUX_DIR_LIMIT,
      timeoutMs: LINUX_SCAN_TIMEOUT_MS,
      reason: input.reason,
      detail,
    })
    return Effect.promise(() => Bus.publish(Event.Limited, { dir: input.dir, reason: input.reason })).pipe(
      Effect.catchCause(() => Effect.void),
    )
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

            log.info("watcher chain", {
              directory: Instance.directory,
              platform: process.platform,
              chain: "parcel->poll",
            })

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

            const scan = async (root: string, ignore: string[]) => {
              const next = new Map<string, string>()
              const walk = async (dir: string): Promise<void> => {
                const list = await readdir(dir, { withFileTypes: true }).catch(() => [])
                await Promise.all(
                  list.map(async (item) => {
                    const file = path.join(dir, item.name)
                    if (ignored(file, root, ignore)) return
                    if (item.isDirectory()) {
                      await walk(file)
                      return
                    }
                    if (!item.isFile()) return
                    const info = await stat(file).catch(() => undefined)
                    if (!info) return
                    next.set(file, `${Math.round(info.mtimeMs)}:${info.size}`)
                  }),
                )
              }
              await walk(root)
              return next
            }

            const poll = (root: string, ignore: string[]) =>
              Effect.gen(function* () {
                let prev = yield* Effect.promise(() => scan(root, ignore))
                let busy = false
                const id = setInterval(() => {
                  if (busy) return
                  busy = true
                  void (async () => {
                    try {
                      const next = await scan(root, ignore)
                      for (const [file, cur] of next) {
                        const old = prev.get(file)
                        if (!old) {
                          Bus.publish(Event.Updated, { file, event: "add" })
                          continue
                        }
                        if (old !== cur) Bus.publish(Event.Updated, { file, event: "change" })
                      }
                      for (const file of prev.keys()) {
                        if (!next.has(file)) Bus.publish(Event.Updated, { file, event: "unlink" })
                      }
                      prev = next
                    } finally {
                      busy = false
                    }
                  })()
                }, WATCH_POLL)
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    clearInterval(id)
                  }),
                )
              })

            const subscribe = (dir: string, ignore: string[]) => {
              const w = watcher()
              if (!w) return Effect.succeed(false)
              const pending = w.subscribe(dir, cb, { ignore, backend })
              return Effect.gen(function* () {
                const sub = yield* Effect.promise(() => pending)
                subs.push(sub)
                return true
              }).pipe(
                Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
                Effect.catchCause((cause) => {
                  log.error("failed to subscribe", {
                    dir,
                    backend,
                    timeoutMs: SUBSCRIBE_TIMEOUT_MS,
                    ignoreCount: ignore.length,
                    ignorePreview: ignore.slice(0, 20),
                    directory: Instance.directory,
                    worktree: Instance.project.worktree,
                    projectID: Instance.project.id,
                    cause: Cause.pretty(cause),
                  })
                  pending.then((s) => s.unsubscribe()).catch(() => {})
                  return Effect.succeed(false)
                }),
              )
            }

            const start = (dir: string, ignore: string[]) =>
              Effect.gen(function* () {
                const ok = yield* subscribe(dir, ignore)
                if (ok) return
                log.info("watcher fallback", {
                  directory: Instance.directory,
                  target: dir,
                  platform: process.platform,
                  from: "parcel",
                  to: "poll",
                })
                yield* poll(dir, ignore)
              })

            const cfg = yield* Effect.promise(() => Config.get())
            const cfgIgnores = cfg.watcher?.ignore ?? []
            const ignore = [...FileIgnore.PATTERNS, ...cfgIgnores, ...protecteds(Instance.directory)]

            if (process.platform === "win32" && !Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER_FORCE_PARCEL) {
              log.info("watcher backend", { directory: Instance.directory, platform: process.platform, backend: "fs" })
              if (!enabled) {
                log.info("worktree watcher disabled", { directory: Instance.directory })
                return
              }
              const watcher = fsWatch(
                Instance.directory,
                { recursive: true },
                Instance.bind((raw, name) => {
                  const file = name ? path.resolve(Instance.directory, name.toString()) : Instance.directory
                  if (ignored(file, Instance.directory, ignore)) return
                  const publish = (event: "add" | "change" | "unlink") => {
                    Bus.publish(Event.Updated, { file, event })
                  }
                  if (raw !== "rename") {
                    publish("change")
                    return
                  }
                  void stat(file)
                    .then(() => publish("add"))
                    .catch(() => publish("unlink"))
                }),
              )
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  watcher.close()
                }),
              )
              watcher.on("error", (error) => {
                log.error("fs watcher error", { directory: Instance.directory, error })
              })
              return
            }

            if (enabled) {
              if (backend !== "inotify") {
                yield* start(Instance.directory, ignore)
              }
              if (backend === "inotify") {
                const scan = yield* Effect.promise(() => count(Instance.directory, ignore))
                if (scan.ok) {
                  yield* start(Instance.directory, ignore)
                }
                if (!scan.ok) yield* warn({ dir: Instance.directory, seen: scan.seen, reason: scan.reason })
              }
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
                yield* start(vcsDir, ignore)
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
}
