import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionKeyReader, ensureSessionKey, parseSessionKey, pruneSessionKeys, sessionKeyForServer } from "./layout"

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })

  test("scopes session keys by server while keeping directory first", () => {
    const a = sessionKeyForServer("ZGly", "ses_1", "http://one.example")
    const b = sessionKeyForServer("ZGly", "ses_1", "http://two.example")

    expect(a).not.toBe(b)
    expect(a.split("/")[0]).toBe("ZGly")
    expect(a.split("/")[1]).toBe("ses_1")
  })

  test("scopes workspace keys without creating a session segment", () => {
    const key = sessionKeyForServer("ZGly", undefined, "http://one.example")

    expect(key.split("/")[0]).toBe("ZGly")
    expect(key.split("/")[1]).toBe("")
    expect(key).toContain("//server:")
  })

  test("parses scoped session keys into persisted storage scope", () => {
    const key = sessionKeyForServer("ZGly", "ses_1", "http://one.example")
    const parsed = parseSessionKey(key)

    expect(parsed.dir).toBe("ZGly")
    expect(parsed.session).toBe("ses_1")
    expect(parsed.storage).toBe("ZGly\nserver:" + key.split("//server:")[1])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})
