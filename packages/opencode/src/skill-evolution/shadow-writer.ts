import fs from "fs/promises"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { Global } from "@/global"
import { Spawner } from "./spawner"

const CONFIG_MARKERS = [".claude", ".agents", ".opencode", ".aether"] as const

export namespace ShadowWriter {
  /**
   * Find the innermost config marker directory component in a path and return
   * the directory that contains it (the "base"). Scans right-to-left so that
   * a path like /project/.claude/skills/foo/SKILL.md returns /project.
   */
  function findBase(skillPath: string): string | undefined {
    const parts = skillPath.split(path.sep)
    for (let i = parts.length - 1; i >= 0; i--) {
      if ((CONFIG_MARKERS as readonly string[]).includes(parts[i])) {
        const base = parts.slice(0, i).join(path.sep)
        return base || path.sep
      }
    }
    return undefined
  }

  /**
   * Compute the shadow directory for a skill (copy-on-write target).
   *
   * Priority (matches loadSkills scan order):
   *   1. If the skill has a known source location → <base>/.aether/skills/<name>/
   *      where base = parent of the nearest config marker in the path
   *   2. If created by AI background review → <skill-evolution-root>/<projectId>/skills/<name>/
   *   3. Fallback → ~/.aether/skills/<name>/
   */
  export function resolveSkillDir(skillName: string, skillLocation?: string, sessionProjectId?: string): string {
    if (skillLocation) {
      const base = findBase(skillLocation)
      if (base) {
        return path.join(base, ".aether", "skills", skillName)
      }
    }
    if (sessionProjectId) {
      return path.join(Spawner.skillEvolutionDir(sessionProjectId), skillName)
    }
    return path.join(Global.Path.home, ".aether", "skills", skillName)
  }

  /**
   * Validate that a skillLocation path points inside a known skills directory.
   * Rejects paths that could cause sensitive directories (e.g. ~/.ssh) to be
   * recursively copied into the shadow area.
   *
   * A valid skillLocation must contain a CONFIG_MARKER component immediately
   * followed by a "skills" component, e.g. /project/.claude/skills/foo/SKILL.md.
   * path.resolve() is called first to normalize away any ".." traversal.
   */
  export function validateSkillLocation(skillLocation: string): boolean {
    const parts = path.resolve(skillLocation).split(path.sep).filter(Boolean)
    for (let i = 0; i < parts.length - 1; i++) {
      if ((CONFIG_MARKERS as readonly string[]).includes(parts[i]) && parts[i + 1] === "skills") {
        return true
      }
    }
    return false
  }

  /**
   * Copy the original skill directory to the shadow location if the shadow does
   * not already exist. This establishes the copy-on-write baseline so the
   * original files are never modified.
   */
  export async function copyToShadowIfNeeded(originalDir: string, shadowDir: string): Promise<void> {
    if (await Filesystem.isDir(shadowDir)) return
    await fs.cp(originalDir, shadowDir, { recursive: true })
  }
}
