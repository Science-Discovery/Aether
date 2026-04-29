import fs from "fs/promises"
import path from "path"

const VERSIONS_DIR = ".versions"
const DEFAULT_MAX_VERSIONS = 1000
const VERSION_REGEX = /^v(\d+)_([a-zA-Z0-9_-]+)_(\d{8}T\d{6})\.bundle\.json$/

async function resolveMaxVersions(): Promise<number> {
  try {
    const { Config } = await import("../config/config")
    const cfg = await Config.get()
    const configured = cfg.skills?.max_versions
    if (typeof configured === "number" && configured >= 1) return configured
  } catch {}
  return DEFAULT_MAX_VERSIONS
}

export interface VersionEntry {
  version: number
  label: string   // "v001"
  action: string  // "create", "edit", "patch", "write_file", "remove_file", "rollback-v002"
  timestamp: string // "20260428T100000"
  filename: string
}

interface BundleFile {
  content: string
  encoding: "utf8" | "base64"
}

interface Bundle {
  action: string
  timestamp: string
  files: Record<string, BundleFile>
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

// Recursively collect all file paths relative to base, excluding .versions/
async function scanFiles(dir: string, base: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === VERSIONS_DIR) continue
      result.push(...(await scanFiles(path.join(dir, entry.name), base)))
    } else if (entry.isFile()) {
      result.push(path.relative(base, path.join(dir, entry.name)))
    }
  }
  return result
}

// Read a file and return BundleFile; null bytes → base64, otherwise utf8
async function readAsBundleFile(filePath: string): Promise<BundleFile> {
  const buf = await fs.readFile(filePath)
  for (let i = 0; i < Math.min(buf.length, 8000); i++) {
    if (buf[i] === 0) return { content: buf.toString("base64"), encoding: "base64" }
  }
  return { content: buf.toString("utf8"), encoding: "utf8" }
}

async function atomicWrite(filePath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${Date.now()}`
  try {
    if (typeof content === "string") {
      await fs.writeFile(tmp, content, "utf8")
    } else {
      await fs.writeFile(tmp, content)
    }
    await fs.rename(tmp, filePath)
  } catch (e) {
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
}

export async function snapshot(skillDir: string, action: string): Promise<void> {
  const filePaths = await scanFiles(skillDir, skillDir)
  if (filePaths.length === 0) throw new Error(`snapshot: no files found in ${skillDir}`)

  const files: Record<string, BundleFile> = {}
  for (const relPath of filePaths) {
    files[relPath] = await readAsBundleFile(path.join(skillDir, relPath))
  }

  const timestamp = nowTimestamp()
  const bundle: Bundle = { action, timestamp, files }

  const dir = versionsDir(skillDir)
  await fs.mkdir(dir, { recursive: true })

  const n = await nextVersion(skillDir)
  const filename = `v${pad(n)}_${action}_${timestamp}.bundle.json`
  const tmp = path.join(dir, `${filename}.tmp`)
  try {
    await fs.writeFile(tmp, JSON.stringify(bundle, null, 2), "utf8")
    await fs.rename(tmp, path.join(dir, filename))
  } catch {
    await fs.unlink(tmp).catch(() => {})
    throw new Error(`Failed to write snapshot ${filename}`)
  }

  await prune(skillDir)
}

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

  const bundleContent = await fs.readFile(path.join(versionsDir(skillDir), entry.filename), "utf8")
  const bundle: Bundle = JSON.parse(bundleContent)

  const currentFilePaths = await scanFiles(skillDir, skillDir)
  const currentSet = new Set(currentFilePaths)
  const bundleSet = new Set(Object.keys(bundle.files))

  // ① bundle has, current doesn't → create  ③ both have → overwrite
  for (const relPath of bundleSet) {
    const bundleFile = bundle.files[relPath]!
    const content =
      bundleFile.encoding === "base64" ? Buffer.from(bundleFile.content, "base64") : bundleFile.content
    await atomicWrite(path.join(skillDir, relPath), content)
  }

  // ② current has, bundle doesn't → delete
  const toDelete = [...currentSet].filter((p) => !bundleSet.has(p))
  for (const relPath of toDelete) {
    await fs.unlink(path.join(skillDir, relPath)).catch(() => {})
  }

  // Clean up empty directories left by deletions (deepest first)
  const dirCandidates = new Set<string>()
  for (const relPath of toDelete) {
    let d = path.dirname(relPath)
    while (d !== ".") {
      dirCandidates.add(d)
      d = path.dirname(d)
    }
  }
  const sortedDirs = [...dirCandidates].sort((a, b) => b.split("/").length - a.split("/").length)
  for (const relDir of sortedDirs) {
    const absDir = path.join(skillDir, relDir)
    const remaining = await fs.readdir(absDir).catch(() => null)
    if (remaining !== null && remaining.length === 0) await fs.rmdir(absDir).catch(() => {})
  }

  await snapshot(skillDir, `rollback-${entry.label}`)
  return { restoredFrom: entry.filename }
}

async function prune(skillDir: string): Promise<void> {
  const versions = await listVersions(skillDir)
  const max = await resolveMaxVersions()
  if (versions.length <= max) return
  const dir = versionsDir(skillDir)
  const toDelete = versions.slice(0, versions.length - max)
  await Promise.all(toDelete.map((v) => fs.unlink(path.join(dir, v.filename)).catch(() => {})))
}

export function formatHistory(skillName: string, versions: VersionEntry[]): string {
  if (versions.length === 0) return `Skill "${skillName}" has no version history yet.`
  const lines: string[] = [`Version history for skill "${skillName}" (${versions.length} total):\n`]
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i]!
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
