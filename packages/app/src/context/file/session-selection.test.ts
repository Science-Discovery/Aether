import { describe, expect, test } from "bun:test"
import { createSessionSelection } from "./session-selection"

describe("session selection", () => {
  test("isolates selections by session ID", () => {
    const selection = createSessionSelection()

    // Session A selects a file
    selection.set("session-a", new Set(["file-a.ts"]))
    // Session B selects a different file
    selection.set("session-b", new Set(["file-b.ts"]))

    expect(selection.get("session-a")).toEqual(new Set(["file-a.ts"]))
    expect(selection.get("session-b")).toEqual(new Set(["file-b.ts"]))
  })

  test("updating one session does not affect another", () => {
    const selection = createSessionSelection()

    selection.set("session-a", new Set(["file-a.ts"]))
    selection.set("session-b", new Set(["file-b.ts"]))

    // Session A adds another file
    selection.set("session-a", (prev) => {
      const next = new Set(prev)
      next.add("file-c.ts")
      return next
    })

    expect(selection.get("session-a")).toEqual(new Set(["file-a.ts", "file-c.ts"]))
    expect(selection.get("session-b")).toEqual(new Set(["file-b.ts"]))
  })

  test("returns empty set for unknown session", () => {
    const selection = createSessionSelection()
    expect(selection.get("unknown")).toEqual(new Set())
  })

  test("clears a specific session's selection", () => {
    const selection = createSessionSelection()

    selection.set("session-a", new Set(["file-a.ts"]))
    selection.set("session-b", new Set(["file-b.ts"]))

    selection.clear("session-a")

    expect(selection.get("session-a")).toEqual(new Set())
    expect(selection.get("session-b")).toEqual(new Set(["file-b.ts"]))
  })
})
