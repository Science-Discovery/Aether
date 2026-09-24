import { expect, test } from "bun:test"
import { withRetry } from "./retry"

test("withRetry returns on first success without retrying", async () => {
  let calls = 0
  const out = await withRetry({
    label: "ok",
    attempts: 3,
    backoff: 1,
    run: async () => {
      calls++
      return "done"
    },
  })
  expect(out).toBe("done")
  expect(calls).toBe(1)
})

test("withRetry retries until success and runs next before each retry", async () => {
  let calls = 0
  let nexts = 0
  const out = await withRetry({
    label: "flaky",
    attempts: 3,
    backoff: 1,
    run: async () => {
      calls++
      if (calls < 3) throw new Error(`boom ${calls}`)
      return "recovered"
    },
    next: async () => {
      nexts++
    },
  })
  expect(out).toBe("recovered")
  expect(calls).toBe(3)
  expect(nexts).toBe(2)
})

test("withRetry throws after exhausting attempts", async () => {
  let calls = 0
  let nexts = 0
  await expect(
    withRetry({
      label: "dead",
      attempts: 3,
      backoff: 1,
      run: async () => {
        calls++
        throw new Error(`boom ${calls}`)
      },
      next: async () => {
        nexts++
      },
    }),
  ).rejects.toThrow("boom 3")
  expect(calls).toBe(3)
  expect(nexts).toBe(2)
})

test("withRetry waits n*backoff between attempts", async () => {
  const started = Date.now()
  await expect(
    withRetry({
      label: "timing",
      attempts: 4,
      backoff: 20,
      run: async () => {
        throw new Error("boom")
      },
    }),
  ).rejects.toThrow("boom")
  expect(Date.now() - started).toBeGreaterThanOrEqual(110)
})
