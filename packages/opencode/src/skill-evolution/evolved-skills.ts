import fs from "fs/promises"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { Spawner } from "./spawner"

/**
 * Evolved Skills management for the "自进化 Skills" dialog button.
 *
 * Scope:
 *   - list: enumerate evolved skills from the project's .aether/skills/ and the
 *     global skill-evolution/<projectId>/skills/ directories.
 *   - toggleEnabled / toggleEvolution: flip a single frontmatter flag on a
 *     skill's SKILL.md, identified by its absolute file path.
 *
 * Layering: this module is pure file logic. It receives an already-resolved
 * `projectId` (the route layer resolves it via Project.fromDirectory, matching
 * how Skill.available() locates the same skill-evolution folder). It never
 * touches the watcher or invalidates caches — a toggled skill is picked up the
 * next time Skill.available() reads from disk.
 */

export type EvolvedSkill = {
  name: string
  description: string
  content: string
  category?: string
  enabled?: boolean
  evolution_enabled?: boolean
  file: string
}

const SKILL_FILE = "SKILL.md"

// ── Frontmatter parsing ───────────────────────────────────────────────────────

type Frontmatter = { meta: Record<string, string>; body: string }

function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith("---")) return { meta: {}, body: content }
  const end = content.indexOf("\n---", 3)
  if (end === -1) return { meta: {}, body: content }
  const raw = content.slice(3, end).trim()
  const body = content.slice(end + 4).replace(/^\n/, "")
  const meta: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const val = line
      .slice(colon + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "")
    if (key) meta[key] = val
  }
  return { meta, body }
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === "true") return true
  if (value === "false") return false
  return undefined
}

// ── Directory scanning ────────────────────────────────────────────────────────

/** Return absolute paths of every `<dir>/<child>/SKILL.md` that exists. */
async function skillFilesInContainer(container: string): Promise<string[]> {
  if (!(await Filesystem.isDir(container))) return []
  const entries = await fs.readdir(container, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(container, entry.name, SKILL_FILE)
    if (await Filesystem.exists(file)) files.push(file)
  }
  return files
}

/**
 * Collect the skill-container directories to scan for the current project, in
 * priority order:
 *   1. <directory>/.aether/skills/             (user-placed shadow skills)
 *   2. skillEvolutionDir(<projectId>)          (AI background-review skills)
 *
 * The skill-evolution root holds one folder per project, addressed by the
 * project's id. `projectId` must be the same id the write side used (resolved
 * by the route via Project.fromDirectory), or this misses the project's own
 * folder and/or leaks another project's skills.
 */
function evolvedContainers(directory: string, projectId: string): string[] {
  const containers: string[] = []
  if (directory) containers.push(path.join(directory, ".aether", "skills"))
  if (projectId) containers.push(Spawner.skillEvolutionDir(Spawner.skillFolderName(directory, projectId)))
  return containers
}

async function readSkill(file: string): Promise<EvolvedSkill | undefined> {
  const content = await Filesystem.readText(file).catch(() => undefined)
  if (content === undefined) return undefined
  const { meta, body } = parseFrontmatter(content)
  const name = meta.name?.trim() || path.basename(path.dirname(file))
  return {
    name,
    description: meta.description ?? "",
    content: body,
    category: meta.category?.trim() || undefined,
    enabled: parseBool(meta.enabled),
    evolution_enabled: parseBool(meta.evolution_enabled),
    file,
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export namespace EvolvedSkills {
  /**
   * List evolved skills visible to a project (project shadow + skill-evolution).
   * `projectId` is the resolved Project.id for `directory` (see module header).
   */
  export async function list(directory: string, projectId: string): Promise<EvolvedSkill[]> {
    const containers = evolvedContainers(directory, projectId)
    const fileSets = await Promise.all(containers.map(skillFilesInContainer))
    const files = fileSets.flat()
    const skills = await Promise.all(files.map(readSkill))
    return skills.filter((s): s is EvolvedSkill => s !== undefined)
  }
}
