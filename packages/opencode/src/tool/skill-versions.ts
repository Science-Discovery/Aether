import fs from "fs/promises"
import path from "path"

const VERSIONS_DIR = ".versions"
const MAX_VERSIONS = 1000
const VERSION_REGEX = /^v(\d+)_([a-zA-Z0-9-]+)_(\d{8}T\d{6})\.md$/

export interface VersionEntry {
  version: number
  label: string   // "v001"
  action: string  // "create", "edit", "patch", "delete", "rollback-v002"
  timestamp: string // "20260428T100000"
  filename: string
}

function pad(n: number): string {
  if (n < 10) return `00${n}`
  if (n < 100) return `0${n}`
  return String(n)
}

function nowTimestamp(): string {
  const d = new Date()
  const Y = d.getFullYear()
  const M = String(d.getMonth() + 1).padStart(2, "0")
  const D = String(d.getDate()).padStart(2, "0")
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  return `${Y}${M}${D}T${h}${m}${s}`
}

function versionsDir(skillDir: string): string {
  return path.join(skillDir, VERSIONS_DIR)
}

export async function listVersions(skillDir: string): Promise<VersionEntry[]> {
  const dir = versionsDir(skillDir)
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  const versions: VersionEntry[] = []
  for (const name of entries) {
    const m = VERSION_REGEX.exec(name)
    if (!m) continue
    versions.push({
      version: parseInt(m[1], 10),
      label: `v${m[1]}`,
      action: m[2],
      timestamp: m[3],
      filename: name,
    })
  }
  versions.sort((a, b) => a.version - b.version)
  return versions
}

async function nextVersion(skillDir: string): Promise<number> {
  const versions = await listVersions(skillDir)
  if (versions.length === 0) return 1
  return versions[versions.length - 1].version + 1
}

export async function snapshot(skillDir: string, action: string): Promise<void> {
  const skillFile = path.join(skillDir, "SKILL.md")
  const content = await fs.readFile(skillFile, "utf8").catch(() => {
    throw new Error(`snapshot: SKILL.md not found at ${skillFile}`)
  })

  const dir = versionsDir(skillDir)
  await fs.mkdir(dir, { recursive: true })

  const n = await nextVersion(skillDir)
  const filename = `v${pad(n)}_${action}_${nowTimestamp()}.md`
  const tmp = path.join(dir, filename + ".tmp")
  try {
    await fs.writeFile(tmp, content, "utf8")
    await fs.rename(tmp, path.join(dir, filename))
  } catch {
    await fs.unlink(tmp).catch(() => {})
    throw new Error(`Failed to write snapshot ${filename}`)
  }

  await prune(skillDir)
}

// Snapshot before delete (SKILL.md will be gone after)
export async function snapshotBeforeDelete(skillDir: string): Promise<void> {
  return snapshot(skillDir, "delete")
}

export async function rollback(skillDir: string, targetLabel: string): Promise<{ restoredFrom: string }> {
  const versions = await listVersions(skillDir)
  const raw = targetLabel.startsWith("v") ? targetLabel.slice(1) : targetLabel
  const num = parseInt(raw, 10)
  if (isNaN(num)) throw new Error(`Invalid version label "${targetLabel}". Use 'v002' or '2'.`)
  const normalised = `v${pad(num)}`
  const entry = versions.find((v) => v.label === normalised)
  if (!entry) {
    const available = versions.map((v) => v.label).join(", ") || "(none)"
    throw new Error(`Version "${targetLabel}" not found. Available: ${available}`)
  }

  const src = path.join(versionsDir(skillDir), entry.filename)
  const content = await fs.readFile(src, "utf8")

  const skillFile = path.join(skillDir, "SKILL.md")
  const tmp = skillFile + ".tmp." + Date.now()
  try {
    await fs.writeFile(tmp, content, "utf8")
    await fs.rename(tmp, skillFile)
  } catch {
    await fs.unlink(tmp).catch(() => {})
    throw new Error(`Failed to restore SKILL.md from ${entry.filename}`)
  }

  // Snapshot the restored state with a label indicating which version was restored
  const rollbackAction = `rollback-${entry.label}`
  await snapshot(skillDir, rollbackAction)

  return { restoredFrom: entry.filename }
}

async function prune(skillDir: string): Promise<void> {
  const versions = await listVersions(skillDir)
  if (versions.length <= MAX_VERSIONS) return
  const dir = versionsDir(skillDir)
  const toDelete = versions.slice(0, versions.length - MAX_VERSIONS)
  await Promise.all(toDelete.map((v) => fs.unlink(path.join(dir, v.filename)).catch(() => {})))
}

export function formatHistory(skillName: string, versions: VersionEntry[]): string {
  if (versions.length === 0) return `Skill "${skillName}" has no version history yet.`

  const lines: string[] = [`Version history for skill "${skillName}" (${versions.length} total):\n`]
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i]
    const ts = v.timestamp
    const dateStr = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}`
    const current = i === versions.length - 1 ? "  ← current" : ""
    lines.push(`  ${v.label.padEnd(6)}  ${v.action.padEnd(20)}  ${dateStr}${current}`)
  }
  return lines.join("\n")
}

export function isVersionsDir(entryName: string): boolean {
  return entryName === VERSIONS_DIR
}
