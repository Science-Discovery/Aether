import z from "zod"
import { Database, desc, eq } from "../storage/db"
import { ProjectRecentTable } from "./project.sql"
import { GlobalProjectMapTable } from "./global-project-map.sql"
import { ProjectTable } from "./project.sql"
import { SessionTable } from "../session/session.sql"
import { Log } from "../util/log"
import { Flag } from "@/flag/flag"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { which } from "../util/which"
import { ProjectID } from "./schema"
import { Effect, Layer, Path, Scope, ServiceMap, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { makeRuntime } from "@/effect/run-service"
import { AppFileSystem } from "@/filesystem"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { existsSync } from "fs"
import { Database as BunSqlite } from "bun:sqlite"

export namespace Project {
  const log = Log.create({ service: "project" })

  export const Info = z
    .object({
      id: ProjectID.zod,
      worktree: z.string(),
      vcs: z.literal("git").optional(),
      name: z.string().optional(),
      icon: z
        .object({
          url: z.string().optional(),
          override: z.string().optional(),
          color: z.string().optional(),
        })
        .optional(),
      commands: z
        .object({
          start: z.string().optional().describe("Startup script to run when creating a new workspace (worktree)"),
        })
        .optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        initialized: z.number().optional(),
      }),
      sandboxes: z.array(z.string()),
    })
    .meta({
      ref: "Project",
    })
  export type Info = z.infer<typeof Info>

  export const RecentInfo = z
    .object({
      id: z.string(),
      kind: z.enum(["project", "directory"]),
      projectID: ProjectID.zod.optional(),
      directory: z.string(),
      worktree: z.string().optional(),
      vcs: z.literal("git").optional(),
      name: z.string().optional(),
      icon: Info.shape.icon.optional(),
      commands: Info.shape.commands.optional(),
      time: z.object({
        activity: z.number(),
        created: z.number().optional(),
        updated: z.number().optional(),
      }),
    })
    .meta({
      ref: "ProjectRecent",
    })
  export type RecentInfo = z.infer<typeof RecentInfo>

  export const Event = {
    Updated: BusEvent.define("project.updated", Info),
    RecentUpdated: BusEvent.define("project.recent.updated", z.object({})),
  }

  type Row = typeof ProjectTable.$inferSelect

  function norm(input: string) {
    const next = input.replace(/\\/g, "/")
    const trim = /^\/+$/g.test(next) ? "/" : next.replace(/\/+$/, "")
    return trim.toLowerCase()
  }

  function name(input: string) {
    return input.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || input
  }

  function dirKey(input: string) {
    return `dir:${norm(input)}`
  }

  function skipDir(input: string) {
    if (!input) return true
    const next = norm(input)
    if (next === "/" || next === "\\") return true
    return ["/bin", "/dist", "\\bin", "\\dist"].some((item) => next.endsWith(item))
  }

  function rowIcon(row: { icon_url?: string | null; icon_color?: string | null }) {
    if (!row.icon_url && !row.icon_color) return
    return {
      url: row.icon_url ?? undefined,
      color: row.icon_color ?? undefined,
    } satisfies Info["icon"]
  }

  function rowCommands(row: { commands?: string | { start?: string } | null }) {
    if (!row.commands) return
    if (typeof row.commands === "string") return JSON.parse(row.commands) as Info["commands"]
    return row.commands
  }

  function canonical() {
    const recentRows = Database.use((db) =>
      db.select().from(ProjectRecentTable).where(eq(ProjectRecentTable.kind, "project")).all(),
    )
    const result: Info[] = []
    for (const row of recentRows) {
      if (!row.project_id) continue
      const projectRow = Database.useProject(row.project_id, (d) =>
        d.select().from(ProjectTable).where(eq(ProjectTable.id, row.project_id!)).get(),
      )
      if (projectRow) result.push(fromRow(projectRow))
    }
    return result.sort((a, b) => a.id.localeCompare(b.id))
  }
  function recent() {
    const recentRows = Database.use((d) =>
      d.select().from(ProjectRecentTable).orderBy(desc(ProjectRecentTable.activity_at)).all(),
    )
    return recentRows
      .map((row) => {
        if (row.kind === "project" && row.project_id) {
          const projectRow = Database.useProject(row.project_id, (d) =>
            d.select().from(ProjectTable).where(eq(ProjectTable.id, row.project_id!)).get(),
          )
          const known = projectRow ? fromRow(projectRow) : undefined
          const icon = (() => {
            const base = known?.icon
            const override = row.icon_override ?? undefined
            if (base && override) return { ...base, override }
            if (override) return { override }
            return base
          })()
          return {
            id: row.key,
            kind: "project" as const,
            projectID: row.project_id,
            directory: row.directory,
            worktree: known?.worktree,
            vcs: known?.vcs,
            name: row.name ?? known?.name ?? name(row.directory),
            icon,
            commands: known?.commands,
            time: {
              activity: row.activity_at,
              created: row.time_created,
              updated: row.time_updated,
            },
          }
        }
        const baseIcon =
          row.icon_url || row.icon_color
            ? rowIcon({ icon_url: row.icon_url ?? null, icon_color: row.icon_color ?? null })
            : undefined
        const icon = baseIcon
          ? { ...baseIcon, override: row.icon_override ?? undefined }
          : row.icon_override
            ? { override: row.icon_override }
            : undefined
        return {
          id: row.key,
          kind: "directory" as const,
          directory: row.directory,
          name: row.name ?? name(row.directory),
          icon,
          time: { activity: row.activity_at, created: row.time_created, updated: row.time_updated },
        }
      })
      .filter((item) => !skipDir(item.directory))
  }

  export function fromRow(row: Row): Info {
    return {
      id: row.id,
      worktree: row.worktree,
      vcs: row.vcs ? Info.shape.vcs.parse(row.vcs) : undefined,
      name: row.name ?? undefined,
      icon: rowIcon(row),
      time: {
        created: row.time_created,
        updated: row.time_updated,
        initialized: row.time_initialized ?? undefined,
      },
      sandboxes: row.sandboxes,
      commands: rowCommands(row),
    }
  }

  export const UpdateInput = z.object({
    projectID: ProjectID.zod,
    name: z.string().optional(),
    icon: Info.shape.icon.optional(),
    commands: Info.shape.commands.optional(),
  })
  export type UpdateInput = z.infer<typeof UpdateInput>

  // ---------------------------------------------------------------------------
  // Effect service
  // ---------------------------------------------------------------------------

  export interface Interface {
    readonly fromDirectory: (directory: string) => Effect.Effect<{ project: Info; sandbox: string }>
    readonly discover: (input: Info) => Effect.Effect<void>
    readonly list: () => Effect.Effect<Info[]>
    readonly recent: () => Effect.Effect<RecentInfo[]>
    readonly get: (id: ProjectID) => Effect.Effect<Info | undefined>
    readonly update: (input: UpdateInput) => Effect.Effect<Info>
    readonly updateDirectoryMeta: (input: {
      directory: string
      name?: string
      icon?: { url?: string; color?: string }
    }) => Effect.Effect<void>
    readonly initGit: (input: { directory: string; project: Info }) => Effect.Effect<Info>
    readonly setInitialized: (id: ProjectID) => Effect.Effect<void>
    readonly sandboxes: (id: ProjectID) => Effect.Effect<string[]>
    readonly addSandbox: (id: ProjectID, directory: string) => Effect.Effect<void>
    readonly removeSandbox: (id: ProjectID, directory: string) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Project") {}

  type GitResult = { code: number; text: string; stderr: string }

  export const layer: Layer.Layer<
    Service,
    never,
    AppFileSystem.Service | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fsys = yield* AppFileSystem.Service
      const pathSvc = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const git = Effect.fnUntraced(
        function* (args: string[], opts?: { cwd?: string }) {
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const [text, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode
          return { code, text, stderr } satisfies GitResult
        },
        Effect.scoped,
        Effect.catch(() => Effect.succeed({ code: 1, text: "", stderr: "" } satisfies GitResult)),
      )

      const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
        Effect.sync(() => Database.use(fn))

      const dbProject = <T>(pid: ProjectID, fn: (d: Database.TxOrDb) => T) =>
        Effect.sync(() => Database.useProject(pid, fn))

      const emitUpdated = (data: Info) =>
        Effect.sync(() =>
          GlobalBus.emit("event", {
            payload: { type: Event.Updated.type, properties: data },
          }),
        )

      const emitRecentUpdated = Effect.sync(() =>
        GlobalBus.emit("event", {
          payload: { type: Event.RecentUpdated.type, properties: {} },
        }),
      )

      const fakeVcs = Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS)

      const resolveGitPath = (cwd: string, name: string) => {
        if (!name) return cwd
        name = name.replace(/[\r\n]+$/, "")
        if (!name) return cwd
        name = AppFileSystem.windowsPath(name)
        if (pathSvc.isAbsolute(name)) return pathSvc.normalize(name)
        return pathSvc.resolve(cwd, name)
      }

      const scope = yield* Scope.Scope

      const readCachedProjectId = Effect.fnUntraced(function* (dir: string) {
        return yield* fsys.readFileString(pathSvc.join(dir, "opencode")).pipe(
          Effect.map((x) => x.trim()),
          Effect.map(ProjectID.make),
          Effect.catch(() => Effect.succeed(undefined)),
        )
      })

      const touch = Effect.fn("Project.touch")(function* (input: { project: Info; directory: string }) {
        const now = Date.now()
        const isProject = input.project.worktree !== "/"
        const key = dirKey(norm(input.directory))
        const kind = isProject ? "project" : "directory"
        const directory = input.directory

        yield* db((d) =>
          d
            .insert(ProjectRecentTable)
            .values({
              key,
              kind,
              project_id: isProject ? input.project.id : null,
              directory,
              activity_at: now,
              time_created: now,
              time_updated: now,
            })
            .onConflictDoUpdate({
              target: ProjectRecentTable.key,
              set: {
                kind,
                project_id: isProject ? input.project.id : null,
                directory,
                activity_at: now,
                time_updated: now,
              },
            })
            .run(),
        )
        yield* emitRecentUpdated
      })

      const fromDirectory = Effect.fn("Project.fromDirectory")(function* (directory: string) {
        log.info("fromDirectory", { directory })

        // Phase 1: discover git info
        type DiscoveryResult = { id: ProjectID; worktree: string; sandbox: string; vcs: Info["vcs"] }

        const data: DiscoveryResult = yield* Effect.gen(function* () {
          const dotgitMatches = yield* fsys.up({ targets: [".git"], start: directory }).pipe(Effect.orDie)
          const dotgit = dotgitMatches[0]

          if (!dotgit) {
            const dirNorm = norm(directory)
            const mapRow = yield* db((d) =>
              d.select().from(GlobalProjectMapTable).where(eq(GlobalProjectMapTable.directory, dirNorm)).get(),
            )
            const id = mapRow?.project_id ?? ProjectID.fromDirectory(dirNorm)
            return {
              id,
              worktree: "/",
              sandbox: "/",
              vcs: fakeVcs,
            }
          }

          let sandbox = pathSvc.dirname(dotgit)
          const gitBinary = yield* Effect.sync(() => which("git"))
          let id = yield* readCachedProjectId(dotgit)

          if (!gitBinary) {
            const dirNorm = norm(directory)
            const mapRow = id
              ? undefined
              : yield* db((d) =>
                  d.select().from(GlobalProjectMapTable).where(eq(GlobalProjectMapTable.directory, dirNorm)).get(),
                )
            return {
              id: id ?? mapRow?.project_id ?? ProjectID.fromDirectory(dirNorm),
              worktree: sandbox,
              sandbox,
              vcs: fakeVcs,
            }
          }

          const commonDir = yield* git(["rev-parse", "--git-common-dir"], { cwd: sandbox })
          if (commonDir.code !== 0) {
            const dirNorm = norm(directory)
            const mapRow = id
              ? undefined
              : yield* db((d) =>
                  d.select().from(GlobalProjectMapTable).where(eq(GlobalProjectMapTable.directory, dirNorm)).get(),
                )
            return {
              id: id ?? mapRow?.project_id ?? ProjectID.fromDirectory(dirNorm),
              worktree: sandbox,
              sandbox,
              vcs: fakeVcs,
            }
          }
          const worktree = (() => {
            const common = resolveGitPath(sandbox, commonDir.text.trim())
            return common === sandbox ? sandbox : pathSvc.dirname(common)
          })()

          if (id == null) {
            id = yield* readCachedProjectId(pathSvc.join(worktree, ".git"))
          }

          if (!id) {
            const revList = yield* git(["rev-list", "--max-parents=0", "HEAD"], { cwd: sandbox })
            const roots = revList.text
              .split("\n")
              .filter(Boolean)
              .map((x) => x.trim())
              .toSorted()

            id = roots[0] ? ProjectID.make(roots[0]) : undefined
            if (id) {
              yield* fsys.writeFileString(pathSvc.join(worktree, ".git", "opencode"), id).pipe(Effect.ignore)
            }
          }

          if (!id) {
            const dirNorm = norm(directory)
            const mapRow = yield* db((d) =>
              d.select().from(GlobalProjectMapTable).where(eq(GlobalProjectMapTable.directory, dirNorm)).get(),
            )
            return {
              id: mapRow?.project_id ?? ProjectID.fromDirectory(dirNorm),
              worktree: sandbox,
              sandbox,
              vcs: "git" as const,
            }
          }

          const topLevel = yield* git(["rev-parse", "--show-toplevel"], { cwd: sandbox })
          if (topLevel.code !== 0) {
            return {
              id,
              worktree: sandbox,
              sandbox,
              vcs: fakeVcs,
            }
          }
          sandbox = resolveGitPath(sandbox, topLevel.text.trim())

          return { id, sandbox, worktree, vcs: "git" as const }
        })

        // Phase 2: upsert
        const row = yield* dbProject(data.id, (d) =>
          d.select().from(ProjectTable).where(eq(ProjectTable.id, data.id)).get(),
        )
        const existing = row
          ? fromRow(row)
          : {
              id: data.id,
              worktree: data.worktree,
              vcs: data.vcs,
              sandboxes: [] as string[],
              time: { created: Date.now(), updated: Date.now() },
            }

        if (Flag.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY)
          yield* discover(existing).pipe(Effect.ignore, Effect.forkIn(scope))

        const result: Info = {
          ...existing,
          worktree: data.worktree,
          vcs: data.vcs,
          time: { ...existing.time, updated: Date.now() },
        }
        if (data.sandbox !== result.worktree && !result.sandboxes.includes(data.sandbox))
          result.sandboxes.push(data.sandbox)
        result.sandboxes = yield* Effect.forEach(
          result.sandboxes,
          (s) =>
            fsys.exists(s).pipe(
              Effect.orDie,
              Effect.map((exists) => (exists ? s : undefined)),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))

        yield* dbProject(data.id, (d) =>
          d
            .insert(ProjectTable)
            .values({
              id: result.id,
              worktree: result.worktree,
              vcs: result.vcs ?? null,
              name: result.name,
              icon_url: result.icon?.url,
              icon_color: result.icon?.color,
              time_created: result.time.created,
              time_updated: result.time.updated,
              time_initialized: result.time.initialized,
              sandboxes: result.sandboxes,
              commands: result.commands,
            })
            .onConflictDoUpdate({
              target: ProjectTable.id,
              set: {
                worktree: result.worktree,
                vcs: result.vcs ?? null,
                name: result.name,
                icon_url: result.icon?.url,
                icon_color: result.icon?.color,
                time_updated: result.time.updated,
                time_initialized: result.time.initialized,
                sandboxes: result.sandboxes,
                commands: result.commands,
              },
            })
            .run(),
        )

        if (data.worktree !== "/") {
          const recentKey = dirKey(data.worktree)
          const recentRow = yield* db((d) =>
            d.select().from(ProjectRecentTable).where(eq(ProjectRecentTable.key, recentKey)).get(),
          )
          if (recentRow) {
            const patch: Record<string, any> = {}
            if (recentRow.icon_url && !result.icon?.url) patch.icon_url = recentRow.icon_url
            if (recentRow.icon_color && !result.icon?.color) patch.icon_color = recentRow.icon_color
            if (Object.keys(patch).length) {
              yield* dbProject(data.id, (d) =>
                d.update(ProjectTable).set(patch).where(eq(ProjectTable.id, data.id)).run(),
              )
              result.icon = { url: patch.icon_url ?? result.icon?.url, color: patch.icon_color ?? result.icon?.color }
            }
            yield* db((d) =>
              d
                .update(ProjectRecentTable)
                .set({ icon_url: null, icon_color: null })
                .where(eq(ProjectRecentTable.key, recentKey))
                .run(),
            )
          }
        }

        if (data.vcs !== "git" || data.worktree === "/") {
          const dirNorm = norm(directory)
          yield* db((d) =>
            d
              .insert(GlobalProjectMapTable)
              .values({
                directory: dirNorm,
                project_id: result.id,
                time_created: Date.now(),
                time_updated: Date.now(),
              })
              .onConflictDoUpdate({
                target: GlobalProjectMapTable.directory,
                set: { project_id: result.id, time_updated: Date.now() },
              })
              .run(),
          )
        }

        yield* emitUpdated(result)
        const touchDir = data.worktree !== "/" ? data.worktree : directory
        yield* touch({ project: result, directory: touchDir })
        return { project: result, sandbox: data.sandbox }
      })

      const discover = Effect.fn("Project.discover")(function* (input: Info) {
        if (input.vcs !== "git") return
        if (input.icon?.override) return
        if (input.icon?.url) return

        const matches = yield* fsys
          .glob("**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
            cwd: input.worktree,
            absolute: true,
            include: "file",
          })
          .pipe(Effect.orDie)
        const shortest = matches.sort((a, b) => a.length - b.length)[0]
        if (!shortest) return

        const buffer = yield* fsys.readFile(shortest).pipe(Effect.orDie)
        const base64 = Buffer.from(buffer).toString("base64")
        const mime = AppFileSystem.mimeType(shortest)
        const url = `data:${mime};base64,${base64}`
        yield* update({ projectID: input.id, icon: { url } })
      })

      const list = Effect.fn("Project.list")(function* () {
        return yield* Effect.sync(canonical)
      })

      const recentList = Effect.fn("Project.recent")(function* () {
        return yield* Effect.sync(recent)
      })

      const get = Effect.fn("Project.get")(function* (id: ProjectID) {
        const row = yield* dbProject(id, (d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
        return row ? fromRow(row) : undefined
      })

      const update = Effect.fn("Project.update")(function* (input: UpdateInput) {
        const result = yield* dbProject(input.projectID, (d) =>
          d
            .update(ProjectTable)
            .set({
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.icon ? { icon_url: input.icon.url, icon_color: input.icon.color } : {}),
              ...(input.commands !== undefined ? { commands: input.commands } : {}),
              time_updated: Date.now(),
            })
            .where(eq(ProjectTable.id, input.projectID))
            .returning()
            .get(),
        )
        if (!result) throw new Error(`Project not found: ${input.projectID}`)
        const data = fromRow(result)
        yield* emitUpdated(data)
        return data
      })

      const initGit = Effect.fn("Project.initGit")(function* (input: { directory: string; project: Info }) {
        if (input.project.vcs === "git") return input.project
        if (!(yield* Effect.sync(() => which("git")))) throw new Error("Git is not installed")
        const result = yield* git(["init", "--quiet"], { cwd: input.directory })
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || result.text.trim() || "Failed to initialize git repository")
        }
        const { project } = yield* fromDirectory(input.directory)
        return project
      })

      const setInitialized = Effect.fn("Project.setInitialized")(function* (id: ProjectID) {
        yield* dbProject(id, (d) =>
          d.update(ProjectTable).set({ time_initialized: Date.now() }).where(eq(ProjectTable.id, id)).run(),
        )
      })

      const sandboxes = Effect.fn("Project.sandboxes")(function* (id: ProjectID) {
        const row = yield* dbProject(id, (d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
        if (!row) return []
        const data = fromRow(row)
        return yield* Effect.forEach(
          data.sandboxes,
          (dir) =>
            fsys.isDir(dir).pipe(
              Effect.orDie,
              Effect.map((ok) => (ok ? dir : undefined)),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))
      })

      const addSandbox = Effect.fn("Project.addSandbox")(function* (id: ProjectID, directory: string) {
        const row = yield* dbProject(id, (d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
        if (!row) throw new Error(`Project not found: ${id}`)
        const sboxes = [...row.sandboxes]
        if (!sboxes.includes(directory)) sboxes.push(directory)
        const result = yield* dbProject(id, (d) =>
          d
            .update(ProjectTable)
            .set({ sandboxes: sboxes, time_updated: Date.now() })
            .where(eq(ProjectTable.id, id))
            .returning()
            .get(),
        )
        if (!result) throw new Error(`Project not found: ${id}`)
        yield* emitUpdated(fromRow(result))
      })

      const removeSandbox = Effect.fn("Project.removeSandbox")(function* (id: ProjectID, directory: string) {
        const row = yield* dbProject(id, (d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
        if (!row) throw new Error(`Project not found: ${id}`)
        const sboxes = row.sandboxes.filter((s) => s !== directory)
        const result = yield* dbProject(id, (d) =>
          d
            .update(ProjectTable)
            .set({ sandboxes: sboxes, time_updated: Date.now() })
            .where(eq(ProjectTable.id, id))
            .returning()
            .get(),
        )
        if (!result) throw new Error(`Project not found: ${id}`)
        yield* emitUpdated(fromRow(result))
      })

      const updateDirectoryMeta = Effect.fn("Project.updateDirectoryMeta")(function* (input: {
        directory: string
        name?: string
        icon?: { url?: string; color?: string; override?: string }
      }) {
        const dir = norm(input.directory)
        const key = dirKey(dir)
        yield* db((d) =>
          d
            .insert(ProjectRecentTable)
            .values({
              key,
              kind: "directory",
              project_id: null,
              directory: input.directory,
              name: input.name ?? name(input.directory),
              icon_url: input.icon?.url ?? null,
              icon_color: input.icon?.color ?? null,
              icon_override: input.icon?.override ?? null,
              activity_at: Date.now(),
              time_created: Date.now(),
              time_updated: Date.now(),
            })
            .onConflictDoUpdate({
              target: ProjectRecentTable.key,
              set: {
                name: input.name ?? name(input.directory),
                icon_url: input.icon?.url ?? null,
                icon_color: input.icon?.color ?? null,
                icon_override: input.icon?.override ?? null,
                time_updated: Date.now(),
              },
            })
            .run(),
        )
        yield* emitRecentUpdated
      })

      return Service.of({
        fromDirectory,
        discover,
        list,
        recent: recentList,
        get,
        update,
        updateDirectoryMeta,
        initGit,
        setInitialized,
        sandboxes,
        addSandbox,
        removeSandbox,
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(CrossSpawnSpawner.layer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  )
  const { runPromise } = makeRuntime(Service, defaultLayer)

  // ---------------------------------------------------------------------------
  // Promise-based API (delegates to Effect service via runPromise)
  // ---------------------------------------------------------------------------

  export function fromDirectory(directory: string) {
    return runPromise((svc) => svc.fromDirectory(directory))
  }

  export function discover(input: Info) {
    return runPromise((svc) => svc.discover(input))
  }

  export function list() {
    return canonical()
  }

  export function recentList() {
    return recent()
  }

  export function directories(): string[] {
    return [...new Set(recentList().map((item) => item.directory))]
  }

  export function get(id: ProjectID): Info | undefined {
    const row = Database.useProject(id, (db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
    if (!row) return undefined
    return fromRow(row)
  }

  export function setInitialized(id: ProjectID) {
    Database.useProject(id, (db) =>
      db.update(ProjectTable).set({ time_initialized: Date.now() }).where(eq(ProjectTable.id, id)).run(),
    )
  }

  export function initGit(input: { directory: string; project: Info }) {
    return runPromise((svc) => svc.initGit(input))
  }

  export function update(input: UpdateInput) {
    return runPromise((svc) => svc.update(input))
  }

  export function updateDirectoryMeta(input: {
    directory: string
    name?: string
    icon?: { url?: string; color?: string }
  }) {
    return runPromise((svc) => svc.updateDirectoryMeta(input))
  }

  export function sandboxes(id: ProjectID) {
    return runPromise((svc) => svc.sandboxes(id))
  }

  export function addSandbox(id: ProjectID, directory: string) {
    return runPromise((svc) => svc.addSandbox(id, directory))
  }

  export function removeSandbox(id: ProjectID, directory: string) {
    return runPromise((svc) => svc.removeSandbox(id, directory))
  }

  export function sessionCount(id: ProjectID): number {
    const dbPath = Database.projectPath(id)
    if (!existsSync(dbPath)) return 0
    const raw = new BunSqlite(dbPath)
    const row = raw.prepare("SELECT count(*) as cnt FROM session").get() as any
    raw.close()
    return row?.cnt ?? 0
  }

  export const RemoveResult = z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), projectID: ProjectID.zod }),
    z.object({
      status: z.literal("has_sessions"),
      projectID: ProjectID.zod,
      sessionCount: z.number(),
    }),
  ])
  export type RemoveResult = z.infer<typeof RemoveResult>

  export function remove(id: ProjectID): RemoveResult {
    const cnt = sessionCount(id)
    if (cnt > 0) {
      return { status: "has_sessions", projectID: id, sessionCount: cnt }
    }

    Database.detach(id)

    const dbPath = Database.projectPath(id)
    if (existsSync(dbPath)) {
      const raw = new BunSqlite(dbPath)
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
      for (const t of tables) {
        raw.prepare(`DELETE FROM "${t.name}"`).run()
      }
      raw.prepare("VACUUM").run()
      raw.close()
    }

    Database.use((db) => {
      db.delete(GlobalProjectMapTable).where(eq(GlobalProjectMapTable.project_id, id)).run()
      db.delete(ProjectRecentTable).where(eq(ProjectRecentTable.project_id, id)).run()
    })

    log.info("removed project", { projectID: id })
    return { status: "ok", projectID: id }
  }
}
