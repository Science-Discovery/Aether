import { createEffect } from "solid-js"
import type { useGlobalSync } from "@/context/global-sync"
import type { useServer } from "@/context/server"

type GlobalSync = ReturnType<typeof useGlobalSync>
type Server = ReturnType<typeof useServer>

const SKILL_SESSIONS_SUBPATH = "/.aether/skill-sessions"

const normalizeSep = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

/**
 * Auto-open the skill-sessions project in the sidebar so users can see background
 * skill-evolution reviews. The project is created server-side by spawnReview but the
 * sidebar's persisted list only tracks projects the user has explicitly opened — so
 * without this hook the project stays invisible until the user finds it on the home
 * "recent projects" page.
 *
 * Fires once per page load: guarded by a closure flag, so users can still close the
 * project manually without it being re-opened until the next refresh.
 */
export function setupSkillSessionsAutoOpen(globalSync: GlobalSync, server: Server): void {
  let opened = false
  createEffect(() => {
    if (opened) return
    const home = globalSync.data.path.home
    if (!home) return
    const target = normalizeSep(`${home}${SKILL_SESSIONS_SUBPATH}`)
    const found = globalSync.project
      .recent()
      .find((item) => item.kind === "project" && normalizeSep(item.directory) === target)
    if (!found) return
    opened = true
    const alreadyOpen = server.projects.list().some((p) => normalizeSep(p.worktree) === target)
    if (alreadyOpen) return
    globalSync.project.loadSessions(found.directory)
    server.projects.open(found.directory)
  })
}
