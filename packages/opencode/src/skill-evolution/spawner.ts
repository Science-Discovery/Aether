import path from "path"
import { Global } from "@/global"

export namespace Spawner {
  /**
   * Directory where AI background-review sessions write skill files for a
   * given project. Skills here are project-scoped with the lowest priority —
   * any user-placed source (including shadow-writer output) overrides them.
   */
  export function skillSessionsDir(projectId: string): string {
    return path.join(Global.Path.home, ".aether", "skill-sessions", projectId, "skills")
  }

  /**
   * Base directory for a project's skill-sessions storage (parent of the
   * skills/ subdirectory). Useful for placing the session DB and other
   * per-project evolution artefacts alongside the skills.
   */
  export function skillSessionsBase(projectId: string): string {
    return path.join(Global.Path.home, ".aether", "skill-sessions", projectId)
  }
}
