import z from "zod"
import { and, Database, eq } from "../storage/db"
import { ProjectRecentTable, ProjectTable } from "./project.sql"
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
import { Hash } from "@/util/hash"

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
  type RecentRow = {
    kind: string | null
    project_id: string | null
    directory: string | null
    activity_at: number | null
    worktree: string | null
    vcs: string | null
    name: string | null
    icon_url: string | null
    icon_color: string | null
    time_created: number | null
    time_updated: number | null
    commands: string | null
  }

  type RecentEntry = {
    id: string
    kind: "project" | "directory"
    projectID?: ProjectID
    directory: string
    worktree?: string
    vcs?: Info["vcs"]
    name?: string
    icon?: Info["icon"]
    commands?: Info["commands"]
    time: RecentInfo["time"]
  }

  function norm(input: string) {
    const next = input.replace(/\\/g, "/")
    const trim = /^\/+$/g.test(next) ? "/" : next.replace(/\/+$/, "")
    if (/^[A-Za-z]:/.test(trim)) return trim[0].toLowerCase() + trim.slice(1)
    return trim
  }

  function name(input: string) {
    return input.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || input
  }

  function dirID(input: string) {
    return `dir:${Hash.fast(norm(input))}`
  }

  function dirKey(input: string) {
    return `dir:${norm(input)}`
  }

  function projectKey(id: string) {
    return `project:${id}`
  }

  function skipDir(input: string) {
    if (!input) return true
    const next = norm(input)
    if (next === "/" || next === "\\") return true
    return ["/bin", "/dist", "\\bin", "\\dist"].some((item) => next.endsWith(item))
  }

  function rowIcon(row: {
    icon_url?: string | null
    icon_color?: string | null
  }) {
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
    return Database.use((db) => db.select().from(ProjectTable).all())
      .map(fromRow)
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  function rawRecent(client: { prepare: (sql: string) => { all: () => unknown[]; get: () => unknown } }) {
    const hasRecent = client
      .prepare(`select 1 as ok from sqlite_master where type = 'table' and name = 'project_recent'`)
      .get() as { ok?: number } | undefined
    if (hasRecent?.ok) {
      return client.prepare(
        `select
          r.kind as kind,
          r.project_id as project_id,
          r.directory as directory,
          r.activity_at as activity_at,
          p.worktree as worktree,
          p.vcs as vcs,
          p.name as name,
          p.icon_url as icon_url,
          p.icon_color as icon_color,
          p.time_created as time_created,
          p.time_updated as time_updated,
          p.commands as commands
        from project_recent r
        left join project p on p.id = r.project_id`,
      ).all() as RecentRow[]
    }

    const ps = client.prepare(
      `select
        'project' as kind,
        p.id as project_id,
        p.worktree as directory,
        max(coalesce(p.time_updated, 0), coalesce(p.time_created, 0), coalesce(s.time_updated, 0)) as activity_at,
        p.worktree as worktree,
        p.vcs as vcs,
        p.name as name,
        p.icon_url as icon_url,
        p.icon_color as icon_color,
        p.time_created as time_created,
        p.time_updated as time_updated,
        p.commands as commands
      from project p
      left join (
        select directory, max(time_updated) as time_updated
        from session
        where directory is not null and directory != '/'
        group by directory
      ) s on s.directory = p.worktree
      where p.worktree is not null and p.worktree != '/'`,
    ).all() as RecentRow[]
    const ss = client.prepare(
      `select
        'directory' as kind,
        null as project_id,
        directory as directory,
        max(time_updated) as activity_at,
        null as worktree,
        null as vcs,
        null as name,
        null as icon_url,
        null as icon_color,
        null as time_created,
        null as time_updated,
        null as commands
      from session
      where directory is not null and directory != '/'
      group by directory`,
    ).all() as RecentRow[]
    return [...ps, ...ss]
  }

  function addRecent(map: Map<string, RecentEntry>, next: RecentEntry) {
    const prev = map.get(next.id)
    if (!prev) {
      map.set(next.id, next)
      return
    }
    const lead = next.time.activity >= prev.time.activity ? next : prev
    const tail = lead === next ? prev : next
    map.set(next.id, {
      id: next.id,
      kind: prev.kind === "project" || next.kind === "project" ? "project" : "directory",
      projectID: lead.projectID ?? tail.projectID,
      directory: lead.directory || tail.directory,
      worktree: lead.worktree ?? tail.worktree,
      vcs: lead.vcs ?? tail.vcs,
      name: lead.name ?? tail.name,
      icon: lead.icon ?? tail.icon,
      commands: lead.commands ?? tail.commands,
      time: {
        activity: Math.max(prev.time.activity, next.time.activity),
        created: lead.time.created ?? tail.time.created,
        updated: lead.time.updated ?? tail.time.updated,
      },
    })
  }

  function recent() {
    const canon = canonical()
    const byId = new Map(canon.map((item) => [item.id, item] as const))
    const byDir = new Map<string, Info>()
    for (const item of canon) {
      if (item.worktree) byDir.set(norm(item.worktree), item)
      for (const sandbox of item.sandboxes) byDir.set(norm(sandbox), item)
    }

    const map = new Map<string, RecentEntry>()
    const read = (client: { prepare: (sql: string) => { all: () => unknown[]; get: () => unknown } }) => {
      for (const row of rawRecent(client)) {
        const dir = row.directory ?? row.worktree ?? undefined
        if (!dir || skipDir(dir)) continue
        const known = (row.project_id && byId.get(ProjectID.make(row.project_id))) ?? byDir.get(norm(dir))
        if (known && known.id !== ProjectID.global) {
          addRecent(map, {
            id: projectKey(known.id),
            kind: "project",
            projectID: known.id,
            directory: known.worktree,
            worktree: known.worktree,
            vcs: known.vcs,
            name: known.name ?? name(known.worktree),
            icon: known.icon,
            commands: known.commands,
            time: {
              activity: row.activity_at ?? 0,
              created: known.time.created,
              updated: known.time.updated,
            },
          })
          continue
        }

        if (row.project_id && row.project_id !== ProjectID.global && row.worktree && !skipDir(row.worktree)) {
          addRecent(map, {
            id: projectKey(row.project_id),
            kind: "project",
            projectID: ProjectID.make(row.project_id),
            directory: row.worktree,
            worktree: row.worktree,
            vcs: row.vcs ? Info.shape.vcs.parse(row.vcs) : undefined,
            name: row.name ?? name(row.worktree),
            icon: rowIcon(row),
            commands: rowCommands(row),
            time: {
              activity: row.activity_at ?? 0,
              created: row.time_created ?? undefined,
              updated: row.time_updated ?? undefined,
            },
          })
          continue
        }

        addRecent(map, {
          id: dirID(dir),
          kind: "directory",
          directory: dir,
          name: row.name ?? name(dir),
          time: {
            activity: row.activity_at ?? 0,
          },
        })
      }
    }

    Database.withSources((source) => {
      try {
        read(source.client)
      } catch (error) {
        log.warn("recent scan failed", { path: source.path, current: source.current, error })
      }
    })

    return [...map.values()]
      .sort((a, b) => b.time.activity - a.time.activity || a.directory.localeCompare(b.directory))
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        projectID: item.projectID,
        directory: item.directory,
        worktree: item.worktree,
        vcs: item.vcs,
        name: item.name,
        icon: item.icon,
        commands: item.commands,
        time: item.time,
      }))
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
        const isProject = input.project.id !== ProjectID.global && input.project.worktree !== "/"
        const key = isProject ? projectKey(input.project.id) : dirKey(input.directory)
        const kind = isProject ? "project" : "directory"
        const directory = isProject ? input.project.worktree : input.directory

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
            return {
              id: ProjectID.global,
              worktree: "/",
              sandbox: "/",
              vcs: fakeVcs,
            }
          }

          let sandbox = pathSvc.dirname(dotgit)
          const gitBinary = yield* Effect.sync(() => which("git"))
          let id = yield* readCachedProjectId(dotgit)

          if (!gitBinary) {
            return {
              id: id ?? ProjectID.global,
              worktree: sandbox,
              sandbox,
              vcs: fakeVcs,
            }
          }

          const commonDir = yield* git(["rev-parse", "--git-common-dir"], { cwd: sandbox })
          if (commonDir.code !== 0) {
            return {
              id: id ?? ProjectID.global,
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
            return { id: ProjectID.global, worktree: sandbox, sandbox, vcs: "git" as const }
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
        const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, data.id)).get())
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

        yield* db((d) =>
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

        if (data.id !== ProjectID.global) {
          yield* db((d) =>
            d
              .update(SessionTable)
              .set({ project_id: data.id })
              .where(and(eq(SessionTable.project_id, ProjectID.global), eq(SessionTable.directory, data.worktree)))
              .run(),
          )
        }

        yield* emitUpdated(result)
        yield* touch({ project: result, directory })
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
        const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
        return row ? fromRow(row) : undefined
      })

      const update = Effect.fn("Project.update")(function* (input: UpdateInput) {
        const result = yield* db((d) =>
          d
            .update(ProjectTable)
            .set({
              name: input.name,
              icon_url: input.icon?.url,
              icon_color: input.icon?.color,
              commands: input.commands,
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
        yield* db((d) =>
          d.update(ProjectTable).set({ time_initialized: Date.now() }).where(eq(ProjectTable.id, id)).run(),
        )
      })

      const sandboxes = Effect.fn("Project.sandboxes")(function* (id: ProjectID) {
        const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
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
        const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
        if (!row) throw new Error(`Project not found: ${id}`)
        const sboxes = [...row.sandboxes]
        if (!sboxes.includes(directory)) sboxes.push(directory)
        const result = yield* db((d) =>
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
        const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
        if (!row) throw new Error(`Project not found: ${id}`)
        const sboxes = row.sandboxes.filter((s) => s !== directory)
        const result = yield* db((d) =>
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

      return Service.of({
        fromDirectory,
        discover,
        list,
        recent: recentList,
        get,
        update,
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
    const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
    if (!row) return undefined
    return fromRow(row)
  }

  export function setInitialized(id: ProjectID) {
    Database.use((db) =>
      db.update(ProjectTable).set({ time_initialized: Date.now() }).where(eq(ProjectTable.id, id)).run(),
    )
  }

  export function initGit(input: { directory: string; project: Info }) {
    return runPromise((svc) => svc.initGit(input))
  }

  export function update(input: UpdateInput) {
    return runPromise((svc) => svc.update(input))
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
}
