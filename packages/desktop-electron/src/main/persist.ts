import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { legacyStoreName, shared, storeName } from "./persist-names"
import { userDataDir, aetherDataDir } from "./paths"

let ready = false

function copy(src: string, dst: string) {
  if (!existsSync(src)) return false
  if (existsSync(dst)) return false
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  return true
}

function storeSources(name: string) {
  const cur = userDataDir()
  const aether = aetherDataDir()
  const next = storeName(name)
  const prev = legacyStoreName(name)
  const cwd = shared(next) ? aether : cur
  return [join(cwd, next), ...(prev ? [join(cwd, prev)] : [])]
}

export function ensureStoreFile(name: string) {
  const next = storeName(name)
  const cwd = shared(next) ? aetherDataDir() : userDataDir()
  const file = join(cwd, next)
  if (existsSync(file)) return next
  const seen = new Set<string>()
  for (const src of storeSources(name)) {
    if (seen.has(src)) continue
    seen.add(src)
    if (copy(src, file)) break
  }
  return next
}

export function ensureDesktopPersist() {
  if (ready) return
  mkdirSync(userDataDir(), { recursive: true })
  ready = true
}

export function pidFiles() {
  return [join(userDataDir(), "sidecar.pid")]
}

export function clearDb(file: string) {
  rmSync(file, { force: true })
  rmSync(`${file}-wal`, { force: true })
  rmSync(`${file}-shm`, { force: true })
}

export function copyDb(src: string, dst: string) {
  if (!existsSync(src)) return false
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  for (const ext of ["-wal", "-shm"]) {
    const from = `${src}${ext}`
    const to = `${dst}${ext}`
    if (!existsSync(from)) {
      rmSync(to, { force: true })
      continue
    }
    copyFileSync(from, to)
  }
  return true
}
