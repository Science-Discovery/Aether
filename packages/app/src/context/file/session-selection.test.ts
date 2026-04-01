import { describe, expect, test } from "bun:test"
import { createSessionSelectionMap } from "./session-selection"

describe("session-scoped selection", () => {
  test("isolates selections by session ID", () => {
    const map = createSessionSelectionMap()
    map.set("session-a", new Set(["file1.ts", "file2.ts"]))
    map.set("session-b", new Set(["file3.ts"]))

    expect(map.get("session-a")).toEqual(new Set(["file1.ts", "file2.ts"]))
    expect(map.get("session-b")).toEqual(new Set(["file3.ts"]))
  })

  test("updating one session does not affect another", () => {
    const map = createSessionSelectionMap()
    map.set("session-a", new Set(["file1.ts"]))
    map.set("session-b", new Set(["file2.ts"]))

    // Update session-a
    map.set("session-a", new Set(["file1.ts", "file3.ts"]))

    expect(map.get("session-a")).toEqual(new Set(["file1.ts", "file3.ts"]))
    expect(map.get("session-b")).toEqual(new Set(["file2.ts"]))
  })

  test("returns empty set for unknown session", () => {
    const map = createSessionSelectionMap()
    map.set("session-a", new Set(["file1.ts"]))

    expect(map.get("unknown-session")).toEqual(new Set())
  })

  test("clears a specific session without affecting others", () => {
    const map = createSessionSelectionMap()
    map.set("session-a", new Set(["file1.ts"]))
    map.set("session-b", new Set(["file2.ts"]))

    // Clearing session-a should not affect session-b
    map.set("session-a", new Set())

    // When set to empty, it should be cleaned up
    expect(map.get("session-a")).toEqual(new Set())
    expect(map.get("session-b")).toEqual(new Set(["file2.ts"]))
  })
})
