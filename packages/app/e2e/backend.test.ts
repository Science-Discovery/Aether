import { expect, test } from "bun:test"
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
