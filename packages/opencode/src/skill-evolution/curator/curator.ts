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
  ): Promise<{ key: string; projectId: string; name: string; location: string }[]> {
    const out: { key: string; projectId: string; name: string; location: string }[] = []
    const projects = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const pe of projects) {
      if (!pe.isDirectory() || pe.name === "curator" || pe.name.startsWith(".")) continue
      const skillsDir = path.join(root, pe.name, "skills")
      const skillDirs = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => [])
      for (const se of skillDirs) {
        if (!se.isDirectory()) continue
        const location = path.join(skillsDir, se.name)
        // SKILL.md must exist for the dir to count as a skill (mtime no longer used).
        const exists = await fs.access(path.join(location, "SKILL.md")).then(
          () => true,
          () => false,
        )
        if (!exists) continue
        out.push({ key: `${pe.name}/${se.name}`, projectId: pe.name, name: se.name, location })
      }
    }
    return out
  }

  /**
   * Pure-logic lifecycle pass (no AI). Scans every in-scope skill, seeds missing
   * records, drives active→stale→archived by consecutive idle scans (scans with no
   * new use), reactivates skills used since the last scan, and prunes orphan
   * records. The criterion has zero calendar dependency — changing the system clock
   * can't mass-archive. Pinned skills are skipped. Returns a change counter.
   */
  export async function applyAutomaticTransitions(
    root: string,
    opts: { now?: Date; config?: CuratorConfig } = {},
  ): Promise<TransitionCounts> {
    const now = opts.now ?? new Date()
    const config = opts.config ?? DEFAULT_CURATOR_CONFIG
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
        // First sight: seed a baseline record and DEFER judgment this scan (§2).
        await Usage.seedIfMissing(root, s.location)
        counts.seeded++
        continue
      }

      const data = await Usage.load(root)
      const rec = data[s.key]
      if (!rec || rec.pinned) continue

      // Legacy ledger missing the new fields → establish a baseline this scan, defer
      // judgment (D13: an upgrade must never archive anyone for lacking fields).
      if (typeof rec.use_count_at_last_scan !== "number" || typeof rec.idle_scans !== "number") {
        await Usage.recordScanResult(root, s.key, { idle_scans: 0, use_count_at_last_scan: rec.use_count })
        continue
      }

      // Used since last scan = use_count grew. The criterion has zero calendar
      // dependency — last_used_at and SKILL.md mtime no longer decide archiving.
      const used = rec.use_count > rec.use_count_at_last_scan
      let idleScans: number
      if (used) {
        idleScans = 0 // reset the moment a use is seen → no death spiral
        if (rec.state === "stale") {
          await Usage.setState(root, s.key, "active", now)
          counts.reactivated++
        }
      } else {
        idleScans = rec.idle_scans + 1
        if (idleScans >= config.archiveAfterIdleScans && rec.state !== "archived") {
          if (await Usage.archiveSkill(root, s.key, now)) counts.archived++
        } else if (idleScans >= config.staleAfterIdleScans && rec.state === "active") {
          await Usage.setState(root, s.key, "stale", now)
          counts.marked_stale++
        }
      }
      // Leave the baseline for next scan's comparison.
      await Usage.recordScanResult(root, s.key, { idle_scans: idleScans, use_count_at_last_scan: rec.use_count })
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
