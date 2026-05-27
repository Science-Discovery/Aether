import { createEffect } from "solid-js"
import type { useGlobalSync } from "@/context/global-sync"
import type { useServer } from "@/context/server"

type GlobalSync = ReturnType<typeof useGlobalSync>
type Server = ReturnType<typeof useServer>

const SKILL_EVOLUTION_SUBPATH = "/skill-evolution"
const STORAGE_KEY = "skill-evolution-last-auto-open"

const normalizeSep = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

/**
 * Auto-open the skill-evolution project whenever a new background review is spawned.
 * Uses time.activity to distinguish a fresh review from a page reload: only opens
 * if the project's activity timestamp is newer than the last time we auto-opened it.
 */
export function setupSkillEvolutionAutoOpen(globalSync: GlobalSync, server: Server): void {
  createEffect(() => {
    const data = globalSync.data.path.data
    if (!data) return
    const target = normalizeSep(`${data}${SKILL_EVOLUTION_SUBPATH}`)
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
