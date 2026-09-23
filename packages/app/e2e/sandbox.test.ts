import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { claim, create, sweep } from "./sandbox"

const exists = (dir: string) =>
  fs
    .stat(dir)
    .then(() => true)
    .catch(() => false)

test("sweep keeps live-pid sandbox and removes dead-pid sandbox", async () => {
  const live = await create("test-live", process.pid)
  const deadProc = Bun.spawn(["bun", "-e", "process.exit(0)"])
  await deadProc.exited
  const dead = await create("test-dead", deadProc.pid)
  await sweep()
  expect(await exists(live)).toBe(true)
  expect(await exists(dead)).toBe(false)
  await fs.rm(live, { recursive: true, force: true })
}, 30_000)

test("sweep removes stale sandbox even with live pid", async () => {
  const stale = await create("test-stale", process.pid)
  const old = new Date(Date.now() - 25 * 3600_000)
  await fs.utimes(stale, old, old)
  await sweep()
  expect(await exists(stale)).toBe(false)
}, 30_000)

test("sandbox without pid file follows the 24h rule", async () => {
  const fresh = await create("test-plain")
  await sweep()
  expect(await exists(fresh)).toBe(true)
  const old = new Date(Date.now() - 25 * 3600_000)
  await fs.utimes(fresh, old, old)
  await sweep()
  expect(await exists(fresh)).toBe(false)
}, 30_000)

test("claim rewrites pid and sweep honors it", async () => {
  const dir = await create("test-claim", 999_999_999)
  const liveProc = Bun.spawn(["bun", "-e", "setTimeout(() => process.exit(0), 5000)"])
  await claim(dir, liveProc.pid)
  await sweep()
  expect(await exists(dir)).toBe(true)
  liveProc.kill()
  await liveProc.exited
  await sweep()
  expect(await exists(dir)).toBe(false)
}, 30_000)
