import { ActiveInstance } from "@/project/active-instance"
import { GlobalBus } from "@/bus/global"
import { Database } from "@/storage/db"
import { disposeInstance } from "@/effect/instance-registry"
import { Filesystem } from "@/util/filesystem"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import path from "path"
import { Context } from "../util/context"
import { Project } from "./project"
import { State } from "./state"
import { ProjectIdentity } from "./identity"

export interface Shape {
  directory: string
  worktree: string
  project: Project.Info
}
const context = Context.create<Shape>("instance")
const cache = new Map<string, Promise<Shape>>()
// Tombstone for directories being torn down. Keyed by BOTH the lexical form
// captured at beginClose and the true (realpath) form: Filesystem.resolve
// only restores true casing / symlinks for paths that still exist, so a
// single key would leak when endClose runs after the directory was deleted
// (different form, missed delete, permanent no-create tombstone).
const closing = new Map<string, string>()

function lexKey(resolved: string) {
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function lexNorm(directory: string) {
  const p = path.resolve(directory)
  return lexKey(p)
}

const disposal = {
  all: undefined as Promise<void> | undefined,
}

function emit(directory: string) {
  try {
    GlobalBus.emit("event", {
      directory,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory,
        },
      },
    })
  } catch (e) {
    Log.Default.error("emit instance disposed failed", { directory, error: e instanceof Error ? e.message : e })
  }
}

function boot(input: { directory: string; init?: () => Promise<any>; project?: Project.Info; worktree?: string }) {
  return iife(async () => {
    const ctx =
      input.project && input.worktree
        ? {
            directory: input.directory,
            worktree: input.worktree,
            project: input.project,
          }
        : await Project.fromDirectory(input.directory).then(({ project, sandbox }) => ({
            directory: input.directory,
            worktree: sandbox,
            project,
          }))
    await context.provide(ctx, async () => {
      await input.init?.()
    })
    return ctx
  })
}

function track(directory: string, next: Promise<Shape>) {
  const task = next.catch((error) => {
    if (cache.get(directory) === task) cache.delete(directory)
    throw error
  })
  cache.set(directory, task)
  return task
}

