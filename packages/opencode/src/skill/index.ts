import fs from "fs/promises"
import { createHash } from "crypto"
import os from "os"
import path from "path"
import z from "zod"
import { Effect, Layer, ServiceMap } from "effect"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { NamedError } from "@opencode-ai/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { Permission } from "@/permission"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { lazy } from "@/util/lazy"
import { Config } from "../config/config"
import { ConfigMarkdown } from "../config/markdown"
import { Glob } from "../util/glob"
import { Log } from "../util/log"
import { Discovery } from "./discovery"

declare const OPENCODE_LIBC: string | undefined

export namespace Skill {
  const log = Log.create({ service: "skill" })
  const EXTERNAL_DIRS = [".claude", ".agents"]
  const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
  const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
  const SKILL_PATTERN = "**/SKILL.md"
  const WATCH_WAIT = 300
  const WATCH_MAX = 2000
  const WATCH_CAP = 2000
  const WATCH_POLL = 1500
  const WATCH_ENSURE = 5000
  const MARK_TTL = 1500
  const WATCH_COOLDOWN = 500

  type Back = "parcel" | "poll"
  type WatchState = {
    alive: boolean
    back: Back
  }

  const marks = new Map<string, number>()
  let cooldown = 0
  let clearing: Promise<void> | undefined

  function key(file: string) {
    const k = path.resolve(file).replace(/\\/g, "/")
    return process.platform === "win32" ? k.toLowerCase() : k
  }

  export function markBegin(file: string) {
    marks.set(key(file), Number.POSITIVE_INFINITY)
  }

  export function markDone(file: string, ttl = MARK_TTL) {
    marks.set(key(file), Date.now() + ttl)
  }

  export function markDrop(file: string) {
    marks.delete(key(file))
  }

  function marked(file: string) {
    const now = Date.now()
    const exp = marks.get(key(file))
    if (exp === undefined) return false
    if (exp === Number.POSITIVE_INFINITY) return true
    if (exp > now) return true
    marks.delete(key(file))
    return false
  }

  export function markClear() {
    cooldown = Date.now()
  }

  function cooling() {
    return Date.now() - cooldown < WATCH_COOLDOWN
  }

  // ── Condition declarations (mirrors Hermes extract_skill_conditions) ──────

  export const Conditions = z.object({
    requires_tools: z.array(z.string()).optional(),
    requires_toolsets: z.array(z.string()).optional(),
    fallback_for_tools: z.array(z.string()).optional(),
    fallback_for_toolsets: z.array(z.string()).optional(),
  })
  export type Conditions = z.infer<typeof Conditions>

  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
    conditions: Conditions.optional(),
    platforms: z.array(z.string()).optional(),
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

  // ── Platform matching (mirrors Hermes skill_matches_platform) ─────────────

  const PLATFORM_MAP: Record<string, string> = {
    macos: "darwin",
    linux: "linux",
    windows: "win32",
  }

  function skillMatchesPlatform(platforms?: string[]): boolean {
    if (!platforms?.length) return true
    return platforms.some((p) => {
      const mapped = PLATFORM_MAP[p.toLowerCase()] ?? p.toLowerCase()
      return process.platform.startsWith(mapped)
    })
  }

  // ── Conditions matching (mirrors Hermes build_skills_system_prompt filtering) ──

  export function matchesConditions(skill: Info, tools: Set<string>, toolsets: Set<string>): boolean {
    const c = skill.conditions
    if (!c) return true
    // requires_tools: ALL listed tools must be available
    if (c.requires_tools?.length && !c.requires_tools.every((t) => tools.has(t))) return false
    // requires_toolsets: ALL listed toolsets must be available
    if (c.requires_toolsets?.length && !c.requires_toolsets.every((ts) => toolsets.has(ts))) return false
    // fallback_for_tools: show ONLY IF none of the listed tools are available
    if (c.fallback_for_tools?.length && c.fallback_for_tools.some((t) => tools.has(t))) return false
    // fallback_for_toolsets: show ONLY IF none of the listed toolsets are available
    if (c.fallback_for_toolsets?.length && c.fallback_for_toolsets.some((ts) => toolsets.has(ts))) return false
    return true
  }

  type RawState = { skills: Record<string, Info>; dirs: Set<string> }

  let _discovery: Discovery.Interface | null = null

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

