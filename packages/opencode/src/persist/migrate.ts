import fs from "fs/promises"
import path from "path"
import { setTimeout as sleep } from "node:timers/promises"
import { Filesystem } from "@/util/filesystem"
import { CFG, LEGACY_CFG, Persist, legacyPlatformDir, platformDir } from "./naming"

const MARK = "migration-v1.json"
const LOCK = ".migrate.lock"
const STALE = 1000 * 60 * 5

let user: Promise<void> | undefined
const project = new Map<string, Promise<void>>()

type Result = "copied" | "skipped"
type State = {
  copied: string[]
  skipped: string[]
}

async function stat(file: string) {
  return fs.stat(file).catch(() => undefined)
}

async function exists(file: string) {
  return !!(await stat(file))
}

async function atomic(src: string, dst: string) {
  if (!(await exists(src))) return "skipped" as const
  if (await exists(dst)) return "skipped" as const
  await fs.mkdir(path.dirname(dst), { recursive: true })
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`
  await fs.copyFile(src, tmp)
  await fs.rename(tmp, dst).catch(async (err) => {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  })
  return "copied" as const
}

async function atomicDir(src: string, dst: string) {
  if (!(await exists(src))) return "skipped" as const
  if (await exists(dst)) return "skipped" as const
  await fs.mkdir(path.dirname(dst), { recursive: true })
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`
  await fs.cp(src, tmp, { recursive: true })
  await fs.rename(tmp, dst).catch(async (err) => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw err
  })
  return "copied" as const
}

function push(state: State, file: string, result: Result) {
  const list = result === "copied" ? state.copied : state.skipped
  list.push(file)
}

async function copyFile(state: State, src: string, dst: string, label: string) {
  push(state, label, await atomic(src, dst))
}

async function copyDir(state: State, src: string, dst: string, label: string) {
  push(state, label, await atomicDir(src, dst))
}

async function copyDb(state: State) {
  const rows = await fs.readdir(Persist.legacy.data, { withFileTypes: true }).catch(() => [])
  const dbs = rows.filter((row) => row.isFile() && /\.db$/i.test(row.name)).map((row) => row.name)
  for (const name of dbs) {
    const src = path.join(Persist.legacy.data, name)
    const dst = path.join(Persist.current.data, name)
    await copyFile(state, src, dst, `data/${name}`)
    await copyFile(state, `${src}-wal`, `${dst}-wal`, `data/${name}-wal`)
    await copyFile(state, `${src}-shm`, `${dst}-shm`, `data/${name}-shm`)
  }
}

async function copyRoots(state: State) {
  await Promise.all([
    fs.mkdir(Persist.current.data, { recursive: true }),
    fs.mkdir(Persist.current.config, { recursive: true }),
    fs.mkdir(Persist.current.state, { recursive: true }),
  ])

  await copyDb(state)

  await Promise.all([
    copyFile(state, path.join(Persist.legacy.data, "auth.json"), path.join(Persist.current.data, "auth.json"), "data/auth.json"),
    copyFile(
      state,
      path.join(Persist.legacy.data, "mcp-auth.json"),
      path.join(Persist.current.data, "mcp-auth.json"),
      "data/mcp-auth.json",
    ),
    copyDir(
      state,
      path.join(Persist.legacy.data, "reading-mode"),
      path.join(Persist.current.data, "reading-mode"),
      "data/reading-mode",
    ),
    copyDir(state, path.join(Persist.legacy.data, "storage"), path.join(Persist.current.data, "storage"), "data/storage"),
    copyFile(
      state,
      path.join(Persist.legacy.config, "config.json"),
      path.join(Persist.current.config, "config.json"),
      "config/config.json",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.config, `${LEGACY_CFG}.json`),
      path.join(Persist.current.config, `${CFG}.json`),
      `config/${CFG}.json`,
    ),
    copyFile(
      state,
      path.join(Persist.legacy.config, `${LEGACY_CFG}.jsonc`),
      path.join(Persist.current.config, `${CFG}.jsonc`),
      `config/${CFG}.jsonc`,
    ),
    copyFile(
      state,
      path.join(Persist.legacy.config, "AGENTS.md"),
      path.join(Persist.current.config, "AGENTS.md"),
      "config/AGENTS.md",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.config, "tui.json"),
      path.join(Persist.current.config, "tui.json"),
      "config/tui.json",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.config, "tui.jsonc"),
      path.join(Persist.current.config, "tui.jsonc"),
      "config/tui.jsonc",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.state, "model.json"),
      path.join(Persist.current.state, "model.json"),
      "state/model.json",
    ),
    copyFile(state, path.join(Persist.legacy.state, "kv.json"), path.join(Persist.current.state, "kv.json"), "state/kv.json"),
    copyFile(
      state,
      path.join(Persist.legacy.state, "prompt-history.jsonl"),
      path.join(Persist.current.state, "prompt-history.jsonl"),
      "state/prompt-history.jsonl",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.state, "prompt-stash.jsonl"),
      path.join(Persist.current.state, "prompt-stash.jsonl"),
      "state/prompt-stash.jsonl",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.state, "frecency.jsonl"),
      path.join(Persist.current.state, "frecency.jsonl"),
      "state/frecency.jsonl",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.state, "legacy-db.json"),
      path.join(Persist.current.state, "legacy-db.json"),
      "state/legacy-db.json",
    ),
    copyFile(
      state,
      path.join(Persist.legacy.state, "legacy-db-merge.json"),
      path.join(Persist.current.state, "legacy-db-merge.json"),
      "state/legacy-db-merge.json",
    ),
  ])
}

