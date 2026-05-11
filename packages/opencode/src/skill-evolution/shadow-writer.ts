import fs from "fs/promises"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { Global } from "@/global"

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
   *   2. If created by AI background review → ~/.aether/skill-sessions/<projectId>/skills/<name>/
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
      return path.join(Global.Path.home, ".aether", "skill-sessions", sessionProjectId, "skills", skillName)
    }
    return path.join(Global.Path.home, ".aether", "skills", skillName)
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
