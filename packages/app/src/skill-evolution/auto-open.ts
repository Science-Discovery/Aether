import { createEffect } from "solid-js"
import type { useGlobalSync } from "@/context/global-sync"
import type { useServer } from "@/context/server"

type GlobalSync = ReturnType<typeof useGlobalSync>
type Server = ReturnType<typeof useServer>

const SKILL_SESSIONS_SUBPATH = "/.aether/skill-sessions"
const STORAGE_KEY = "skill-sessions-last-auto-open"

const normalizeSep = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

/**
 * Auto-open the skill-sessions project whenever a new background review is spawned.
 * Uses time.activity to distinguish a fresh review from a page reload: only opens
 * if the project's activity timestamp is newer than the last time we auto-opened it.
 */
export function setupSkillSessionsAutoOpen(globalSync: GlobalSync, server: Server): void {
  createEffect(() => {
    const home = globalSync.data.path.home
    if (!home) return
    const target = normalizeSep(`${home}${SKILL_SESSIONS_SUBPATH}`)
    const found = globalSync.project
      .recent()
      .find((item) => item.kind === "project" && normalizeSep(item.directory) === target)
    if (!found) return

    const lastAutoOpen = parseInt(localStorage.getItem(STORAGE_KEY) ?? "0", 10)
    if (found.time.activity <= lastAutoOpen) return

    localStorage.setItem(STORAGE_KEY, String(found.time.activity))
    globalSync.project.loadSessions(found.directory)
    const alreadyOpen = server.projects.list().some((p) => normalizeSep(p.worktree) === target)
    if (!alreadyOpen) server.projects.open(found.directory)
  })
}
