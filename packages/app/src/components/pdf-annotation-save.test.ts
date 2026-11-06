import { describe, expect, test } from "bun:test"
import { queue } from "./pdf-annotation-save"

describe("PDF annotation saves", () => {
  test("keeps the latest draft and blocks export after a failed save, then permits retry", async () => {
    const state = queue<string>()
    state.load("saved")
    await state.save("中文备注\n第二行", async () => {
      throw new Error("offline")
    })
    expect(state.data).toBe("中文备注\n第二行")
    expect(state.load("stale server data")).toBe("中文备注\n第二行")
    await expect(state.flush()).rejects.toThrow("offline")
    await state.save(state.data!, async (value) => value)
    expect(await state.flush()).toBe("中文备注\n第二行")
    expect(state.error).toBeUndefined()
  })

  test("serializes writes without overwriting newer edits with earlier responses", async () => {
    const state = queue<string>()
    const first = Promise.withResolvers<string>()
    const second = Promise.withResolvers<string>()
    const started = Promise.withResolvers<void>()
    const calls: string[] = []
    const one = state.save("first", (value) => {
      calls.push(value)
      started.resolve()
      return first.promise
    })
    const two = state.save("second", (value) => {
      calls.push(value)
      return second.promise
    })
    await started.promise
    expect(calls).toEqual(["first"])
    expect(state.data).toBe("second")
    first.resolve("first response")
    await one
    expect(state.data).toBe("second")
    second.resolve("second response")
    await two
    expect(calls).toEqual(["first", "second"])
    expect(await state.flush()).toBe("second response")
  })

  test("export waits for saves added while an earlier save is pending", async () => {
    const state = queue<string>()
    const first = Promise.withResolvers<string>()
    const second = Promise.withResolvers<string>()
    void state.save("first", () => first.promise)
    const exported: string[] = []
    const done = state.flush().then((value) => exported.push(value!))
    const one = state.save("second", () => second.promise)
    first.resolve("first")
    await Promise.resolve()
    expect(exported).toEqual([])
    second.resolve("second")
    await one
    await done
    expect(exported).toEqual(["second"])
  })

  test("recovers from synchronous write failures and a newer save supersedes an older failure", async () => {
    const state = queue<string>()
    await state.save("first", () => {
      throw new Error("network setup failed")
    })
    await expect(state.flush()).rejects.toThrow("network setup failed")
    const first = Promise.withResolvers<string>()
    void state.save("second", () => first.promise)
    const next = state.save("third", async (value) => value)
    first.reject(new Error("second failed"))
    await next
    expect(await state.flush()).toBe("third")
  })

  test("separate documents retain independent drafts and errors", async () => {
    const first = queue<string>()
    const second = queue<string>()
    const pending = Promise.withResolvers<string>()
    const done = first.save("first document", () => pending.promise)
    await second.save("second document", async (value) => value)
    pending.reject(new Error("first offline"))
    await done
    expect(await second.flush()).toBe("second document")
    await expect(first.flush()).rejects.toThrow("first offline")
    expect(first.data).toBe("first document")
  })
})
