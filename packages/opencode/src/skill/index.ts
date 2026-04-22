import fs from "fs/promises"
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
import { Instance } from "../project/instance"
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
  const SKILLS_SNAPSHOT_VERSION = 1

  // mirrors Hermes _skills_prompt_snapshot_path()
  function skillsPromptSnapshotPath(): string {
    return path.join(Global.Path.cache, ".skills_prompt_snapshot.json")
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
  async function loadSkillsSnapshot(manifest: SnapshotManifest): Promise<Info[] | null> {
    try {
      const raw = await fs.readFile(skillsPromptSnapshotPath(), "utf8")
      const snap = JSON.parse(raw)
      if (snap?.version !== SKILLS_SNAPSHOT_VERSION) return null
      if (!manifestsMatch(manifest, snap.manifest ?? {})) return null
      return snap.skills as Info[]
    } catch {
      return null
    }
  }

  // mirrors Hermes _write_skills_snapshot
  async function writeSkillsSnapshot(manifest: SnapshotManifest, skills: Info[]): Promise<void> {
    const snapshotPath = skillsPromptSnapshotPath()
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
    if (Array.isArray(hermes.requires_toolsets) && hermes.requires_toolsets.length) c.requires_toolsets = hermes.requires_toolsets
    if (Array.isArray(hermes.fallback_for_tools) && hermes.fallback_for_tools.length) c.fallback_for_tools = hermes.fallback_for_tools
    if (Array.isArray(hermes.fallback_for_toolsets) && hermes.fallback_for_toolsets.length) c.fallback_for_toolsets = hermes.fallback_for_toolsets
    return Object.keys(c).length ? c : undefined
  }

  // mirrors Hermes _parse_skill_file + _build_snapshot_entry
  const parseSkillFile = async (state: RawState, match: string) => {
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
    }
  }

  const scan = async (state: RawState, root: string, pattern: string, opts?: { dot?: boolean; scope?: string }) => {
    return Glob.scan(pattern, {
      cwd: root,
      absolute: true,
      include: "file",
      symlink: true,
      dot: opts?.dot,
    })
      .then((matches) => Promise.all(matches.map((match) => parseSkillFile(state, match))))
      .catch((error) => {
        if (!opts?.scope) throw error
        log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
      })
  }

  async function loadSkillsFromDirs(
    state: RawState,
    discovery: Discovery.Interface,
    directory: string,
    worktree: string,
  ) {
    // scan skills created via skill_manage (stored in data dir)
    const managedSkillsDir = path.join(Global.Path.data, "skills")
    if (await Filesystem.isDir(managedSkillsDir)) {
      await scan(state, managedSkillsDir, SKILL_PATTERN, { scope: "managed" })
    }

    if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
      for (const dir of EXTERNAL_DIRS) {
        const root = path.join(Global.Path.home, dir)
        if (!(await Filesystem.isDir(root))) continue
        await scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
      }

      for await (const root of Filesystem.up({
        targets: EXTERNAL_DIRS,
        start: directory,
        stop: worktree,
      })) {
        await scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
      }
    }

    for (const dir of await Config.directories()) {
      await scan(state, dir, OPENCODE_SKILL_PATTERN)
    }

    const cfg = await Config.get()
    for (const item of cfg.skills?.paths ?? []) {
      const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
      const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
      if (!(await Filesystem.isDir(dir))) {
        log.warn("skill path not found", { path: dir })
        continue
      }
      await scan(state, dir, SKILL_PATTERN)
    }

    for (const url of cfg.skills?.urls ?? []) {
      for (const dir of await Effect.runPromise(discovery.pull(url))) {
        state.dirs.add(dir)
        await scan(state, dir, SKILL_PATTERN)
      }
    }

    log.info("init", { count: Object.keys(state.skills).length })
  }

  // mirrors Hermes get_all_skills_dirs — collects all dirs for manifest building
  async function getAllSkillsDirs(directory: string, worktree: string): Promise<string[]> {
    const dirs: string[] = []

    // managed skills dir (written by skill_manage tool)
    const managedSkillsDir = path.join(Global.Path.data, "skills")
    if (await Filesystem.isDir(managedSkillsDir)) dirs.push(managedSkillsDir)

    if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
      for (const dir of EXTERNAL_DIRS) {
        const root = path.join(Global.Path.home, dir)
        if (await Filesystem.isDir(root)) dirs.push(root)
      }
      for await (const root of Filesystem.up({ targets: EXTERNAL_DIRS, start: directory, stop: worktree })) {
        dirs.push(root)
      }
    }

    for (const dir of await Config.directories()) dirs.push(dir)

    const cfg = await Config.get()
    for (const item of cfg.skills?.paths ?? []) {
      const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
      const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
      if (await Filesystem.isDir(dir)) dirs.push(dir)
    }

    const urlCacheDir = path.join(Global.Path.cache, "skills")
    if (await Filesystem.isDir(urlCacheDir)) dirs.push(urlCacheDir)

    return dirs
  }

  async function loadSkillsData(directory: string, worktree: string): Promise<RawState> {
    if (!_discovery) throw new Error("Skill service not initialized — layer not started")

    const cfg = await Config.get()
    const disabled = new Set(cfg.skills?.disabled ?? [])

    const scanDirs = await getAllSkillsDirs(directory, worktree)
    console.log(`[skill cache] scan dirs: ${scanDirs.join(", ") || "(none)"}`)
    const manifest = await buildSkillsManifest(scanDirs)

    // Layer 2: disk snapshot validated by mtime/size — catches manual file edits
    const snapped = await loadSkillsSnapshot(manifest)
    if (snapped) {
      console.log(`[skill cache] snapshot hit, count=${snapped.length}`)
      log.info("skills loaded from snapshot", { count: snapped.length })
      const s: RawState = { skills: {}, dirs: new Set() }
      for (const skill of snapped) {
        if (disabled.has(skill.name)) {
          log.info("skill disabled by config", { name: skill.name })
          continue
        }
        s.skills[skill.name] = skill
        s.dirs.add(path.dirname(skill.location))
      }
      return s
    }

    // Cold path: full filesystem scan
    console.log(`[skill cache] snapshot miss, full scan`)
    const all: RawState = { skills: {}, dirs: new Set() }
    await loadSkillsFromDirs(all, _discovery!, directory, worktree)

    // Write snapshot before applying disabled filter (snapshot stores unfiltered, mirrors Hermes)
    await writeSkillsSnapshot(manifest, Object.values(all.skills))

    for (const name of disabled) {
      if (all.skills[name]) {
        delete all.skills[name]
        log.info("skill disabled by config", { name })
      }
    }

    return all
  }

  async function loadSkills(state: RawState, discovery: Discovery.Interface, directory: string, worktree: string) {
    console.log(`[skill cache] memory miss, loading from disk (dir=${directory})`)
    const data = await loadSkillsData(directory, worktree)
    state.skills = data.skills
    state.dirs = data.dirs
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
            yield* Effect.promise(() => loadSkills(s, discovery, ctx.directory, ctx.worktree))
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
      await fs.unlink(skillsPromptSnapshotPath()).catch(() => {})
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
