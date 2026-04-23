import fs from "fs/promises"
import { createHash } from "crypto"
import os from "os"
import path from "path"
import z from "zod"
import { Effect, Layer, ServiceMap } from "effect"
import { NamedError } from "@opencode-ai/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
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

export namespace Skill {
  const log = Log.create({ service: "skill" })
  const EXTERNAL_DIRS = [".claude", ".agents"]
  const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
  const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
  const SKILL_PATTERN = "**/SKILL.md"

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
    if (Filesystem.contains(worktree, dir)) return "project"
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
      for await (const dir of Filesystem.up({ targets: EXTERNAL_DIRS, start: directory, stop: worktree })) {
        add("project", dir, EXTERNAL_SKILL_PATTERN, true)
      }
    }

    for (const dir of await Config.directories()) {
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

  async function loadSkillsData(directory: string, worktree: string): Promise<RawState> {
    if (!_discovery) throw new Error("Skill service not initialized — layer not started")

    const cfg = await Config.get()
    const disabled = new Set(cfg.skills?.disabled ?? [])

    const sources = await buildSources(directory, worktree, cfg)
    const globalDirs = manifestDirs(sources, "global")
    const projectDirs = manifestDirs(sources, "project")
    console.log(`[skill cache] scan dirs (global): ${globalDirs.join(", ") || "(none)"}`)
    console.log(`[skill cache] scan dirs (project): ${projectDirs.join(", ") || "(none)"}`)

    const globalManifest = await buildSkillsManifest(globalDirs)
    const projectManifest = await buildSkillsManifest(projectDirs)
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
      dirs: new Set(Object.values(merged).map((item) => path.dirname(item.location))),
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

      const get = Effect.fn("Skill.get")(function* (name: string) {
        const s = yield* InstanceState.get(state)
        return s.skills[name]
      })

      const all = Effect.fn("Skill.all")(function* () {
        const s = yield* InstanceState.get(state)
        return Object.values(s.skills)
      })

      const dirs = Effect.fn("Skill.dirs")(function* () {
        const s = yield* InstanceState.get(state)
        return Array.from(s.dirs)
      })

      const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
        const cached = yield* InstanceState.has(state)
        if (cached) console.log(`[skill cache] memory hit`)
        const s = yield* InstanceState.get(state)
        const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
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
    await runPromise((skill) => skill.invalidate())
    if (clearSnapshot) {
      await fs.unlink(globalSnapshotPath()).catch(() => {})
      await fs.rm(projectSnapshotDir(), { recursive: true, force: true }).catch(() => {})
      await fs.unlink(path.join(Global.Path.cache, ".skills_prompt_snapshot.json")).catch(() => {})
    }
    log.info("skills cache cleared", { clearSnapshot })
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
