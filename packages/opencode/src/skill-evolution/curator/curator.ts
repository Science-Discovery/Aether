import fs from "fs/promises"
import path from "path"
import { Usage } from "./usage"
import { type CuratorConfig, DEFAULT_CURATOR_CONFIG } from "./constants"
import { ConfigMarkdown } from "../../config/markdown"

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

  /**
   * Enumerate in-scope skills on disk: `<root>/<projectId>/skills/<name>/SKILL.md`.
   * Parses each SKILL.md with the SAME parser the skill loader uses (ConfigMarkdown /
   * gray-matter) — NOT a private regex — so the `id` extracted here always matches the
   * id bumpUse keys by; otherwise a non-canonical id (unquoted, trailing comment, …)
   * would split one skill into two ledger keys. Parse failure / missing file → skip
   * (consistent with the loader, which won't load it either). See SKILL_IDENTITY_DESIGN.md.
   */
  async function scanSkills(
    root: string,
  ): Promise<{ key: string; projectId: string; name: string; location: string; id?: string }[]> {
    const out: { key: string; projectId: string; name: string; location: string; id?: string }[] = []
    const projects = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const pe of projects) {
      if (!pe.isDirectory() || pe.name === "curator" || pe.name.startsWith(".")) continue
      const skillsDir = path.join(root, pe.name, "skills")
      const skillDirs = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => [])
      for (const se of skillDirs) {
        if (!se.isDirectory()) continue
        const location = path.join(skillsDir, se.name)
        const md = await ConfigMarkdown.parse(path.join(location, "SKILL.md")).catch(() => null)
        if (!md) continue
        const id = typeof md.data.id === "string" ? md.data.id : undefined
        const key = id ? `${pe.name}/${id}` : `${pe.name}/${se.name}`
        out.push({ key, projectId: pe.name, name: se.name, location, id })
      }
    }
    return out
  }

  /**
   * Pure-logic lifecycle pass (no AI). Reads the ledger ONCE for the archive
   * DECISIONS (so the denominator isn't re-summed per skill), but applies every
   * actual change through a narrow read-modify-write (seedIfMissing/archiveSkill/
   * setState) that re-reads the latest ledger and rewrites only the touched record.
   * That keeps a concurrent bumpUse on the skill-load hot path from being clobbered
   * by a stale whole-ledger overwrite. For every in-scope skill on disk: seed a
   * missing record, else archive it when its post-birth call share within its own
   * project falls below archiveUsageShare (once exposure clears the minExposureCalls
   * trial window). Finally prune orphan records whose directory is gone: heal→archived
   * if an archived copy exists, else tombstone→deleted (retaining use_count in the
   * project denominator, D6). Pinned skills are never archived. Returns a change counter.
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

    // Read the ledger ONCE for the decisions below; the denominator (per-project total
    // use_count) is the same for every skill in a project, so compute it once up front
    // instead of re-summing per skill. Writes go through narrow helpers (see docstring).
    const data = await Usage.load(root)
    const projectTotals = new Map<string, number>()
    for (const rec of Object.values(data)) {
      projectTotals.set(rec.projectId, (projectTotals.get(rec.projectId) ?? 0) + rec.use_count)
    }

    for (const s of await scanSkills(root)) {
      counts.checked++

      const rec = data[s.key]
      if (!rec) {
        // Newly seen on disk → seed a baseline record (narrow write). A freshly seeded
        // skill has exposure 0 (born = current total), so it's never archived this pass.
        await Usage.seedIfMissing(root, s.location, s.id)
        counts.seeded++
        continue
      }
      if (rec.pinned || rec.state === "archived" || rec.state === "deleted") continue

      // Archive judgment: relative call share over the post-birth exposure window,
      // measured WITHIN the skill's own project (skills are project-isolated, so
      // other projects' calls are chances it never had). See RELATIVE_USAGE_DESIGN.md.
      const exposure = (projectTotals.get(rec.projectId) ?? 0) - rec.born_at_project_total
      // Birth trial window: too few post-birth chances yet → not judged (also guards
      // exposure ≤ 0, e.g. an empty/zero-total project, against a divide-by-zero share).
      if (exposure < config.minExposureCalls) continue
      const share = rec.use_count / exposure
      if (share < config.archiveUsageShare) {
        if (await Usage.archiveSkill(root, s.key, now)) counts.archived++
      }
    }

    // Orphan cleanup: re-read the latest ledger (now reflecting this pass's seeds/archives
    // plus any concurrent bumpUse) and act on each record whose skill directory is gone.
    // Two causes look identical (state active + location missing):
    //  - true orphan: skill deleted out-of-band (e.g. skill_manage delete) → tombstone
    //    as `deleted`, keeping its use_count in the project denominator (D6).
    //  - fake orphan: a concurrent write clobbered state back to active AFTER the dir
    //    was moved to archive/ → heal back to `archived` (an archived copy exists).
    // Archived/deleted records legitimately have a non-existent location, so skip them.
    const ledger = await Usage.load(root)
    for (const [key, rec] of Object.entries(ledger)) {
      if (rec.state === "archived" || rec.state === "deleted") continue
      const live = await fs.access(rec.location).then(
        () => true,
        () => false,
      )
      if (live) continue
      if (await Usage.hasArchivedCopy(root, rec.projectId, rec.name)) {
        await Usage.setState(root, key, "archived", now)
        counts.healed++
      } else {
        await Usage.setState(root, key, "deleted", now)
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
