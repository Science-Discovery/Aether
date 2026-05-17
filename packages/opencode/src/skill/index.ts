import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Effect, Layer, ServiceMap } from "effect"
import { NamedError } from "@opencode-ai/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Instance } from "@/project/instance"
import { makeRuntime } from "@/effect/run-service"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { Permission } from "@/permission"
import { Filesystem } from "@/util/filesystem"
import { Config } from "../config/config"
import { ConfigMarkdown } from "../config/markdown"
import { Glob } from "../util/glob"
import { Log } from "../util/log"
import { Discovery } from "./discovery"
import { Spawner } from "@/skill-evolution/spawner"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  // Ordered low→high priority; global phase scans in this order (last wins = .aether highest).
  // Project phase uses targets in reverse so that after toReversed() inner .aether still wins.
  const EXTERNAL_DIRS = [".agents", ".claude", ".opencode", ".aether"]
  const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
  const SKILL_PATTERN = "**/SKILL.md"

  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  export type Scope = "global" | "project" | "config-root" | "paths" | "urls"
  export type Source = {
    dir: string
    pattern: string
    scope: Scope
  }

  type State = {
    skills: Record<string, Info>
    dirs: Set<string>
    sources: Source[]
  }

  export interface Interface {
    readonly get: (name: string) => Effect.Effect<Info | undefined>
    readonly all: () => Effect.Effect<Info[]>
    readonly dirs: () => Effect.Effect<string[]>
    readonly sources: () => Effect.Effect<Source[]>
    readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
  }

  function snapshotPath(directory: string) {
    const dirSlug =
      process.platform === "win32"
        ? directory.replace(/[\\/]/g, "_").replace(/:/g, "").replace(/^_/, "")
        : directory.replace(/\//g, "_").replace(/^_/, "")
    return path.join(Global.Path.home, ".aether", "skill-snapshots", `${dirSlug}.json`)
  }

  async function readSnapshot(directory: string): Promise<Record<string, number> | null> {
    try {
      const content = await fs.readFile(snapshotPath(directory), "utf-8")
      return JSON.parse(content) as Record<string, number>
    } catch {
      return null
    }
  }

  async function writeSnapshot(directory: string, snapshot: Record<string, number>): Promise<void> {
    const p = snapshotPath(directory)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, JSON.stringify(snapshot, null, 2), "utf-8")
  }

  async function roots() {
    const binary = path.dirname(process.execPath)
    return [
      Global.Path.config,
      ...(await Array.fromAsync(
        Filesystem.up({
          targets: [".aether", ".opencode"],
          start: binary,
          stop: binary,
        }),
      )),
      ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
    ]
  }

  async function scanAllSkillPaths(directory: string, worktree: string, projectId: string): Promise<string[]> {
    const paths: string[] = []

    for (const dir of await roots()) {
      const matches = await Glob.scan(EXTERNAL_SKILL_PATTERN, {
        cwd: dir,
        absolute: true,
        include: "file",
        symlink: true,
      }).catch(() => [])
      paths.push(...matches)
    }

    if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
      for (const dir of EXTERNAL_DIRS) {
        const root = path.join(Global.Path.home, dir)
        if (!(await Filesystem.isDir(root))) continue
        const matches = await Glob.scan(EXTERNAL_SKILL_PATTERN, {
          cwd: root,
          absolute: true,
          include: "file",
          symlink: true,
          dot: true,
        }).catch(() => [])
        paths.push(...matches)
      }

      const skillSessionsDir = Spawner.skillSessionsDir(Spawner.skillFolderName(directory, projectId))
      if (await Filesystem.isDir(skillSessionsDir)) {
        const matches = await Glob.scan(SKILL_PATTERN, {
          cwd: skillSessionsDir,
          absolute: true,
          include: "file",
          symlink: true,
          dot: true,
        }).catch(() => [])
        paths.push(...matches)
      }

      const projectDirs: string[] = []
      for await (const root of Filesystem.up({ targets: [...EXTERNAL_DIRS].reverse(), start: directory, stop: worktree })) {
        projectDirs.push(root)
      }
      for (const root of projectDirs.toReversed()) {
        const matches = await Glob.scan(EXTERNAL_SKILL_PATTERN, {
          cwd: root,
          absolute: true,
          include: "file",
          symlink: true,
          dot: true,
        }).catch(() => [])
        paths.push(...matches)
      }
    }

    const cfg = await Config.get()
    for (const item of cfg.skills?.paths ?? []) {
      const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
      const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
      if (!(await Filesystem.isDir(dir))) continue
      const matches = await Glob.scan(SKILL_PATTERN, {
        cwd: dir,
        absolute: true,
        include: "file",
        symlink: true,
      }).catch(() => [])
      paths.push(...matches)
    }

    return paths
  }

  async function buildManifest(directory: string, worktree: string, projectId: string): Promise<Record<string, number>> {
    const paths = await scanAllSkillPaths(directory, worktree, projectId)
    const manifest: Record<string, number> = {}
    for (const p of paths) {
      const stat = await fs.stat(p).catch(() => null)
      if (stat) manifest[p] = stat.mtimeMs
    }
    return manifest
  }

  // Returns false when snapshot is absent or stale (file added/modified/deleted).
  // URL-pulled skills (stored in Global.Path.cache) are not rescanned from source;
  // their local copies are still checked via the snapshot mtime entries.
  async function isFresh(projectId: string, directory: string, worktree: string): Promise<boolean> {
    const snapshot = await readSnapshot(directory)
    if (!snapshot) return false

    for (const [p, snapshotMtime] of Object.entries(snapshot)) {
      const stat = await fs.stat(p).catch(() => null)
      if (!stat || stat.mtimeMs !== snapshotMtime) return false
    }

    const currentPaths = await scanAllSkillPaths(directory, worktree, projectId)
    for (const p of currentPaths) {
      if (!(p in snapshot)) return false
    }

    return true
  }

  const add = async (state: State, match: string) => {
    const md = await ConfigMarkdown.parse(match).catch(async (err) => {
      const message = ConfigMarkdown.FrontmatterError.isInstance(err)
        ? err.data.message
        : `Failed to parse skill ${match}`
      const { Session } = await import("@/session")
      Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
      log.error("failed to load skill", { skill: match, err })
      return undefined
    })

    if (!md) return

    const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
    if (!parsed.success) return

    if (state.skills[parsed.data.name]) {
      log.warn("duplicate skill name", {
        name: parsed.data.name,
        existing: state.skills[parsed.data.name].location,
        duplicate: match,
      })
    }

    state.dirs.add(path.dirname(match))
    state.skills[parsed.data.name] = {
      name: parsed.data.name,
      description: parsed.data.description,
      location: match,
      content: md.content,
    }
  }

  const scan = async (state: State, root: string, pattern: string, opts?: { dot?: boolean; scope?: string }) => {
    return Glob.scan(pattern, {
      cwd: root,
      absolute: true,
      include: "file",
      symlink: true,
      dot: opts?.dot,
    })
      .then((matches) => Promise.all(matches.map((match) => add(state, match))))
      .catch((error) => {
        if (!opts?.scope) throw error
        log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
      })
  }

  async function loadSkills(
    state: State,
    discovery: Discovery.Interface,
    directory: string,
    worktree: string,
    projectId: string,
  ) {
    for (const dir of await roots()) {
      state.sources.push({ dir, pattern: EXTERNAL_SKILL_PATTERN, scope: "config-root" })
      await scan(state, dir, EXTERNAL_SKILL_PATTERN)
    }

    if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
      for (const dir of EXTERNAL_DIRS) {
        const root = path.join(Global.Path.home, dir)
        if (!(await Filesystem.isDir(root))) continue
        state.sources.push({ dir: root, pattern: EXTERNAL_SKILL_PATTERN, scope: "global" })
        await scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
      }

      // AI background-review skills: project-scope but lowest priority (overridden by any user source)
      const skillSessionsDir = Spawner.skillSessionsDir(Spawner.skillFolderName(directory, projectId))
      if (await Filesystem.isDir(skillSessionsDir)) {
        state.sources.push({ dir: skillSessionsDir, pattern: SKILL_PATTERN, scope: "project" })
        await scan(state, skillSessionsDir, SKILL_PATTERN, { dot: true, scope: "project" })
      }

      // Collect dirs from inner (directory) to outer (worktree), then scan reversed so inner wins.
      // Filesystem.up iterates targets in order per level; using the reversed EXTERNAL_DIRS order means
      // after toReversed() the low-priority dirs (.agents) are scanned first and high-priority (.aether) last.
      const projectDirs: string[] = []
      for await (const root of Filesystem.up({ targets: [...EXTERNAL_DIRS].reverse(), start: directory, stop: worktree })) {
        projectDirs.push(root)
      }
      for (const root of projectDirs.toReversed()) {
        state.sources.push({ dir: root, pattern: EXTERNAL_SKILL_PATTERN, scope: "project" })
        await scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
      }
    }

    const cfg = await Config.get()
    for (const item of cfg.skills?.paths ?? []) {
      const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
      const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
      if (!(await Filesystem.isDir(dir))) {
        log.warn("skill path not found", { path: dir })
        continue
      }

      state.sources.push({ dir, pattern: SKILL_PATTERN, scope: "paths" })
      await scan(state, dir, SKILL_PATTERN)
    }

    for (const url of cfg.skills?.urls ?? []) {
      for (const dir of await Effect.runPromise(discovery.pull(url))) {
        state.dirs.add(dir)
        state.sources.push({ dir, pattern: SKILL_PATTERN, scope: "urls" })
        await scan(state, dir, SKILL_PATTERN)
      }
    }

    log.info("init", { count: Object.keys(state.skills).length })

    // Remove disabled skills
    const disabled = new Set(cfg.skills?.disabled ?? [])
    for (const name of disabled) {
      if (state.skills[name]) {
        delete state.skills[name]
        log.info("skill disabled by config", { name })
      }
    }

    // Write mtime snapshot so isFresh() can detect external edits on the next access.
    const snapshot = await buildManifest(directory, worktree, projectId)
    await writeSnapshot(directory, snapshot)
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Skill") {}

  export const layer: Layer.Layer<Service, never, Discovery.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service
      const state = yield* InstanceState.make(
        Effect.fn("Skill.state")((ctx) =>
          Effect.gen(function* () {
            const s: State = { skills: {}, dirs: new Set(), sources: [] }
            yield* Effect.promise(() => loadSkills(s, discovery, ctx.directory, ctx.worktree, String(ctx.project.id)))
            return s
          }),
        ),
      )

      // Checks mtime snapshot before serving from cache so external edits to SKILL.md
      // are picked up without restarting the instance.
      const getState = Effect.fn("Skill.getState")(function* () {
        const instance = Instance.current
        const projectId = String(instance.project.id)
        const fresh = yield* Effect.promise(() => isFresh(projectId, instance.directory, instance.worktree))
        if (!fresh) yield* InstanceState.invalidate(state)
        return yield* InstanceState.get(state)
      })

      const get = Effect.fn("Skill.get")(function* (name: string) {
        const s = yield* getState()
        return s.skills[name]
      })

      const all = Effect.fn("Skill.all")(function* () {
        const s = yield* getState()
        return Object.values(s.skills)
      })

      const dirs = Effect.fn("Skill.dirs")(function* () {
        const s = yield* getState()
        return Array.from(s.dirs)
      })

      const sources = Effect.fn("Skill.sources")(function* () {
        const s = yield* getState()
        return s.sources
      })

      const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
        const s = yield* getState()
        const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
        if (!agent) return list
        return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
      })

      return Service.of({ get, all, dirs, sources, available })
    }),
  )

  export const defaultLayer: Layer.Layer<Service> = layer.pipe(Layer.provide(Discovery.defaultLayer))

  export function fmt(list: Info[], opts: { verbose: boolean }) {
    if (list.length === 0) return "No skills are currently available."

    if (opts.verbose) {
      return [
        "<available_skills>",
        ...list.flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${pathToFileURL(skill.location).href}</location>`,
          "  </skill>",
        ]),
        "</available_skills>",
      ].join("\n")
    }

    return ["## Available Skills", ...list.map((skill) => `- **${skill.name}**: ${skill.description}`)].join("\n")
  }

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function get(name: string) {
    return runPromise((skill) => skill.get(name))
  }

  export async function all() {
    return runPromise((skill) => skill.all())
  }

  export async function dirs() {
    return runPromise((skill) => skill.dirs())
  }

  export async function sources() {
    return runPromise((skill) => skill.sources())
  }

  export async function available(agent?: Agent.Info) {
    return runPromise((skill) => skill.available(agent))
  }
}
