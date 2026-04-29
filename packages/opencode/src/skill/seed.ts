import fs from "fs/promises"
import { createHash } from "crypto"
import path from "path"
import { Global } from "@/global"

declare const OPENCODE_VERSION: string | undefined
declare const OPENCODE_CHANNEL: string | undefined

function getVersion(): string {
  return typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
}

function isLocal(): boolean {
  const channel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
  return channel === "local"
}

const log = {
  info: (msg: string, ctx?: object) => console.log(`[skill.seed] ${msg}`, ctx ?? ""),
  warn: (msg: string, ctx?: object) => console.warn(`[skill.seed] WARN ${msg}`, ctx ?? ""),
  error: (msg: string, ctx?: object) => console.error(`[skill.seed] ERROR ${msg}`, ctx ?? ""),
}

const MANIFEST_FILE = ".defaults.json"
const SKILL_FILE = "SKILL.md"

interface Manifest {
  seeded_version: string
  skills: Record<string, string> // skillName → sha256 of SKILL.md at seed time
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

async function readManifest(destDir: string): Promise<Manifest> {
  const p = path.join(destDir, MANIFEST_FILE)
  try {
    const raw = await fs.readFile(p, "utf8")
    const parsed = JSON.parse(raw)
    if (typeof parsed?.seeded_version === "string" && parsed?.skills && typeof parsed.skills === "object") {
      return parsed as Manifest
    }
  } catch {
    // missing or corrupted — treat as empty
  }
  return { seeded_version: "", skills: {} }
}

async function writeManifest(destDir: string, manifest: Manifest): Promise<void> {
  const p = path.join(destDir, MANIFEST_FILE)
  const tmp = `${p}.tmp.${Date.now()}`
  try {
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8")
    await fs.rename(tmp, p)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else if (entry.isFile()) {
      const tmp = `${destPath}.tmp.${Date.now()}`
      try {
        await fs.copyFile(srcPath, tmp)
        await fs.rename(tmp, destPath)
      } catch (err) {
        await fs.unlink(tmp).catch(() => {})
        throw err
      }
    }
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p)
    return stat.isDirectory()
  } catch {
    return false
  }
}

async function findSourceDir(): Promise<string | null> {
  // Production: look for .opencode/skills/ next to the executable
  const binaryDir = path.dirname(process.execPath)
  const prodPath = path.join(binaryDir, ".opencode", "skills")
  if (await dirExists(prodPath)) return prodPath

  // Dev mode: walk up from process.cwd() to find .opencode/skills/ in the repo root
  if (isLocal()) {
    let dir = process.cwd()
    while (true) {
      const candidate = path.join(dir, ".opencode", "skills")
      if (await dirExists(candidate)) return candidate
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  return null
}

export async function seedDefaultSkills(): Promise<void> {
  const destDir = path.join(Global.Path.data, "skills")

  const sourceDir = await findSourceDir()
  if (!sourceDir) {
    log.info("no default skills source found, skipping seed")
    return
  }

  const manifest = await readManifest(destDir)
  const currentVersion = getVersion()

  // In production skip entirely when the version hasn't changed
  if (!isLocal() && manifest.seeded_version === currentVersion) {
    return
  }

  await fs.mkdir(destDir, { recursive: true })

  let skillNames: string[]
  try {
    const entries = await fs.readdir(sourceDir, { withFileTypes: true })
    skillNames = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (err) {
    log.error("failed to read default skills source dir", { sourceDir, err })
    return
  }

  for (const skillName of skillNames) {
    try {
      const sourceSkillDir = path.join(sourceDir, skillName)
      const destSkillDir = path.join(destDir, skillName)
      const sourceSkillFile = path.join(sourceSkillDir, SKILL_FILE)
      const destSkillFile = path.join(destSkillDir, SKILL_FILE)

      // Read source SKILL.md — skip skills that don't have one
      let sourceContent: string
      try {
        sourceContent = await fs.readFile(sourceSkillFile, "utf8")
      } catch {
        log.warn("default skill missing SKILL.md, skipping", { skill: skillName })
        continue
      }
      const sourceHash = hashContent(sourceContent)

      // Check whether dest SKILL.md exists
      let destContent: string | null = null
      try {
        destContent = await fs.readFile(destSkillFile, "utf8")
      } catch {
        // file doesn't exist yet
      }

      if (destContent === null) {
        // Dest doesn't exist → copy everything, record hash
        await copyDir(sourceSkillDir, destSkillDir)
        manifest.skills[skillName] = sourceHash
        log.info("seeded skill", { skill: skillName })
        continue
      }

      const manifestHash = manifest.skills[skillName]
      if (manifestHash === undefined) {
        // Dest exists but not from us (user placed it manually) → don't touch
        continue
      }

      const destHash = hashContent(destContent)

      if (destHash !== manifestHash) {
        // User or AI has evolved this skill → preserve it
        continue
      }

      if (sourceHash === manifestHash) {
        // Nothing changed anywhere → skip
        continue
      }

      // User hasn't touched it, software has new content → overwrite
      await copyDir(sourceSkillDir, destSkillDir)
      manifest.skills[skillName] = sourceHash
      log.info("updated default skill", {
        skill: skillName,
        from: manifestHash.slice(0, 8),
        to: sourceHash.slice(0, 8),
      })
    } catch (err) {
      log.error("failed to seed skill", { skill: skillName, err })
    }
  }

  manifest.seeded_version = currentVersion
  try {
    await writeManifest(destDir, manifest)
  } catch (err) {
    log.error("failed to write seed manifest", { err })
  }
}