  const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
    try {
      const abi = libc()
      const binding = require(`@parcel/watcher-${process.platform}-${process.arch}${abi ? `-${abi}` : ""}`)
      return createWrapper(binding) as typeof import("@parcel/watcher")
    } catch {
      return
    }
  })

  function backend() {
    if (process.platform === "win32") return "windows"
    if (process.platform === "darwin") return "fs-events"
    if (process.platform === "linux") return "inotify"
  }

  function watchBack(): Back {
    const raw = process.env.OPENCODE_SKILL_WATCHER_BACKEND?.toLowerCase()
    if (raw === "parcel") return "parcel"
    if (raw === "poll") return "poll"
    return "parcel"
  }

  function diff(prev: SnapshotManifest, next: SnapshotManifest) {
    const set = new Set<string>()
    for (const [file, stat] of Object.entries(next)) {
      const old = prev[file]
      if (!old) {
        set.add(file)
        continue
      }
      if (old[0] !== stat[0] || old[1] !== stat[1]) set.add(file)
    }
    for (const file of Object.keys(prev)) {
      if (!next[file]) set.add(file)
    }
    return [...set]
  }

  // ── Layer 2: Disk snapshot (mirrors Hermes _load_skills_snapshot) ─────────

  // mirrors Hermes _SKILLS_SNAPSHOT_VERSION
  const SKILLS_SNAPSHOT_VERSION = 2

  type Scope = "global" | "project"
  type Source = {
    dir: string
    pattern: string
    dot?: boolean
    scope: Scope
    order: number
  }
  type SnapshotSkill = Info & { order: number }
  type ScanState = { skills: Record<string, SnapshotSkill>; dirs: Set<string> }

  function globalSnapshotPath(): string {
    return path.join(Global.Path.cache, ".skills_prompt_snapshot.global.json")
  }

  function projectSnapshotDir(): string {
    return path.join(Global.Path.cache, "skills-prompt")
  }

  function projectSnapshotPath(directory: string, worktree: string): string {
    const base = path.basename(directory) || "project"
    const slug =
      base
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "project"
    const key = createHash("sha1").update(`${process.platform}|${directory}|${worktree}`).digest("hex")
    return path.join(projectSnapshotDir(), `${slug}.${key}.json`)
  }

  type SnapshotManifest = Record<string, [number, number]> // filepath -> [mtimeMs, size]

  // mirrors Hermes _build_skills_manifest
  async function buildSkillsManifest(dirs: string[]): Promise<SnapshotManifest> {
    const manifest: SnapshotManifest = {}
    for (const dir of dirs) {
      const matches = await Glob.scan("**/SKILL.md", {
        cwd: dir,
        absolute: true,
        include: "file",
        symlink: true,
        dot: true,
      }).catch(() => [] as string[])
      for (const f of matches) {
        const stat = await fs.stat(f).catch(() => null)
        if (stat) manifest[f] = [Math.round(stat.mtimeMs), stat.size]
      }
    }
    return manifest
  }

  function manifestsMatch(a: SnapshotManifest, b: SnapshotManifest): boolean {
    const aKeys = Object.keys(a).sort()
    const bKeys = Object.keys(b).sort()
    if (aKeys.length !== bKeys.length) return false
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false
      const [am, as_] = a[aKeys[i]]
      const [bm, bs] = b[bKeys[i]]
      if (am !== bm || as_ !== bs) return false
    }
    return true
  }

  // mirrors Hermes _load_skills_snapshot
  async function loadSkillsSnapshot(snapshotPath: string, manifest: SnapshotManifest): Promise<SnapshotSkill[] | null> {
    try {
      const raw = await fs.readFile(snapshotPath, "utf8")
      const snap = JSON.parse(raw)
      if (snap?.version !== SKILLS_SNAPSHOT_VERSION) return null
      if (!manifestsMatch(manifest, snap.manifest ?? {})) return null
      if (!Array.isArray(snap.skills)) return null
      return snap.skills.map((skill: unknown, i: number) => {
        const parsed = Info.parse(skill)
        const order = typeof (skill as any).order === "number" ? (skill as any).order : i
        return { ...parsed, order }
      })
    } catch {
      return null
    }
  }

  // mirrors Hermes _write_skills_snapshot
  async function writeSkillsSnapshot(
    snapshotPath: string,
    manifest: SnapshotManifest,
    skills: SnapshotSkill[],
  ): Promise<void> {
    const tmp = snapshotPath + ".tmp." + Date.now()
    try {
      await fs.mkdir(path.dirname(snapshotPath), { recursive: true })
      await fs.writeFile(tmp, JSON.stringify({ version: SKILLS_SNAPSHOT_VERSION, manifest, skills }), "utf8")
      await fs.rename(tmp, snapshotPath)
    } catch {
      await fs.unlink(tmp).catch(() => {})
    }
  }

  // ── Raw skill loading ─────────────────────────────────────────────────────

  // mirrors Hermes extract_skill_conditions (called inside _parse_skill_file)
  function extractSkillConditions(hermes: any): Conditions | undefined {
    if (!hermes || typeof hermes !== "object") return undefined
    const c: Conditions = {}
    if (Array.isArray(hermes.requires_tools) && hermes.requires_tools.length) c.requires_tools = hermes.requires_tools
    if (Array.isArray(hermes.requires_toolsets) && hermes.requires_toolsets.length)
      c.requires_toolsets = hermes.requires_toolsets
    if (Array.isArray(hermes.fallback_for_tools) && hermes.fallback_for_tools.length)
      c.fallback_for_tools = hermes.fallback_for_tools
    if (Array.isArray(hermes.fallback_for_toolsets) && hermes.fallback_for_toolsets.length)
      c.fallback_for_toolsets = hermes.fallback_for_toolsets
    return Object.keys(c).length ? c : undefined
  }

  // mirrors Hermes _parse_skill_file + _build_snapshot_entry
  const parseSkillFile = async (state: ScanState, match: string, order: number) => {
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

    const conditions = extractSkillConditions((md.data as any)?.metadata?.hermes)

    const rawPlatforms = (md.data as any)?.platforms
    const platforms: string[] | undefined =
      Array.isArray(rawPlatforms) && rawPlatforms.length ? rawPlatforms.map(String) : undefined

    state.dirs.add(path.dirname(match))
    state.skills[parsed.data.name] = {
      name: parsed.data.name,
      description: parsed.data.description,
      location: match,
      content: md.content,
      conditions,
      platforms,
      order,
    }
  }

  const scan = async (state: ScanState, src: Source) => {
    return Glob.scan(src.pattern, {
      cwd: src.dir,
      absolute: true,
      include: "file",
      symlink: true,
      dot: src.dot,
    })
      .then((matches) => Promise.all(matches.map((match) => parseSkillFile(state, match, src.order))))
      .catch((error) => {
        log.error(`failed to scan ${src.scope} skills`, { dir: src.dir, error })
      })
  }

  function scope(dir: string, directory: string, worktree: string): Scope {
    if (Filesystem.contains(directory, dir)) return "project"
    if (worktree !== "/" && Filesystem.contains(worktree, dir)) return "project"
    return "global"
  }

  function mergeSkills(global: SnapshotSkill[], project: SnapshotSkill[]) {
    const skills: Record<string, Info> = {}
    for (const item of [...global, ...project].toSorted((a, b) => a.order - b.order)) {
      skills[item.name] = {
        name: item.name,
        description: item.description,
        location: item.location,
        content: item.content,
        conditions: item.conditions,
        platforms: item.platforms,
      }
    }
    return skills
  }

  async function buildSources(directory: string, worktree: string, cfg: Awaited<ReturnType<typeof Config.get>>) {
    if (!_discovery) throw new Error("Skill service not initialized — layer not started")
    const list: Source[] = []
    let order = 0
    const add = (scope: Scope, dir: string, pattern: string, dot?: boolean) => {
      list.push({ scope, dir, pattern, dot, order })
      order += 1
    }

    const managed = path.join(Global.Path.data, "skills")
    if (await Filesystem.isDir(managed)) add("global", managed, SKILL_PATTERN)

    if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
      for (const item of EXTERNAL_DIRS) {
        const dir = path.join(Global.Path.home, item)
        if (!(await Filesystem.isDir(dir))) continue
        add("global", dir, EXTERNAL_SKILL_PATTERN, true)
      }
      for await (const dir of Filesystem.up({
        targets: EXTERNAL_DIRS,
        start: directory,
        stop: worktree === "/" ? directory : worktree,
      })) {
        add("project", dir, EXTERNAL_SKILL_PATTERN, true)
      }
    }

    const serverSkillsDir = Config.getDefaultSkillsDir()
    const serverConfigDir = serverSkillsDir ? path.resolve(path.dirname(serverSkillsDir)) : null
    for (const dir of await Config.directories()) {
      if (serverConfigDir && path.resolve(dir) === serverConfigDir) continue
      add(scope(dir, directory, worktree), dir, OPENCODE_SKILL_PATTERN)
    }

    for (const item of cfg.skills?.paths ?? []) {
      const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
      const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
      if (!(await Filesystem.isDir(dir))) {
        log.warn("skill path not found", { path: dir })
        continue
      }
      const next = path.isAbsolute(expanded) ? scope(dir, directory, worktree) : "project"
      add(next, dir, SKILL_PATTERN)
    }

    for (const url of cfg.skills?.urls ?? []) {
      for (const dir of await Effect.runPromise(_discovery.pull(url))) {
        add("global", dir, SKILL_PATTERN)
      }
    }

    return list
  }

  async function scanSources(sources: Source[], scope: Scope) {
    const state: ScanState = { skills: {}, dirs: new Set() }
    for (const item of sources) {
      if (item.scope !== scope) continue
      await scan(state, item)
    }
    return state
  }

  function manifestDirs(sources: Source[], scope: Scope) {
    return Array.from(new Set(sources.filter((item) => item.scope === scope).map((item) => item.dir)))
  }

  function inDir(file: string, dirs: string[]) {
    return dirs.some((dir) => Filesystem.contains(dir, file))
  }

  async function watchDirs(directory: string, worktree: string) {
    const cfg = await Config.get()
    const sources = await buildSources(directory, worktree, cfg)
    return {
      global: manifestDirs(sources, "global"),
      project: manifestDirs(sources, "project"),
    }
  }

  function chain(start: string, stop: string) {
    const out: string[] = []
    let dir = start
    while (true) {
      out.push(dir)
      if (dir === stop) break
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return out
  }

  function uniq(list: string[]) {
    const map = new Map<string, string>()
    for (const dir of list) {
      const key = process.platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir)
      if (map.has(key)) continue
      map.set(key, dir)
    }
    return [...map.values()]
  }

  function merge(a: { global: string[]; project: string[] }, b: { global: string[]; project: string[] }) {
    return {
      global: Array.from(new Set([...a.global, ...b.global])),
      project: Array.from(new Set([...a.project, ...b.project])),
    }
  }

  async function watchCandidates(directory: string, worktree: string) {
    const cfg = await Config.get()
    const set = {
      global: new Set<string>(),
      project: new Set<string>(),
    }
    const add = (scope: Scope, dir: string) => {
      set[scope].add(path.resolve(dir))
    }
    const names = [".aether", ".opencode", ".claude", ".agents"]
    for (const dir of chain(directory, worktree === "/" ? directory : worktree)) {
      for (const name of names) add("project", path.join(dir, name))
    }
    for (const name of names) add("global", path.join(Global.Path.home, name))
    add("global", path.join(Global.Path.data, "skills"))

    for (const item of cfg.skills?.paths ?? []) {
      const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
      const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
      const next = path.isAbsolute(expanded) ? scope(dir, directory, worktree) : "project"
      add(next, dir)
    }

    return {
      dirs: {
        global: [...set.global],
        project: [...set.project],
      },
      sig: JSON.stringify(cfg.skills?.paths ?? []),
    }
  }

  async function loadSkillsData(directory: string, worktree: string): Promise<RawState> {
    if (!_discovery) throw new Error("Skill service not initialized — layer not started")

    const cfg = await Config.get()
    const global = await Config.getGlobal()
    const disabled = new Set(global.skills?.disabled ?? [])

    const sources = await buildSources(directory, worktree, cfg)
    const globalDirs = manifestDirs(sources, "global")
    const projectDirs = manifestDirs(sources, "project")
    console.log(`[skill cache] scan dirs (global): ${globalDirs.join(", ") || "(none)"}`)
    console.log(`[skill cache] scan dirs (project): ${projectDirs.join(", ") || "(none)"}`)

    const t0 = performance.now()
    const globalManifest = await buildSkillsManifest(globalDirs)
    const t1 = performance.now()
    const projectManifest = await buildSkillsManifest(projectDirs)
    const t2 = performance.now()
    console.log(
      `[skill perf] manifest ms global=${Math.round(t1 - t0)} project=${Math.round(t2 - t1)} total=${Math.round(t2 - t0)}`,
    )
    const globalPath = globalSnapshotPath()
    const projectPath = projectSnapshotPath(directory, worktree)

    const cachedGlobal = await loadSkillsSnapshot(globalPath, globalManifest)
    const globalSkills =
      cachedGlobal ??
      (await (async () => {
        console.log(`[skill cache] snapshot miss (global), full scan`)
        const scanned = await scanSources(sources, "global")
        const list = Object.values(scanned.skills)
        await writeSkillsSnapshot(globalPath, globalManifest, list)
        return list
      })())
    if (cachedGlobal) console.log(`[skill cache] snapshot hit (global), count=${cachedGlobal.length}`)

    const cachedProject = await loadSkillsSnapshot(projectPath, projectManifest)
    const project =
      cachedProject ??
      (await (async () => {
        console.log(`[skill cache] snapshot miss (project), full scan`)
        const scanned = await scanSources(sources, "project")
        const list = Object.values(scanned.skills)
        await writeSkillsSnapshot(projectPath, projectManifest, list)
        return list
      })())
    if (cachedProject) console.log(`[skill cache] snapshot hit (project), count=${cachedProject.length}`)

    const merged = mergeSkills(globalSkills, project)
    for (const name of disabled) {
      if (!merged[name]) continue
      delete merged[name]
      log.info("skill disabled by config", { name })
    }

    return {
      skills: merged,
      dirs: new Set([
        ...Object.keys(globalManifest).map((f) => path.dirname(f)),
        ...Object.keys(projectManifest).map((f) => path.dirname(f)),
      ]),
    }
  }

  function stats(state: RawState) {
    const list = Object.values(state.skills)
    const bytes = list.reduce(
      (acc, item) =>
        acc +
        Buffer.byteLength(item.name) +
        Buffer.byteLength(item.description) +
        Buffer.byteLength(item.location) +
        Buffer.byteLength(item.content),
      0,
    )
    return {
      skills: list.length,
      dirs: state.dirs.size,
      bytes,
    }
  }

  async function loadSkills(state: RawState, directory: string, worktree: string) {
    console.log(`[skill cache] memory miss, loading from disk (dir=${directory})`)
    const data = await loadSkillsData(directory, worktree)
    state.skills = data.skills
    state.dirs = data.dirs
    const stat = stats(state)
    console.log(`[skill cache] stats skills=${stat.skills} dirs=${stat.dirs} bytes=${stat.bytes}`)
    log.info("init", { count: Object.keys(state.skills).length })
  }

  // ── Effect Service ────────────────────────────────────────────────────────

  export interface Interface {
    readonly get: (name: string) => Effect.Effect<Info | undefined>
    readonly all: () => Effect.Effect<Info[]>
    readonly dirs: () => Effect.Effect<string[]>
    readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
    readonly invalidate: () => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Skill") {}

  export const layer: Layer.Layer<Service, never, Discovery.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const discovery = yield* Discovery.Service
      _discovery = discovery
      const state = yield* InstanceState.make(
        Effect.fn("Skill.state")((ctx) =>
          Effect.gen(function* () {
            const s: RawState = { skills: {}, dirs: new Set() }
            yield* Effect.promise(() => loadSkills(s, ctx.directory, ctx.worktree))
            return s
          }),
        ),
      )

      const watch = yield* InstanceState.make(
        Effect.fn("Skill.watch")((ctx) =>
          Effect.gen(function* () {
            const first = yield* Effect.promise(() => watchCandidates(ctx.directory, ctx.worktree))
            let set = yield* Effect.promise(() =>
              watchDirs(ctx.directory, ctx.worktree).then((dirs) => merge(dirs, first.dirs)),
            )
            let sig = first.sig
            let roots = uniq([...set.global, ...set.project])
            const ws: WatchState = { alive: false, back: watchBack() }
            let sid = 0

            const close: Array<() => Promise<void>> = []
            const seen = new Map<string, boolean>()
            const files = new Set<string>()
            let timer: ReturnType<typeof setTimeout> | undefined
            let probe: ReturnType<typeof setInterval> | undefined
            let start = 0
            let globalDirty = false
            let projectDirty = false
            let dropped = 0
            let busy = false

            const mark = (kind: Scope) => {
              if (kind === "global") globalDirty = true
              if (kind === "project") projectDirty = true
            }

            const route = (file: string) => {
              if (inDir(file, set.global)) {
                mark("global")
                return "global" as const
              }
              if (inDir(file, set.project)) {
                mark("project")
                return "project" as const
              }
            }

            const closeAll = async () => {
              await Promise.allSettled(close.map((item) => item()))
              close.length = 0
            }

            const refresh = async () => {
              const next = await watchCandidates(ctx.directory, ctx.worktree)
              if (next.sig === sig) return false
              sig = next.sig
              const cur = await watchDirs(ctx.directory, ctx.worktree)
              set = merge(cur, next.dirs)
              roots = uniq([...set.global, ...set.project])
              return true
            }

            const sync = async () => {
              let dirty = false
              const list = uniq([...set.global, ...set.project])
              for (const dir of list) {
                const has = await Filesystem.isDir(dir)
                const prev = seen.get(dir)
                if (prev === undefined) {
                  seen.set(dir, has)
                  continue
                }
                if (prev === has) continue
                seen.set(dir, has)
                if (inDir(dir, set.global)) mark("global")
                if (inDir(dir, set.project)) mark("project")
                dirty = true
              }
              return dirty
            }

            const flush = async () => {
              if (busy) return
              busy = true
              const t0 = performance.now()
              try {
                if (timer) clearTimeout(timer)
                timer = undefined
                start = 0
                const list = [...files].filter((file) => path.basename(file) === "SKILL.md")
                files.clear()
                const dirtyGlobal = globalDirty
                const dirtyProject = projectDirty
                globalDirty = false
                projectDirty = false

                const active = list.filter((file) => !marked(file))
                const hasGlobal = dirtyGlobal || active.some((file) => inDir(file, set.global))
                const hasProject = dirtyProject || active.some((file) => inDir(file, set.project))

                dropped = 0
                if (!hasGlobal && !hasProject) return

                console.log(`\n${"-".repeat(40)} skill watch ${"-".repeat(40)}`)
                console.log(
                  `[skill watch] batch files=${list.length} active=${active.length} dropped=${dropped} globalDirty=${hasGlobal ? 1 : 0} projectDirty=${hasProject ? 1 : 0} ms=${Math.round(performance.now() - t0)}`,
                )
                if (list.length > active.length) {
                  console.log(`[skill watch] skip reason=marked files=${list.length - active.length}`)
                }
                if (cooling()) {
                  console.log(`[skill watch] skip reason=cooling`)
                  return
                }

                const t1 = performance.now()
                if (hasGlobal) {
                  cooldown = Date.now()
                  await clearSkillsPromptCache(false)
                  console.log(
                    `[skill watch] invalidate scope=global instances=${Instance.dirs().length} files=${active.length} ms=${Math.round(performance.now() - t1)}`,
                  )
                  return
                }

                cooldown = Date.now()
                await Instance.provide({
                  directory: ctx.directory,
                  fn: () => runPromise((skill) => skill.invalidate()),
                })
                console.log(
                  `[skill watch] invalidate scope=project instances=1 files=${active.length} ms=${Math.round(performance.now() - t1)} dir=${ctx.directory}`,
                )
              } finally {
                busy = false
              }
            }

            const queue = (file?: string, kind?: Scope) => {
              if (kind) mark(kind)
              if (file && path.basename(file) === "SKILL.md") {
                if (files.size >= WATCH_CAP) {
                  dropped += 1
                  route(file)
                } else {
                  files.add(file)
                }
              }

              // Nothing dirty — skip scheduling a flush
              if (files.size === 0 && !globalDirty && !projectDirty) return

              const now = Date.now()
              if (!start) start = now
              if (now - start >= WATCH_MAX) {
                void flush()
                return
              }
              if (timer) clearTimeout(timer)
              timer = setTimeout(() => {
                void flush()
              }, WATCH_WAIT)
            }

            const setupParcel = async () => {
              const bind = watcher()
              const back = backend()
              if (!bind || !back) {
                console.log(`[skill watch] parcel unavailable binding=${bind ? 1 : 0} backend=${String(back)}`)
                return false
              }
              if (roots.length === 0) return true
              const mark = await Promise.all(roots.map(async (dir) => Filesystem.isDir(dir)))
              const ok = roots.filter((_dir, idx) => mark[idx])
              const miss = roots.filter((_dir, idx) => !mark[idx])
              if (miss.length > 0) {
                console.log(`[skill watch] parcel skip missing roots=${miss.length} dirs=${miss.join(" | ")}`)
              }
              if (ok.length === 0) {
                console.log(`[skill watch] parcel no existing roots`)
                return false
              }
              const good: string[] = []
              const bad: string[] = []
              for (const dir of ok) {
                const cb = Instance.bind((_err: Error | null, evts: ParcelWatcher.Event[]) => {
                  if (_err) {
                    ws.alive = false
                    console.log(`[skill watch] error backend=parcel message=${_err.message}`)
                    return
                  }
                  for (const evt of evts) {
                    const del =
                      evt.type === "delete" && (path.basename(evt.path) === "SKILL.md" || roots.includes(evt.path))
                    queue(evt.path, del ? route(evt.path) : undefined)
                  }
                })
                const sub = await bind.subscribe(dir, cb, { backend: back }).catch((err) => {
                  const msg = err instanceof Error ? err.message : String(err)
                  bad.push(`${dir} => ${msg}`)
                  console.log(`[skill watch] parcel subscribe failed dir=${dir} exists=1 message=${msg}`)
                  return
                })
                if (!sub) continue
                close.push(() => sub.unsubscribe())
                good.push(dir)
              }
              if (good.length === 0) {
                console.log(`[skill watch] parcel subscribe summary ok=0 fail=${bad.length}`)
                if (bad.length > 0) {
                  console.log(`[skill watch] parcel subscribe fail dirs=${bad.join(" | ")}`)
                }
                return false
              }
              console.log(`[skill watch] parcel subscribe summary ok=${good.length} fail=${bad.length}`)
              console.log(`[skill watch] parcel subscribe ok dirs=${good.join(" | ")}`)
              if (bad.length > 0) console.log(`[skill watch] parcel subscribe fail dirs=${bad.join(" | ")}`)
              ws.alive = true
              ws.back = "parcel"
              return true
            }

            const setupPoll = async () => {
              let globalManifest = await buildSkillsManifest(set.global)
              let projectManifest = await buildSkillsManifest(set.project)
              let busyPoll = false
              const id = setInterval(() => {
                if (busyPoll) return
                busyPoll = true
                void (async () => {
                  try {
                    const nextGlobal = await buildSkillsManifest(set.global)
                    const nextProject = await buildSkillsManifest(set.project)
                    for (const file of diff(globalManifest, nextGlobal)) queue(file, "global")
                    for (const file of diff(projectManifest, nextProject)) queue(file, "project")
                    globalManifest = nextGlobal
                    projectManifest = nextProject
                  } finally {
                    busyPoll = false
                  }
                })()
              }, WATCH_POLL)
              close.push(async () => {
                clearInterval(id)
              })
              ws.alive = true
              ws.back = "poll"
              return true
            }

            const backs = (): Back[] => (ws.back === "parcel" ? (["parcel", "poll"] as Back[]) : (["poll"] as Back[]))

            const startWatch = async () => {
              const id = ++sid
              console.log(`\n========== SKILL WATCH BEGIN #${id} [dir=${ctx.directory}] ==========`)
              try {
                await closeAll()
                const list = backs()
                const mark = await Promise.all(roots.map(async (dir) => Filesystem.isDir(dir)))
                const exist = mark.reduce((sum, item) => sum + (item ? 1 : 0), 0)
                const miss = roots.filter((_dir, idx) => !mark[idx]).slice(0, 6)
                const all = roots.map((dir, idx) => `${mark[idx] ? "ok" : "miss"}:${dir}`)
                console.log(
                  `[skill watch] chain=${list.join("->")} roots=${roots.length} exists=${exist} missing=${roots.length - exist}`,
                )
                console.log(`[skill watch] roots all=${all.join(" | ")}`)
                if (miss.length > 0) console.log(`[skill watch] missing sample=${miss.join(" | ")}`)
                let prev: Back | undefined
                for (const item of list) {
                  console.log(`[skill watch] try backend=${item}`)
                  const ok = await setup(item)
                  if (!ok) {
                    console.log(`[skill watch] try failed backend=${item}`)
                    prev = item
                    continue
                  }
                  ws.back = item
                  ws.alive = true
                  console.log(`[skill watch] try ok backend=${item}`)
                  if (prev) console.log(`[skill watch] fallback from=${prev} to=${item}`)
                  return
                }
                ws.alive = false
              } finally {
                console.log(`========== SKILL WATCH END   #${id} [dir=${ctx.directory}] ==========`)
              }
            }

            const restart = async () => {
              const cur = await watchDirs(ctx.directory, ctx.worktree)
              const opts = await watchCandidates(ctx.directory, ctx.worktree)
              sig = opts.sig
              set = merge(cur, opts.dirs)
              roots = uniq([...set.global, ...set.project])
              await startWatch()
            }

            const setup = async (back: Back) => {
              try {
                if (back === "parcel") return await setupParcel()
                return await setupPoll()
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                console.log(`[skill watch] setup error backend=${back} message=${msg}`)
                return false
              }
            }

            yield* Effect.promise(() => startWatch())
            if (!ws.alive) {
              console.log(`[skill watch] init failed roots=${roots.length} dir=${ctx.directory}`)
            }

            console.log(
              `[skill watch] init backend=${ws.back} active=${ws.alive ? 1 : 0} roots=${roots.length} dir=${ctx.directory}`,
            )

            let cfg = Date.now()
            probe = setInterval(() => {
              void (async () => {
                try {
                  const now = Date.now()
                  const changed = now - cfg >= WATCH_ENSURE ? await refresh() : false
                  if (changed) cfg = now
                  const dirty = await sync()
                  if (!changed && !dirty) return
                  await restart()
                  if (globalDirty) queue(undefined, "global")
                  if (projectDirty) queue(undefined, "project")
                } catch {
                  ws.alive = false
                }
              })()
            }, WATCH_POLL)

            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                ws.alive = false
                if (timer) clearTimeout(timer)
                if (probe) clearInterval(probe)
                await closeAll()
              }),
            )
            return ws
          }),
        ),
      )

      const ensure = new Map<string, number>()

      const ensureWatch = Effect.fn("Skill.ensureWatch")(
        function* () {
          const dir = Instance.directory
          const now = Date.now()
          const prev = ensure.get(dir) ?? 0
          if (now - prev < WATCH_ENSURE) return
          ensure.set(dir, now)
          const has = yield* InstanceState.has(watch)
          if (!has) {
            yield* InstanceState.get(watch)
            return
          }
          const ws = yield* InstanceState.get(watch)
          if (ws.alive) return
          console.log(`[skill watch] ensure restart dir=${Instance.directory} backend=${ws.back}`)
          yield* InstanceState.invalidate(watch)
          yield* InstanceState.get(watch)
        },
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.log(`[skill watch] ensure error cause=${String(cause)}`)
          }),
        ),
      )

      const get = Effect.fn("Skill.get")(function* (name: string) {
        yield* ensureWatch()
        const s = yield* InstanceState.get(state)
        return s.skills[name]
      })

      const all = Effect.fn("Skill.all")(function* () {
        yield* ensureWatch()
        const s = yield* InstanceState.get(state)
        return Object.values(s.skills)
      })

      const dirs = Effect.fn("Skill.dirs")(function* () {
        yield* ensureWatch()
        const s = yield* InstanceState.get(state)
        return Array.from(s.dirs)
      })

      const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
        yield* ensureWatch()
        const cached = yield* InstanceState.has(state)
        if (cached) console.log(`[skill cache] memory hit`)
        const t0 = cached ? performance.now() : undefined
        const s = yield* InstanceState.get(state)
        const t1 = t0 === undefined ? undefined : performance.now()
        const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
        if (t0 !== undefined && t1 !== undefined) {
          const t2 = performance.now()
          console.log(
            `[skill perf] memory ms get=${Math.round(t1 - t0)} sort=${Math.round(t2 - t1)} total=${Math.round(t2 - t0)}`,
          )
        }
        if (!agent) return list
        return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
      })

      const invalidate = Effect.fn("Skill.invalidate")(function* () {
        yield* InstanceState.invalidate(state)
      })

      return Service.of({ get, all, dirs, available, invalidate })
    }),
  )

  export async function clearSkillsPromptCache(clearSnapshot = false): Promise<void> {
    if (clearing) {
      if (!clearSnapshot) return clearing
      return clearing.then(() => clearSkillsPromptCache(true))
    }
    const run = (async () => {
      const dirs = Instance.dirs()
      console.log(
        `[skill cache] clear start snapshot=${clearSnapshot ? 1 : 0} instances=${dirs.length} dirs=${dirs.join(" | ") || "(none)"}`,
      )
      await Promise.all(
        dirs.map((dir) =>
          Instance.provide({
            directory: dir,
            fn: () => runPromise((skill) => skill.invalidate()),
          }),
        ),
      )
      if (clearSnapshot) {
        await fs.unlink(globalSnapshotPath()).catch(() => {})
        await fs.rm(projectSnapshotDir(), { recursive: true, force: true }).catch(() => {})
        await fs.unlink(path.join(Global.Path.cache, ".skills_prompt_snapshot.json")).catch(() => {})
      }
      console.log(
        `[skill cache] clear done snapshot=${clearSnapshot ? 1 : 0} instances=${dirs.length} dirs=${dirs.join(" | ") || "(none)"}`,
      )
      log.info("skills cache cleared", { clearSnapshot, instances: dirs.length, dirs })
    })()

    const task = run.finally(() => {
      if (clearing === task) clearing = undefined
    })
    clearing = task
    return task
  }

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

  export async function available(agent?: Agent.Info) {
    return runPromise((skill) => skill.available(agent))
  }
}