export const Instance = {
  async provide<R>(input: {
    directory: string
    init?: () => Promise<any>
    fn: () => R
    create?: boolean
    project?: Project.Info
    worktree?: string
  }): Promise<R> {
    const directory = Filesystem.resolve(input.directory)
    const closed = closing.has(lexKey(directory))
    let existing = cache.get(directory)
    if (!existing && input.create !== false && !closed) {
      Log.Default.info("creating instance", { directory })
      existing = track(
        directory,
        boot({
          directory,
          init: input.init,
          project: input.project,
          worktree: input.worktree,
        }),
      )
    }
    if (!existing) {
      // A closed directory is being torn down; never fall back to another
      // instance or requests would silently run in the wrong directory.
      if (input.create === false || closed) {
        const info = ProjectIdentity.resolve(directory)
        const browseCtx: Shape = {
          directory,
          worktree: info.sandbox,
          project: {
            id: info.id,
            worktree: info.root,
            vcs: info.vcs,
            sandboxes: [],
            time: { created: Date.now(), updated: Date.now() },
          },
        }
        return context.provide(browseCtx, async () => input.fn())
      }
      throw new Error(`no instance for directory ${directory}`)
    }
    const ctx = await existing
    return context.provide(ctx, async () => {
      return input.fn()
    })
  },
  has(directory: string) {
    return cache.has(Filesystem.resolve(directory))
  },
  /**
   * Mark a directory as being torn down so concurrent requests cannot lazily
   * re-create its instance (e.g. while a worktree is being removed).
   */
  beginClose(directory: string) {
    const lexical = lexNorm(directory)
    const real = lexKey(Filesystem.resolve(directory))
    closing.set(lexical, real)
    if (real !== lexical) closing.set(real, real)
  },
  endClose(directory: string) {
    const lexical = lexNorm(directory)
    const real = closing.get(lexical)
    if (real !== undefined) closing.delete(real)
    closing.delete(lexical)
  },
  get current() {
    return context.use()
  },
  get maybe() {
    try {
      return context.use()
    } catch {
      return undefined
    }
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },
  dirs() {
    return [...cache.keys()]
  },
  /**
   * Check if a path is within the project boundary.
   * Returns true if path is inside Instance.directory OR Instance.worktree.
   * Paths within the worktree but outside the working directory should not trigger external_directory permission.
   */
  containsPath(filepath: string) {
    if (Filesystem.contains(Instance.directory, filepath)) return true
    // Non-git projects set worktree to "/" which would match ANY absolute path.
    // Skip worktree check in this case to preserve external_directory permissions.
    if (Instance.worktree === "/") return false
    return Filesystem.contains(Instance.worktree, filepath)
  },
  /**
   * Captures the current instance ALS context and returns a wrapper that
   * restores it when called. Use this for callbacks that fire outside the
   * instance async context (native addons, event emitters, timers, etc.).
   */
  bind<F extends (...args: any[]) => any>(fn: F): F {
    const ctx = context.use()
    return ((...args: any[]) => context.provide(ctx, () => fn(...args))) as F
  },
  state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): State.StateFn<S> {
    return State.create(() => Instance.directory, init, dispose)
  },
  /**
   * Swap the project info of the live instance in place. Readers of
   * Instance.project see the new value immediately and nothing is disposed,
   * so running sessions are unaffected. Must be called inside the instance
   * context.
   */
  setProject(project: Project.Info) {
    const ctx = context.use()
    Log.Default.info("updating instance project", { directory: ctx.directory, vcs: project.vcs })
    ctx.project = project
  },
  async reload(input: { directory: string; init?: () => Promise<any>; project?: Project.Info; worktree?: string }) {
    const directory = Filesystem.resolve(input.directory)
    Log.Default.info("reloading instance", { directory })
    await Promise.all([State.dispose(directory), disposeInstance(directory)])
    cache.delete(directory)
    const next = track(directory, boot({ ...input, directory }))
    emit(directory)
    return await next
  },
  async dispose() {
    const directory = Instance.directory
    const projectId = Instance.project.id
    Log.Default.info("disposing instance", { directory })
    try {
      await Promise.all([State.dispose(directory), disposeInstance(directory)])
    } catch (e) {
      Log.Default.error("instance dispose failed", { directory, error: e instanceof Error ? e.message : e })
    }
    Database.detach(projectId)
    cache.delete(directory)
    ActiveInstance.forceDeactivate(directory)
    emit(directory)
  },
  async disposeDirectory(directory: string) {
    const dir = Filesystem.resolve(directory)
    const entry = cache.get(dir)
    if (!entry) return
    const ctx = await entry.catch(() => undefined)
    if (!ctx) {
      if (cache.get(dir) === entry) cache.delete(dir)
      return
    }
    Log.Default.info("disposing instance by directory", { directory: dir })
    try {
      await Promise.all([State.dispose(dir), disposeInstance(dir)])
    } catch (e) {
      Log.Default.error("instance dispose failed", { directory: dir, error: e instanceof Error ? e.message : e })
    }
    Database.detach(ctx.project.id)
    if (cache.get(dir) === entry) cache.delete(dir)
    ActiveInstance.forceDeactivate(dir)
    emit(dir)
  },
  async disposeAll() {
    if (disposal.all) return disposal.all

    disposal.all = iife(async () => {
      Log.Default.info("disposing all instances")
      const entries = [...cache.entries()]
      for (const [key, value] of entries) {
        if (cache.get(key) !== value) continue

        const ctx = await value.catch((error) => {
          Log.Default.warn("instance dispose failed", { key, error })
          return undefined
        })

        if (!ctx) {
          if (cache.get(key) === value) cache.delete(key)
          continue
        }

        if (cache.get(key) !== value) continue

        await context.provide(ctx, async () => {
          await Instance.dispose()
        })
      }
    }).finally(() => {
      disposal.all = undefined
    })

    return disposal.all
  },
}
