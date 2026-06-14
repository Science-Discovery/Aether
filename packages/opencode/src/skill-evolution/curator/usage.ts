import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * A single skill-use coordinate. Pointer only — the full session lives in the
 * session DB and is fetched back by `session_id` when evaluation is needed.
 * No `projectId`: the ledger key already scopes a record to one project. See
 * SESSION_USAGE_DESIGN.md D16.
 */
export interface UseEvent {
  /** Which session this use happened in (from ctx.sessionID). */
  session_id: string
  /** When it happened (UTC ISO 8601). */
  at: string
}

/**
 * Per-skill usage record. Stored in the curator ledger
 * (`<root>/curator/usage.json`), keyed by `"<projectId>/<name>"`.
 *
 * Only skills under `<root>/<projectId>/skills/` are tracked — that directory
 * is skill-evolution's exclusive AI output area, so location alone determines
 * provenance (no `created_by` marker needed). See CURATOR_DESIGN.md D5/D8.
 */
export interface UsageRecord {
  projectId: string
  name: string
  /** Absolute path to the skill directory (lets archive/restore locate it). */
  location: string
  use_count: number
  /** Snapshot of use_count at the previous scan; compared against use_count to tell if used since. */
  use_count_at_last_scan: number
  /** Consecutive scans with no new use; reset to 0 the moment a use is seen. */
  idle_scans: number
  /** Last load time. Kept as info only — no longer part of the archive criterion. */
  last_used_at: string | null
  /**
   * Recent-window cache of the last MAX_RECENT_USES use coordinates, oldest
   * first. NOT the source of truth — the session DB holds the authoritative full
   * history; this is a convenience index so the curator carries a ready recent
   * window. Each bumpUse with a sessionId appends one; over the cap the oldest
   * are dropped from the front. See SESSION_USAGE_DESIGN.md D17/D19.
   */
  recent_uses: UseEvent[]
  state: "active" | "stale" | "archived"
  /** Skip auto-transitions. Read-only in this version (no setter, see Q2). */
  pinned: boolean
  archived_at: string | null
}

export namespace Usage {
  /**
   * Cap on `recent_uses` length; over it, the oldest events are dropped. A
   * storage detail, not a user-tunable archive knob, so it lives here and not in
   * CuratorConfig (YAGNI). See SESSION_USAGE_DESIGN.md Q-N.
   */
  export const MAX_RECENT_USES = 50

  function curatorDir(root: string): string {
    return path.join(root, "curator")
  }

  function usageFile(root: string): string {
    return path.join(curatorDir(root), "usage.json")
  }

  /**
   * Resolve a skill location to its ledger key + scope.
   * Returns null when the location is NOT under `<root>/<projectId>/skills/<name>`
   * (i.e. out of curator's scope — bundled / global / project-local skills).
   */
  function resolveScope(
    root: string,
    location: string,
  ): { key: string; projectId: string; name: string; skillDir: string } | null {
    const skillDir = location.endsWith("SKILL.md") ? path.dirname(location) : location
    const rel = path.relative(root, skillDir)
    const parts = rel.split(path.sep)
    if (parts.length !== 3) return null
    const [projectId, mid, name] = parts
    if (!projectId || mid !== "skills" || !name || projectId.startsWith("..")) return null
    return { key: `${projectId}/${name}`, projectId, name, skillDir }
  }

  function emptyRecord(scope: { projectId: string; name: string; skillDir: string }): UsageRecord {
    return {
      projectId: scope.projectId,
      name: scope.name,
      location: scope.skillDir,
      use_count: 0,
      use_count_at_last_scan: 0,
      idle_scans: 0,
      last_used_at: null,
      recent_uses: [],
      state: "active",
      pinned: false,
      archived_at: null,
    }
  }

