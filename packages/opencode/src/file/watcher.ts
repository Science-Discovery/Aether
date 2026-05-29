import { Cause, Effect, Layer, Scope, ServiceMap } from "effect"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { readdir } from "fs/promises"
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

            const w = watcher()
            if (!w) return

            log.info("watcher backend", { directory: Instance.directory, platform: process.platform, backend })

            const subs: ParcelWatcher.AsyncSubscription[] = []
            let disposed = false
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                disposed = true
                yield* Effect.promise(() => Promise.allSettled(subs.map((sub) => sub.unsubscribe())))
                log.info("watcher unsubscribed", {
                  directory: Instance.directory,
                  subscriptionCount: subs.length,
                })
              }),
            )

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

            const subscribe = (dir: string, ignore: string[]) => {
              const pending = w.subscribe(dir, cb, { ignore, backend })
              return Effect.gen(function* () {
                const sub = yield* Effect.promise(() => pending)
                subs.push(sub)
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
                  return Effect.void
                }),
              )
            }

            const cfg = yield* Effect.promise(() => Config.get())
            const cfgIgnores = cfg.watcher?.ignore ?? []
            const ignore = [...FileIgnore.PATTERNS, ...cfgIgnores, ...protecteds(Instance.directory)]

            if (enabled) {
              if (backend !== "inotify") {
                yield* subscribe(Instance.directory, ignore)
              }
              if (backend === "inotify") {
                const scan = yield* Effect.promise(() => count(Instance.directory, ignore))
                if (scan.ok) {
                  yield* subscribe(Instance.directory, ignore)
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
                yield* subscribe(vcsDir, ignore)
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
