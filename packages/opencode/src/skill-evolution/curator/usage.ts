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
  /**
   * Stable unique skill identity, stamped into SKILL.md at creation (`skl_<ulid>`).
   * The ledger keys records by id (`<projectId>/<id>`) so a skill archived/deleted
   * and later RE-CREATED under the same name does NOT collide with the old record.
   * `null` for legacy skills that predate the id field → those fall back to keying
   * by name (`<projectId>/<name>`). See SKILL_IDENTITY_DESIGN.md.
   */
  id: string | null
  name: string
  /** Absolute path to the skill directory (lets archive/restore locate it). */
  location: string
  use_count: number
  /**
   * Sum of all SAME-PROJECT skills' use_count at the instant THIS record was
   * first created — the skill's "birth water-mark". The curator judges a skill
   * by its share over the window SINCE birth, within its own project:
   *   exposure = projectUseCount(now, projectId) − born_at_project_total
   * Per-project + post-birth so neither a dormant project nor other projects'
   * calls can dilute its share. Legacy records predate this field → backfilled
   * to 0 (treated as "present from the start"). See RELATIVE_USAGE_DESIGN.md D2.
   */
  born_at_project_total: number
  last_used_at: string | null
  /**
   * Recent-window cache of the last MAX_RECENT_USES use coordinates, oldest
   * first. NOT the source of truth — the session DB holds the authoritative full
   * history; this is a convenience index so the curator carries a ready recent
   * window. Each bumpUse with a sessionId appends one; over the cap the oldest
   * are dropped from the front. See SESSION_USAGE_DESIGN.md D17/D19.
   */
  recent_uses: UseEvent[]
  /**
   * Lifecycle state. `deleted` is a tombstone: the skill directory is gone with no
   * archived copy (a true orphan), but the record is RETAINED so its historical
   * use_count stays in projectUseCount — the per-project denominator must stay
   * monotonic or siblings' post-birth exposure would shrink/go negative. See
   * RELATIVE_USAGE_DESIGN.md D6. Tombstones are never scanned or re-judged.
   */
  state: "active" | "stale" | "archived" | "deleted"
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

  /**
   * Sum of `use_count` over every ledger record in ONE project (same projectId),
   * including archived ones (their calls really happened, so they keep the total
   * monotonic — see RELATIVE_USAGE_DESIGN.md D6). Pure: operates on already-loaded
   * ledger data, no file I/O. This is the denominator for a skill's archive share,
   * and the value stamped into `born_at_project_total` at record creation.
   */
  export function projectUseCount(data: Record<string, UsageRecord>, projectId: string): number {
    let sum = 0
    for (const rec of Object.values(data)) {
      if (rec.projectId === projectId) sum += rec.use_count
    }
    return sum
  }

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
    id?: string,
  ): { key: string; projectId: string; name: string; skillDir: string; id: string | null } | null {
    const skillDir = location.endsWith("SKILL.md") ? path.dirname(location) : location
    const rel = path.relative(root, skillDir)
    const parts = rel.split(path.sep)
    if (parts.length !== 3) return null
    const [projectId, mid, name] = parts
    if (!projectId || mid !== "skills" || !name || projectId.startsWith("..")) return null
    // Key by id when the skill has one; fall back to name for legacy/id-less skills.
    const key = id ? `${projectId}/${id}` : `${projectId}/${name}`
    return { key, projectId, name, skillDir, id: id ?? null }
  }

  function emptyRecord(scope: { projectId: string; name: string; skillDir: string; id?: string | null }): UsageRecord {
    return {
      projectId: scope.projectId,
      id: scope.id ?? null,
      name: scope.name,
      location: scope.skillDir,
      use_count: 0,
      born_at_project_total: 0,
      last_used_at: null,
      recent_uses: [],
      state: "active",
      pinned: false,
      archived_at: null,
    }
  }

  /**
   * Build a fresh record for a never-before-seen skill, stamping its birth
   * water-mark = the same-project total at this instant (computed from `data`
   * BEFORE the new record is inserted — its own use_count is 0 anyway). This is
   * the SINGLE place birth is stamped; seedIfMissing and bumpUse both use it so
   * the two creation paths can never assign different born values. See D2/D5.
   */
  function createRecord(
    data: Record<string, UsageRecord>,
    scope: { projectId: string; name: string; skillDir: string; id?: string | null },
  ): UsageRecord {
    const rec = emptyRecord(scope)
    rec.born_at_project_total = projectUseCount(data, scope.projectId)
    return rec
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
          // Legacy records predate born_at_project_total; backfill to 0
          // (= "present from the start", see RELATIVE_USAGE_DESIGN.md D4).
          if (typeof rec.born_at_project_total !== "number") rec.born_at_project_total = 0
          // Legacy records predate `id`; backfill to null (= key by name, not id).
          if (typeof rec.id !== "string") rec.id = null
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
   * Move a skill's directory to `<root>/<projectId>/archive/<name>/` (DISK ONLY —
   * does not touch the ledger or save). Returns false if the source directory is
   * missing. Name collisions get a timestamp suffix. Split out of archiveSkill so
   * a batch pass (curator) can move the dir here and update the in-memory record
   * itself, persisting the whole ledger once at the end. Best-effort caller-guarded.
   */
  async function moveToArchive(root: string, rec: UsageRecord, now: Date = new Date()): Promise<boolean> {
    if (!(await pathExists(rec.location))) return false
    const destRoot = archiveRoot(root, rec.projectId)
    await fs.mkdir(destRoot, { recursive: true })
    let dest = path.join(destRoot, rec.name)
    if (await pathExists(dest)) {
      dest = path.join(destRoot, `${rec.name}-${now.toISOString().replace(/[:.]/g, "-")}`)
    }
    await fs.rename(rec.location, dest)
    return true
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
    if (!(await moveToArchive(root, rec, now))) return false
    rec.state = "archived"
    rec.archived_at = now.toISOString()
    data[key] = rec
    await save(root, data)
    return true
  }

  /** Create a baseline record for an in-scope skill if none exists. No-op otherwise. */
  export async function seedIfMissing(root: string, location: string, id?: string): Promise<void> {
    const scope = resolveScope(root, location, id)
    if (!scope) return
    const data = await load(root)
    if (data[scope.key]) return
    data[scope.key] = createRecord(data, scope)
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
    id?: string,
  ): Promise<void> {
    const scope = resolveScope(root, location, id)
    if (!scope) return
    try {
      const data = await load(root)
      let rec = data[scope.key]
      if (!rec) {
        // First sight of this skill → create it (born water-mark stamped inside).
        rec = createRecord(data, scope)
      } else if (rec.state === "deleted") {
        // A live skill is being loaded at a key whose record is a `deleted` tombstone (a
        // true orphan — by definition no archive copy exists) — a new skill has reclaimed
        // this slot. Revive it into the active lifecycle so the curator judges it again
        // instead of skipping it forever. Keep use_count (the project denominator must stay
        // monotonic — siblings' born water-marks already counted it), but re-stamp born for
        // a fresh trial window and drop the previous life's recent-use cache.
        //
        // Only `deleted` is revived, NOT `archived`: an archived skill's directory was MOVED
        // to archive/, so reviving in place would orphan that copy (and a later out-of-band
        // delete could resurrect its stale content). An archived slot is left as-is; recovery
        // goes through restoreSkill, which moves the copy back. See RELATIVE_USAGE_DESIGN.md.
        rec.born_at_project_total = projectUseCount(data, scope.projectId)
        rec.state = "active"
        rec.archived_at = null
        rec.recent_uses = []
      }
      // An existing active/stale record keeps its born untouched.
      // Refresh location to the current path: with id-keying a record survives a directory
      // rename, but a stale location would make the curator's orphan check think the skill
      // is gone and flap it deleted↔revived every pass. See SKILL_IDENTITY_DESIGN.md bug③.
      rec.location = scope.skillDir
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
