import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import type ParcelWatcher from "@parcel/watcher"
import { tmpdir } from "../fixture/fixture"
import { FileWatcher } from "../../src/file/watcher"
import { Process } from "../../src/util/process"

// Regression tests for the watcher sidecar supervisor: a sidecar that dies
// after becoming ready must be respawned (bounded backoff) instead of leaving
// the subscription silently dead. Win32-only, same as watcher-child.test.ts:
// the JS sidecar spawn path differs on linux/macos CI.

const testWin32 = process.platform === "win32" ? test : test.skip
const script = path.join(import.meta.dir, "..", "..", "src", "file", "watcher-child.ts")

type Input = Parameters<typeof FileWatcher.supervise>[0]

// RESPAWN_MAX in watcher.ts: initial generation + 5 respawns before give-up.
const RESPAWN_MAX = 5

function harness(dir: string) {
  const events: ParcelWatcher.Event[] = []
  const procs: Process.Child[] = []
  const subs = new Set<FileWatcher.Subscription>()
  const state = { ready: 0, degraded: 0, disposed: false }
  const cb: ParcelWatcher.SubscribeCallback = (err, evts) => {
    if (err) return
    events.push(...evts)
  }
  const input = (over: Partial<Input> = {}): Input => ({
    dir,
    kind: "worktree",
    ignore: [],
    filter: [],
    backend: "windows",
    cb,
    js: script,
    sidecar: true,
    native: false,
    subs,
    scope: { directory: dir, worktree: dir, projectID: "watcher-respawn-test" },
    disposed: () => state.disposed,
    degrade: () => {
      state.degraded++
    },
    onSpawn: (proc) => procs.push(proc),
    onReady: () => {
      state.ready++
    },
    delay: () => 25,
    ...over,
  })
  return { events, procs, subs, state, input }
}

async function until(check: () => boolean, what: string, ms = 15_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function settle(procs: Process.Child[]) {
  await Promise.all(procs.map((proc) => proc.exited.catch(() => undefined)))
}

describe("FileWatcher sidecar respawn", () => {
  testWin32(
    "respawns after a post-ready crash and keeps streaming events",
    async () => {
      await using tmp = await tmpdir()
      const h = harness(tmp.path)
      const outcome = await FileWatcher.supervise(h.input())
      expect(outcome.sub).toBeDefined()
      expect(h.procs.length).toBe(1)
      expect(h.state.ready).toBe(1)

      const first = path.join(tmp.path, "before.txt")
      await fs.writeFile(first, "one")
      await until(() => h.events.some((e) => e.path === first && e.type === "create"), "event before crash")

      h.procs[0].kill("SIGKILL")
      await until(() => h.state.ready >= 2, "respawned sidecar ready")
      expect(h.procs.length).toBe(2)
      expect(h.subs.size).toBe(1)
      expect(h.state.degraded).toBe(0)

      const second = path.join(tmp.path, "after.txt")
      await fs.writeFile(second, "two")
      await until(() => h.events.some((e) => e.path === second && e.type === "create"), "event after respawn")

      h.procs[h.procs.length - 1].kill("SIGKILL")
      h.state.disposed = true
      await settle(h.procs)
    },
    30_000,
  )

  testWin32(
    "gives up after repeated crashes and reports degrade",
    async () => {
      await using tmp = await tmpdir()
      const h = harness(tmp.path)
      const outcome = await FileWatcher.supervise(h.input({ delay: () => 10 }))
      expect(outcome.sub).toBeDefined()

      for (let i = 0; i < RESPAWN_MAX; i++) {
        h.procs[h.procs.length - 1].kill("SIGKILL")
        await until(() => h.state.ready === i + 2, `respawn ${i + 1}`)
      }
      expect(h.state.degraded).toBe(0)
      expect(h.procs.length).toBe(RESPAWN_MAX + 1)

      h.procs[h.procs.length - 1].kill("SIGKILL")
      await until(() => h.state.degraded === 1, "degrade report")
      expect(h.procs.length).toBe(RESPAWN_MAX + 1)
      await Bun.sleep(300)
      expect(h.procs.length).toBe(RESPAWN_MAX + 1)

      h.state.disposed = true
      await settle(h.procs)
    },
    30_000,
  )

  testWin32(
    "resets the attempt budget after a healthy generation",
    async () => {
      await using tmp = await tmpdir()
      const h = harness(tmp.path)
      const outcome = await FileWatcher.supervise(h.input({ delay: () => 10, resetMs: 1_000 }))
      expect(outcome.sub).toBeDefined()

      h.procs[0].kill("SIGKILL")
      await until(() => h.state.ready === 2, "respawn 1")
      await Bun.sleep(1_100)

      h.procs[1].kill("SIGKILL")
      await until(() => h.state.ready === 3, "respawn after reset")

      for (let i = 4; i <= RESPAWN_MAX + 2; i++) {
        h.procs[h.procs.length - 1].kill("SIGKILL")
        await until(() => h.state.ready === i, `respawn to generation ${i}`)
      }
      expect(h.state.degraded).toBe(0)
      expect(h.procs.length).toBe(RESPAWN_MAX + 2)

      h.procs[RESPAWN_MAX + 1].kill("SIGKILL")
      await until(() => h.state.degraded === 1, "degrade after reset budget")
      expect(h.procs.length).toBe(RESPAWN_MAX + 2)

      h.state.disposed = true
      await settle(h.procs)
    },
    45_000,
  )

  testWin32(
    "does not respawn once disposed",
    async () => {
      await using tmp = await tmpdir()
      const h = harness(tmp.path)
      await FileWatcher.supervise(h.input({ delay: () => 250 }))
      expect(h.state.ready).toBe(1)

      h.procs[0].kill("SIGKILL")
      h.state.disposed = true
      await Bun.sleep(700)
      expect(h.procs.length).toBe(1)
      expect(h.state.degraded).toBe(0)
      await settle(h.procs)
    },
    30_000,
  )
})
