import fs from "fs/promises"
import path from "path"
import { VERSION_CAPACITY, ACTIVE_REGION_RATIO } from "./constants"

const VERSIONS_DIR = ".versions"

interface BundleEntry {
  path: string
  content: string
}

interface Bundle {
  action: string
  timestamp: string
  version: number
  files: BundleEntry[]
}

export interface VersionEntry {
  filename: string
  version: number
  action: string
  timestamp: string
}

function versionsDir(skillDir: string): string {
  return path.join(skillDir, VERSIONS_DIR)
}

function formatVersionNumber(n: number): string {
  return `v${String(n).padStart(3, "0")}`
}

function bundleFilename(version: number, action: string, timestamp: string): string {
  return `${formatVersionNumber(version)}_${action}_${timestamp}.bundle.json`
}

function parseVersionNumber(filename: string): number | undefined {
  const m = filename.match(/^v(\d+)_/)
  return m ? parseInt(m[1]!) : undefined
}

/**
 * Binary Ruler pruning strategy.
 * Keeps:
 *  - v001 permanently
 *  - The most recent `activeCount` versions
 *  - The highest-weight versions in the remaining slots
 *
 * Weight = v & -v (lowest set bit of the version number).
 */
function applyBinaryRuler(entries: VersionEntry[], capacity: number): VersionEntry[] {
  if (entries.length <= capacity) return entries

  const sorted = [...entries].sort((a, b) => a.version - b.version)
  const first = sorted[0]!

  const activeCount = Math.floor((capacity - 1) * ACTIVE_REGION_RATIO)
  const milestoneSlots = capacity - 1 - activeCount

  const active = sorted.slice(sorted.length - activeCount)
  const activeVersions = new Set(active.map((e) => e.version))

  const candidates = sorted
    .slice(1, sorted.length - activeCount)
    .filter((e) => !activeVersions.has(e.version))
    .sort((a, b) => {
      // Higher weight (lower set bit position) = higher priority
      const wa = a.version & -a.version
      const wb = b.version & -b.version
      return wb - wa || b.version - a.version
    })

  const milestones = candidates.slice(0, milestoneSlots)

  return [first, ...milestones, ...active].sort((a, b) => a.version - b.version)
}

export namespace Versions {
  /**
   * Create a new version snapshot of all files in skillDir.
   * Returns the bundle filename.
   */
  export async function create(skillDir: string, action: string): Promise<string> {
    const vdir = versionsDir(skillDir)
    await fs.mkdir(vdir, { recursive: true })

    // Determine next version number
    const existing = await list(skillDir)
    const maxVersion = existing.reduce((m, e) => Math.max(m, e.version), 0)
    const nextVersion = maxVersion + 1

    // Collect all files (excluding .versions itself)
    const files: BundleEntry[] = []
    const entries = await fs.readdir(skillDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === VERSIONS_DIR) continue
      const filePath = path.join(skillDir, entry.name)
      if (!entry.isFile()) continue
      try {
        const content = await fs.readFile(filePath, "utf-8")
        files.push({ path: entry.name, content })
      } catch {
        // Skip unreadable / binary files
      }
    }

    const timestamp = new Date().toISOString()
    const bundle: Bundle = { action, timestamp, version: nextVersion, files }
    const filename = bundleFilename(nextVersion, action, timestamp)

    await fs.writeFile(path.join(vdir, filename), JSON.stringify(bundle, null, 2), "utf-8")

    // Prune if over capacity
    await prune(skillDir)

    return filename
  }

  /**
   * List all version entries sorted by version number ascending.
   */
  export async function list(skillDir: string): Promise<VersionEntry[]> {
    const vdir = versionsDir(skillDir)
    const filenames = await fs.readdir(vdir).catch(() => [] as string[])
    const entries: VersionEntry[] = []
    for (const filename of filenames) {
      if (!filename.endsWith(".bundle.json")) continue
      const version = parseVersionNumber(filename)
      if (version === undefined) continue
      // Parse action and timestamp from filename: vNNN_<action>_<timestamp>.bundle.json
      const withoutExt = filename.slice(0, -".bundle.json".length)
      const parts = withoutExt.split("_")
      const action = parts[1] ?? "unknown"
      const timestamp = parts.slice(2).join("_")
      entries.push({ filename, version, action, timestamp })
    }
    return entries.sort((a, b) => a.version - b.version)
  }

  /**
   * Restore skillDir to a specific version snapshot.
   */
  export async function rollback(skillDir: string, version: string): Promise<void> {
    const entries = await list(skillDir)
    const target = entries.find(
      (e) => e.filename.startsWith(version + "_") || formatVersionNumber(e.version) === version,
    )
    if (!target) throw new Error(`Version "${version}" not found`)

    const bundlePath = path.join(versionsDir(skillDir), target.filename)
    const raw = await fs.readFile(bundlePath, "utf-8")
    const bundle = JSON.parse(raw) as Bundle

    // Remove all non-.versions files in skillDir
    const existing = await fs.readdir(skillDir, { withFileTypes: true }).catch(() => [])
    for (const entry of existing) {
      if (entry.name === VERSIONS_DIR) continue
      await fs.rm(path.join(skillDir, entry.name), { recursive: true, force: true })
    }

    // Restore files from bundle
    for (const f of bundle.files) {
      await fs.writeFile(path.join(skillDir, f.path), f.content, "utf-8")
    }
  }

  /**
   * Prune snapshots to stay within VERSION_CAPACITY using Binary Ruler strategy.
   */
  export async function prune(skillDir: string): Promise<void> {
    const entries = await list(skillDir)
    if (entries.length <= VERSION_CAPACITY) return

    const keep = new Set(applyBinaryRuler(entries, VERSION_CAPACITY).map((e) => e.filename))
    const vdir = versionsDir(skillDir)
    for (const entry of entries) {
      if (!keep.has(entry.filename)) {
        await fs.rm(path.join(vdir, entry.filename), { force: true })
      }
    }
  }
}