  /** Read the whole ledger. Returns {} on missing/corrupt (defensive, never throws). */
  export async function load(root: string): Promise<Record<string, UsageRecord>> {
    const raw = await fs.readFile(usageFile(root), "utf-8").catch(() => null)
    if (raw === null) return {}
    try {
      const data = JSON.parse(raw)
      if (!data || typeof data !== "object" || Array.isArray(data)) return {}
      const clean: Record<string, UsageRecord> = {}
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object") {
          const rec = v as UsageRecord
          // Legacy records predate recent_uses; backfill so .push never throws.
          if (!Array.isArray(rec.recent_uses)) rec.recent_uses = []
          clean[k] = rec
        }
      }
      return clean
    } catch {
      return {}
    }
  }

  /** Write the ledger atomically (temp file + rename). Best-effort. */
  async function save(root: string, data: Record<string, UsageRecord>): Promise<void> {
    const dir = curatorDir(root)
    await fs.mkdir(dir, { recursive: true })
    const tmp = path.join(dir, `.usage.${process.pid}.${os.hostname()}.tmp`)
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8")
    await fs.rename(tmp, usageFile(root))
  }

  /**
   * Record that a skill was loaded/used. Upsert: creates the record on first
   * sight (use_count starts at 1) so usage is counted even before the curator's
   * first scan. No-op for out-of-scope skills. Best-effort — never throws.
   */
  function archiveRoot(root: string, projectId: string): string {
    return path.join(root, projectId, "archive")
  }

  async function pathExists(p: string): Promise<boolean> {
    return fs.access(p).then(
      () => true,
      () => false,
    )
  }

  /**
   * Whether an archived copy of a skill exists at `<root>/<projectId>/archive/<name>/`.
   * Used by orphan cleanup to tell a true orphan (skill deleted out-of-band) from a
   * fake one (record state clobbered back from `archived` to `active` by a concurrent
   * write while the directory was already moved to archive/). Exact-match only: a
   * timestamp-suffixed copy from an archive name-collision is not detected.
   */
  export async function hasArchivedCopy(root: string, projectId: string, name: string): Promise<boolean> {
    return pathExists(path.join(archiveRoot(root, projectId), name))
  }

  /**
   * Archive a skill: move its directory to `<root>/<projectId>/archive/<name>/`
   * and mark the ledger record `archived`. The directory is MOVED (recoverable),
   * never deleted. Returns false if the record or its directory is missing.
   */
  export async function archiveSkill(root: string, key: string, now: Date = new Date()): Promise<boolean> {
    const data = await load(root)
    const rec = data[key]
    if (!rec) return false
    if (!(await pathExists(rec.location))) return false

    const destRoot = archiveRoot(root, rec.projectId)
    await fs.mkdir(destRoot, { recursive: true })
    let dest = path.join(destRoot, rec.name)
    if (await pathExists(dest)) {
      dest = path.join(destRoot, `${rec.name}-${now.toISOString().replace(/[:.]/g, "-")}`)
    }

    await fs.rename(rec.location, dest)
    rec.state = "archived"
    rec.archived_at = now.toISOString()
    data[key] = rec
    await save(root, data)
    return true
  }

  /** Create a baseline record for an in-scope skill if none exists. No-op otherwise. */
  export async function seedIfMissing(root: string, location: string): Promise<void> {
    const scope = resolveScope(root, location)
    if (!scope) return
    const data = await load(root)
    if (data[scope.key]) return
    data[scope.key] = emptyRecord(scope)
    await save(root, data)
  }

  /** Set a record's lifecycle state. No-op if the record is missing. */
  export async function setState(
    root: string,
    key: string,
    state: UsageRecord["state"],
    now: Date = new Date(),
  ): Promise<void> {
    const data = await load(root)
    const rec = data[key]
    if (!rec) return
    rec.state = state
    if (state === "archived") rec.archived_at = now.toISOString()
    if (state === "active") rec.archived_at = null
    data[key] = rec
    await save(root, data)
  }

  /**
   * Persist a scan pass's bookkeeping on a record: the idle_scans counter and the
   * use_count baseline for next scan's comparison. No-op if the record is missing.
   */
  export async function recordScanResult(
    root: string,
    key: string,
    fields: { idle_scans: number; use_count_at_last_scan: number },
  ): Promise<void> {
    const data = await load(root)
    const rec = data[key]
    if (!rec) return
    rec.idle_scans = fields.idle_scans
    rec.use_count_at_last_scan = fields.use_count_at_last_scan
    data[key] = rec
    await save(root, data)
  }

  /** Drop a record entirely (e.g. orphan whose skill was deleted out-of-band). */
  export async function forget(root: string, key: string): Promise<void> {
    const data = await load(root)
    if (data[key]) {
      delete data[key]
      await save(root, data)
    }
  }

  /**
   * Restore an archived skill: move it from `<root>/<projectId>/archive/<name>/`
   * back to its original `location` and mark the record `active`. Returns false
   * if no archived copy exists or the original location is now occupied.
   */
  export async function restoreSkill(root: string, key: string, _now: Date = new Date()): Promise<boolean> {
    const data = await load(root)
    const rec = data[key]
    if (!rec) return false

    const archived = path.join(archiveRoot(root, rec.projectId), rec.name)
    if (!(await pathExists(archived))) return false
    if (await pathExists(rec.location)) return false // don't overwrite a live skill

    await fs.mkdir(path.dirname(rec.location), { recursive: true })
    await fs.rename(archived, rec.location)
    rec.state = "active"
    rec.archived_at = null
    data[key] = rec
    await save(root, data)
    return true
  }

  export async function bumpUse(
    root: string,
    location: string,
    sessionId?: string,
    now: Date = new Date(),
  ): Promise<void> {
    const scope = resolveScope(root, location)
    if (!scope) return
    try {
      const data = await load(root)
      const rec = data[scope.key] ?? emptyRecord(scope)
      rec.use_count += 1
      rec.last_used_at = now.toISOString()
      if (sessionId) {
        // Append this use's coordinate; trim the oldest over the recent window.
        rec.recent_uses.push({ session_id: sessionId, at: now.toISOString() })
        if (rec.recent_uses.length > MAX_RECENT_USES)
          rec.recent_uses.splice(0, rec.recent_uses.length - MAX_RECENT_USES)
      }
      data[scope.key] = rec
      await save(root, data)
    } catch {
      // Best-effort: a broken ledger must never break skill loading.
    }
  }
}
