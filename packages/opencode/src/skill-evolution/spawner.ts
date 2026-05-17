import path from "path"
import { Global } from "@/global"

export namespace Spawner {
  /**
   * Compute the folder name for a project's skill-sessions directory.
   * Format: "<sanitized-basename>-<short-id>" so the folder is human-readable
   * at a glance (e.g. "Aether-a3f2bc1d") rather than a raw hash.
   */
  export function skillFolderName(projectDirectory: string, projectId: string): string {
    const base = path.basename(projectDirectory)
    const safe = base.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
    const short = projectId.slice(0, 8)
    return safe ? `${safe}-${short}` : short
  }

  /**
   * Directory where AI background-review sessions write skill files for a
   * given project. Skills here are project-scoped with the lowest priority —
   * any user-placed source (including shadow-writer output) overrides them.
   */
  export function skillSessionsDir(folderName: string): string {
    return path.join(Global.Path.home, ".aether", "skill-sessions", folderName, "skills")
  }

  /**
   * Base directory for a project's skill-sessions storage (parent of the
   * skills/ subdirectory). Useful for placing the session DB and other
   * per-project evolution artefacts alongside the skills.
   */
  export function skillSessionsBase(folderName: string): string {
    return path.join(Global.Path.home, ".aether", "skill-sessions", folderName)
  }
}
