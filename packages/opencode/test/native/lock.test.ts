import { expect, test } from "bun:test"
import { NativeLock } from "../../src/native/lock"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("cancels a waiting prompt without stealing the history lock or delaying cancellation", async () => {
  await using dir = await tmpdir()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const release = Promise.withResolvers<void>()
        const owner = NativeLock.run("session", () => release.promise)
        const controller = new AbortController()
        const calls: string[] = []
        const pending = NativeLock.run(
          "session",
          async () => {
            calls.push("cancelled")
          },
          controller.signal,
        )
        controller.abort(new Error("Cancelled"))
        try {
          await expect(pending).rejects.toThrow("Cancelled")
          expect(NativeLock.busy("session")).toBe(true)
          const next = NativeLock.run("session", async () => {
            calls.push("next")
          })
          expect(calls).toEqual([])
          release.resolve()
          await Promise.all([owner, next])
          expect(calls).toEqual(["next"])
          expect(NativeLock.busy("session")).toBe(false)
        } finally {
          release.resolve()
          await owner
        }
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
  }
})
