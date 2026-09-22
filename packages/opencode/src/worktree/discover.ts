import path from "path"
import { readdirSync } from "fs"
import { Global } from "../global"
import { Log } from "../util/log"
import { Database } from "../storage/db"
import { Project } from "../project/project"
import type { ProjectID } from "../project/schema"

export namespace WorktreeDiscover {
  const log = Log.create({ service: "worktree.discover" })

  const INTERVAL = 5_000

  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false
  const seen = new Map<string, Set<string>>()

  export function root(pid: string) {
    return path.join(Global.Path.data, "worktree", pid)
  }

  function subdirs(dir: string) {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }

  /**
   * One discovery pass over the managed worktree storage root. Worktrees
   * created externally (plain `git worktree add` under
   * <data>/worktree/<projectID>/) exist only in git metadata between
   * startups, so this pass watches for newly appearing storage
   * subdirectories and routes them through Project.syncWorktrees — the same
   * bootstrap path startup reconciliation uses — keeping registration, dedup
   * and ghost-quarantine semantics identical. Directory names are compared
   * only against the last snapshot: paths are never matched textually here
   * because git reports realpath'd worktree paths while the storage root may
   * sit under a symlink; syncWorktrees is idempotent and remains the
   * authority on what is already registered. Untracked residue can never be
   * resurrected: only directories git itself reports are registered, and
   * projects without a live database are skipped before any attach.
   */
  export async function poll() {
    const base = path.join(Global.Path.data, "worktree")
    for (const entry of subdirs(base)) {
      const pid = entry as ProjectID
      try {
        if (!Database.hasProject(pid)) continue
        const project = Project.get(pid)
        if (!project || project.vcs !== "git" || Project.norm(project.worktree) === "/") continue
        const names = new Set(subdirs(root(pid)))
        const prev = seen.get(pid)
        const added = prev ? [...names].filter((name) => !prev.has(name)) : [...names]
        if (!added.length) continue
        log.info("discovered external worktree directories", { pid, directories: added })
        await Project.syncWorktrees(pid, project.worktree)
        // snapshot only after a successful pass so a failed sync is retried
        seen.set(pid, names)
      } catch (error) {
        log.warn("worktree discovery failed for project", { pid, error: String(error) })
      }
    }
  }

  export function start() {
    if (timer) return
    timer = setInterval(() => {
      if (polling) return
      polling = true
      poll()
        .catch((error) => log.warn("worktree discovery failed", { error: String(error) }))
        .finally(() => {
          polling = false
        })
    }, INTERVAL)
    timer.unref?.()
  }

  export async function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }
}
