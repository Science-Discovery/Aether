import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { startBackend } from "./backend"

test("concurrent e2e backends start on distinct conflict-free ports", async () => {
  const [first, second] = await Promise.all([startBackend("unit-a"), startBackend("unit-b")])
  try {
    expect(first.url).not.toBe(second.url)
    for (const url of [first.url, second.url]) {
      const res = await fetch(`${url}/global/health`)
      expect(res.ok).toBe(true)
    }
  } finally {
    await Promise.allSettled([first.stop(), second.stop()])
  }
}, 240_000)

test("backend health answers only its own run id", async () => {
  const backend = await startBackend("unit-run")
  try {
    const url = `${backend.url}/global/health`
    const own = await fetch(`${url}?run=${backend.run}`)
    expect(own.status).toBe(200)
    const foreign = await fetch(`${url}?run=${randomUUID()}`)
    expect(foreign.status).toBe(404)
    const bare = await fetch(url)
    expect(bare.status).toBe(200)
  } finally {
    await backend.stop()
  }
}, 240_000)