async function copySpecial(state: State) {
  await Promise.all([
    copyFile(
      state,
      path.join(legacyPlatformDir("wechat"), "session.json"),
      path.join(platformDir("wechat"), "session.json"),
      "wechat/session.json",
    ),
    copyFile(
      state,
      path.join(legacyPlatformDir("wechat"), "accounts.json"),
      path.join(platformDir("wechat"), "accounts.json"),
      "wechat/accounts.json",
    ),
    copyFile(
      state,
      path.join(legacyPlatformDir("feishu"), "config.json"),
      path.join(platformDir("feishu"), "config.json"),
      "feishu/config.json",
    ),
    copyFile(
      state,
      path.join(legacyPlatformDir("feishu"), "sessions.json"),
      path.join(platformDir("feishu"), "sessions.json"),
      "feishu/sessions.json",
    ),
    copyFile(
      state,
      path.join(legacyPlatformDir("feishu"), "hidden_projects.json"),
      path.join(platformDir("feishu"), "hidden_projects.json"),
      "feishu/hidden_projects.json",
    ),
    copyDir(
      state,
      legacyPlatformDir("wechat-bridge"),
      platformDir("wechat-bridge"),
      "wechat-bridge",
    ),
  ])
}

async function writeMark(state: State) {
  await Filesystem.writeJson(path.join(Persist.current.state, MARK), {
    copied: state.copied,
    skipped: state.skipped,
    time: Date.now(),
  })
}

async function acquire(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  while (true) {
    try {
      const handle = await fs.open(file, "wx")
      await handle.writeFile(JSON.stringify({ pid: process.pid, time: Date.now() }))
      return handle
    } catch (err) {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") throw err
      const info = await stat(file)
      if (info && Date.now() - info.mtimeMs > STALE) {
        await fs.rm(file, { force: true }).catch(() => {})
        continue
      }
      await sleep(100)
    }
  }
}

async function withLock<T>(fn: () => Promise<T>) {
  const file = path.join(path.dirname(Persist.current.state), LOCK)
  const handle = await acquire(file)
  try {
    return await fn()
  } finally {
    await handle.close().catch(() => {})
    await fs.rm(file, { force: true }).catch(() => {})
  }
}

async function migrateUser() {
  return withLock(async () => {
    const state: State = { copied: [], skipped: [] }
    await copyRoots(state)
    await copySpecial(state)
    await writeMark(state)
  })
}

export async function ensureUser() {
  user ??= migrateUser()
  await user
}

async function migrateProject(dir: string) {
  const next = path.join(dir, ".aether", "skills")
  const prev = path.join(dir, ".opencode", "skills")
  if (await exists(next)) return
  if (!(await exists(prev))) return
  await atomicDir(prev, next)
}

export async function ensureProject(dir: string, stop: string) {
  const key = `${dir}:${stop}`
  const run = project.get(key)
  if (run) return run
  const task = (async () => {
    let cur = dir
    while (true) {
      await migrateProject(cur)
      if (cur === stop) break
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  })()
  project.set(key, task)
  await task.finally(() => {
    project.delete(key)
  })
}

export async function status() {
  return {
    current: Persist.current,
    legacy: Persist.legacy,
    marker: path.join(Persist.current.state, MARK),
    marker_exists: await exists(path.join(Persist.current.state, MARK)),
  }
}

export function reset() {
  user = undefined
  project.clear()
}
