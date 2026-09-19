import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionKeyReader, ensureSessionKey, migrateSessionTabs, pruneSessionKeys } from "./layout"

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

describe("migrateSessionTabs", () => {
  test("adopts session buckets into an empty project bucket", () => {
    const value = {
      "dirA": { all: [], active: undefined },
      "dirA/ses1": { all: ["file://a"], active: "file://a" },
    }

    const out = migrateSessionTabs(value) as Record<string, { all: string[]; active?: string }>

    expect(out["dirA/ses1"]).toBeUndefined()
    expect(out["dirA"]?.all).toHaveLength(1)
    expect(out["dirA"]?.active).toBeDefined()
  })

  test("keeps a non-empty project bucket over session buckets", () => {
    const value = {
      "dirA": { all: ["file://x"], active: "file://x" },
      "dirA/ses1": { all: ["file://a"], active: "file://a" },
    }

    const out = migrateSessionTabs(value) as Record<string, { all: string[]; active?: string }>

    expect(out["dirA"]).toEqual({ all: ["file://x"], active: "file://x" })
    expect(out["dirA/ses1"]).toBeUndefined()
  })

  test("normalizes invalid entries and returns a new object", () => {
    const value = { dirA: { all: ["file://a", 42, null], active: 5 } }

    const out = migrateSessionTabs(value) as Record<string, { all: string[]; active?: string }>

    expect(out).not.toBe(value)
    expect(out["dirA"]?.all).toHaveLength(1)
    expect(out["dirA"]?.active).toBeUndefined()
  })

  test("passes non-record state through untouched", () => {
    expect(migrateSessionTabs(undefined)).toBeUndefined()
    expect(migrateSessionTabs("junk")).toBe("junk")
  })

  test("returns the same reference when nothing changes", () => {
    const value = { dirA: { all: [], active: undefined } }
    expect(migrateSessionTabs(value)).toBe(value)
  })
})
