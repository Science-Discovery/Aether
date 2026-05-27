import path from "path"
import { Global } from "@/global"

export namespace Spawner {
  /**
   * Compute the folder name for a project's skill-evolution directory.
   * Returns the projectId as-is (a stable hex hash). Folders are addressed
   * by hash, not by human-readable name — pair with skillEvolutionShared()
   * to distinguish project sub-folders from the shared/ container reserved
   * for the future curator.
   */
  export function skillFolderName(_projectDirectory: string, projectId: string): string {
    return projectId
  }

  /**
   * Root of the skill-evolution data area:
   *   ~/.local/share/aether/skill-evolution/
   * Subdirectories are either <projectId>/ (review sub-projects) or
   * shared/ (curator-promoted cross-project skills, future).
   */
  export function skillEvolutionRoot(): string {
    return path.join(Global.Path.data, "skill-evolution")
  }

  /**
   * Container for curator-promoted shared skills (reserved namespace, not
   * created in the current PR). Lives next to <projectId>/ sub-folders so
   * any scanner of skillEvolutionRoot() needs to treat shared/ as a special
   * kind of sub-folder.
   */
  export function skillEvolutionShared(): string {
    return path.join(skillEvolutionRoot(), "shared")
  }

  /**
   * Directory where AI background-review sessions write skill files for a
   * given project. Skills here are project-scoped with the lowest priority —
   * any user-placed source (including shadow-writer output) overrides them.
   */
  export function skillEvolutionDir(folderName: string): string {
    return path.join(skillEvolutionRoot(), folderName, "skills")
  }

  /**
   * Base directory for a project's skill-evolution storage (parent of the
   * skills/ subdirectory). The per-project SQLite DB lives here too:
   *   <base>/aether-<projectId>.db
   */
  export function skillEvolutionBase(folderName: string): string {
    return path.join(skillEvolutionRoot(), folderName)
  }
}
