import { cpSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { APP, LEGACY_APP, legacyStoreName, storeName } from "./persist-names"
import { legacyUserDataDir, userDataDir, aetherDataDir } from "./paths"

let ready = false

function copy(src: string, dst: string) {
  if (!existsSync(src)) return false
  if (existsSync(dst)) return false
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  return true
}

function copyDir(src: string, dst: string) {
  if (!existsSync(src)) return false
  if (existsSync(dst)) return false
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true })
  return true
}

function storeSources(name: string) {
  const cur = userDataDir()
  const old = legacyUserDataDir()
  const aether = aetherDataDir()
  const next = storeName(name)
  const prev = legacyStoreName(name)
  const sources = [
    join(cur, next),
    ...(prev ? [join(cur, prev)] : []),
    join(old, next),
    ...(prev ? [join(old, prev)] : []),
  ]
  // 如果全局 store 目标目录不同于 old userDataDir，从旧 userDataDir 复制
  if (aether !== cur && next === "aether.global.dat") {
    sources.push(join(cur, next))
    if (prev) sources.push(join(cur, prev))
  }
  return sources
}

export function ensureStoreFile(name: string) {
  const next = storeName(name)
  const cwd = next === "aether.global.dat" ? aetherDataDir() : userDataDir()
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

function ensureState() {
  const next = join(userDataDir(), APP)
  if (existsSync(next)) return
  for (const src of [
    join(userDataDir(), LEGACY_APP),
    join(legacyUserDataDir(), APP),
    join(legacyUserDataDir(), LEGACY_APP),
  ]) {
    if (copyDir(src, next)) return
  }
}

function ensureDefault() {
  copy(join(legacyUserDataDir(), "default.dat"), join(userDataDir(), "default.dat"))
}

export function ensureDesktopPersist() {
  if (ready) return
  mkdirSync(userDataDir(), { recursive: true })
  ensureDefault()
  ensureState()
  ready = true
}

export function pidFiles() {
  return [join(userDataDir(), "sidecar.pid"), join(legacyUserDataDir(), "sidecar.pid")]
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
