import os from "os"
import path from "path"
import { xdgCache, xdgConfig, xdgData, xdgState } from "xdg-basedir"

export const APP = "aether"
export const LEGACY_APP = "opencode"
export const PROJECT = ".aether"
export const LEGACY_PROJECT = ".opencode"
export const KB = ".aether-kb"
export const LEGACY_KB = ".opencode-kb"
export const CFG = "aether"
export const LEGACY_CFG = "opencode"

function home() {
  return process.env.OPENCODE_TEST_HOME || os.homedir()
}

function roots(name: string) {
  const data = path.join(xdgData!, name)
  const cache = path.join(xdgCache!, name)
  const config = path.join(xdgConfig!, name)
  const state = path.join(xdgState!, name)
  return {
    data,
    cache,
    config,
    state,
    log: path.join(data, "log"),
    bin: path.join(cache, "bin"),
  }
}

export const Persist = {
  current: roots(APP),
  legacy: roots(LEGACY_APP),
}

export function configFiles(name: string) {
  return [`${name}.jsonc`, `${name}.json`]
}

export function projectDir(legacy = false) {
  return legacy ? LEGACY_PROJECT : PROJECT
}

export function kbDir(legacy = false) {
  return legacy ? LEGACY_KB : KB
}

export function scoped(root: string, file: string) {
  return path.join(root, file)
}

function platformRoot(name: string, sub: string) {
  if (process.platform === "darwin") return path.join(home(), "Library", "Application Support", name, sub)
  if (process.platform === "win32") return path.join(process.env.APPDATA || home(), name, sub)
  return path.join(home(), ".local", "share", name, sub)
}

export function platformDir(sub: string) {
  return platformRoot(APP, sub)
}

export function legacyPlatformDir(sub: string) {
  return platformRoot(LEGACY_APP, sub)
}

function managedRoot(name: string) {
  if (process.platform === "darwin") return path.join("/Library/Application Support", name)
  if (process.platform === "win32") return path.join(process.env.ProgramData || "C:\\ProgramData", name)
  return path.join("/etc", name)
}

export function managedDir() {
  return managedRoot(APP)
}

export function legacyManagedDir() {
  return managedRoot(LEGACY_APP)
}

