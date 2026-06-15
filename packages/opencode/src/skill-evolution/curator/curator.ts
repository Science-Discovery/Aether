import fs from "fs/promises"
import path from "path"
import { Usage } from "./usage"
import { type CuratorConfig, DEFAULT_CURATOR_CONFIG } from "./constants"

/** Scheduler state, persisted at `<root>/curator/state.json`. */
export interface CuratorState {
  lastRunAt: string | null
  paused: boolean
  runCount: number
}

function defaultState(): CuratorState {
  return { lastRunAt: null, paused: false, runCount: 0 }
}

export namespace Curator {
  function curatorDir(root: string): string {
    return path.join(root, "curator")
  }

  function stateFile(root: string): string {
    return path.join(curatorDir(root), "state.json")
  }

  /** Read scheduler state. Returns defaults on missing/corrupt (never throws). */
  export async function loadState(root: string): Promise<CuratorState> {
    const raw = await fs.readFile(stateFile(root), "utf-8").catch(() => null)
    if (raw === null) return defaultState()
    try {
      const data = JSON.parse(raw)
      if (!data || typeof data !== "object" || Array.isArray(data)) return defaultState()
      return { ...defaultState(), ...data }
    } catch {
      return defaultState()
    }
  }

  /** Write scheduler state atomically (temp file + rename). */
  export async function saveState(root: string, state: CuratorState): Promise<void> {
    const dir = curatorDir(root)
    await fs.mkdir(dir, { recursive: true })
    const tmp = path.join(dir, `.state.${process.pid}.tmp`)
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf-8")
    await fs.rename(tmp, stateFile(root))
  }

  /**
   * Whether the curator should run now. Gates:
   *  - config.enabled
   *  - not paused
   *  - lastRunAt present AND older than intervalHours
   *
   * First run (lastRunAt empty): seed lastRunAt to now and DEFER — do not run on
   * the first observation; wait one full interval. Matches Hermes should_run_now.
   */
  export async function shouldRunNow(
    root: string,
    opts: { now?: Date; config?: CuratorConfig } = {},
  ): Promise<boolean> {
    const now = opts.now ?? new Date()
    const config = opts.config ?? DEFAULT_CURATOR_CONFIG

    if (!config.enabled) return false

    const state = await loadState(root)
    if (state.paused) return false

    if (!state.lastRunAt) {
      // Never run before — seed and defer a full interval (report-only first sight).
      await saveState(root, { ...state, lastRunAt: now.toISOString() })
      return false
    }

    const elapsedHours = (now.getTime() - new Date(state.lastRunAt).getTime()) / 3600_000
    return elapsedHours >= config.intervalHours
  }

  export interface TransitionCounts {
    checked: number
    seeded: number
    marked_stale: number
    reactivated: number
    archived: number
    orphans: number
    healed: number
  }

  /** Enumerate in-scope skills on disk: `<root>/<projectId>/skills/<name>/SKILL.md`. */
  async function scanSkills(
    root: string,
  ): Promise<{ key: string; projectId: string; name: string; location: string; mtimeMs: number }[]> {
    const out: { key: string; projectId: string; name: string; location: string; mtimeMs: number }[] = []
    const projects = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const pe of projects) {
      if (!pe.isDirectory() || pe.name === "curator" || pe.name.startsWith(".")) continue
      const skillsDir = path.join(root, pe.name, "skills")
      const skillDirs = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => [])
      for (const se of skillDirs) {
        if (!se.isDirectory()) continue
        const location = path.join(skillsDir, se.name)
        const stat = await fs.stat(path.join(location, "SKILL.md")).catch(() => null)
        if (!stat) continue
        out.push({ key: `${pe.name}/${se.name}`, projectId: pe.name, name: se.name, location, mtimeMs: stat.mtimeMs })
      }
    }
    return out
  }

  /**
   * Pure-logic lifecycle pass (no AI). Scans every in-scope skill, seeds missing
   * records, drives active→stale→archived by activity, reactivates revived
   * skills, and prunes orphan records. Activity anchor = max(last_used_at,
   * SKILL.md mtime). Pinned skills are skipped. Returns a change counter.
   */
  export async function applyAutomaticTransitions(
    root: string,
    opts: { now?: Date; config?: CuratorConfig } = {},
  ): Promise<TransitionCounts> {
    const now = opts.now ?? new Date()
    const config = opts.config ?? DEFAULT_CURATOR_CONFIG
    const DAY = 24 * 3600_000
    const counts: TransitionCounts = {
      checked: 0,
      seeded: 0,
      marked_stale: 0,
      reactivated: 0,
      archived: 0,
      orphans: 0,
      healed: 0,
    }

    for (const s of await scanSkills(root)) {
      counts.checked++

      const before = await Usage.load(root)
      if (!before[s.key]) {
        await Usage.seedIfMissing(root, s.location)
        counts.seeded++
      }

      const data = await Usage.load(root)
      const rec = data[s.key]
      if (!rec || rec.pinned) continue

      // Activity anchor = newest of (last load, last file change).
      const lastUsedMs = rec.last_used_at ? new Date(rec.last_used_at).getTime() : -Infinity
      const daysSince = (now.getTime() - Math.max(lastUsedMs, s.mtimeMs)) / DAY

      if (daysSince >= config.archiveAfterDays && rec.state !== "archived") {
        if (await Usage.archiveSkill(root, s.key, now)) counts.archived++
      } else if (daysSince >= config.staleAfterDays && rec.state === "active") {
        await Usage.setState(root, s.key, "stale", now)
        counts.marked_stale++
      } else if (daysSince < config.staleAfterDays && rec.state === "stale") {
        await Usage.setState(root, s.key, "active", now)
        counts.reactivated++
      }
    }

    // Orphan cleanup: a non-archived record whose skill directory is gone.
    // Two causes look identical (state≠archived + location missing):
    //  - true orphan: skill deleted out-of-band (e.g. skill_manage delete) → forget.
    //  - fake orphan: a concurrent write clobbered state back to active AFTER the
    //    dir was moved to archive/ → heal back to archived, don't forget (else the
    //    archived copy loses its ledger entry and becomes unrecoverable).
    // Archived records legitimately have a non-existent location, so skip them.
    const ledger = await Usage.load(root)
    for (const [key, rec] of Object.entries(ledger)) {
      if (rec.state === "archived") continue
      const live = await fs.access(rec.location).then(
        () => true,
        () => false,
      )
      if (live) continue
      if (await Usage.hasArchivedCopy(root, rec.projectId, rec.name)) {
        await Usage.setState(root, key, "archived", now)
        counts.healed++
      } else {
        await Usage.forget(root, key)
        counts.orphans++
      }
    }

    return counts
  }

  /**
   * Entry point called from the onLoopEnd hook. Runs a pass only when the gates
   * pass; on a real run, applies transitions then advances lastRunAt/runCount.
   * Best-effort — never throws (a curator failure must not break a session).
   * Returns the change counts when a pass ran, else null.
   */
  export async function maybeRun(
    root: string,
    opts: { now?: Date; config?: CuratorConfig } = {},
  ): Promise<TransitionCounts | null> {
    const now = opts.now ?? new Date()
    try {
      if (!(await shouldRunNow(root, { now, config: opts.config }))) return null
      const counts = await applyAutomaticTransitions(root, { now, config: opts.config })
      const state = await loadState(root)
      await saveState(root, { ...state, lastRunAt: now.toISOString(), runCount: state.runCount + 1 })
      return counts
    } catch {
      // Best-effort: a curator failure must never break the session.
      return null
    }
  }
}
