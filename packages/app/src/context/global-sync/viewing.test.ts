import { describe, expect, test } from "bun:test"
import { isViewing, markViewing, viewingIDs } from "./viewing"

describe("viewing", () => {
  test("tracks the currently viewed session", () => {
    markViewing("ses_a")
    expect(isViewing("ses_a")).toBe(true)
    expect(viewingIDs().has("ses_a")).toBe(true)
    markViewing(undefined)
  })

  test("replaces the previous session on each mark", () => {
    markViewing("ses_a")
    markViewing("ses_b")
    expect(isViewing("ses_a")).toBe(false)
    expect(isViewing("ses_b")).toBe(true)
    markViewing(undefined)
  })

  test("clears on empty mark", () => {
    markViewing("ses_a")
    markViewing(undefined)
    expect(isViewing("ses_a")).toBe(false)
    expect(viewingIDs().size).toBe(0)
  })

  test("ignores empty ids", () => {
    markViewing("")
    expect(viewingIDs().size).toBe(0)
  })
})
