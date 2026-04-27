import { describe, expect, test } from "bun:test"
import { closeList } from "./server-close"

const a = { worktree: "a", expanded: true }
const b = { worktree: "b", expanded: false }
const c = { worktree: "c", expanded: true }

describe("closeList", () => {
  test("removes project and keeps last when closing non-last", () => {
    const out = closeList([a, b, c], "b", "a")
    expect(out.next).toEqual([b, c])
    expect(out.last).toBe("b")
    expect(out.edit).toBe(false)
  })

  test("moves last to head when closing current last", () => {
    const out = closeList([a, b, c], "b", "b")
    expect(out.next).toEqual([a, c])
    expect(out.last).toBe("a")
    expect(out.edit).toBe(true)
  })

  test("clears last when closing only project", () => {
    const out = closeList([b], "b", "b")
    expect(out.next).toEqual([])
    expect(out.last).toBeUndefined()
    expect(out.edit).toBe(true)
  })

  test("heals stale last even when project already absent", () => {
    const out = closeList([a, c], "b", "b")
    expect(out.next).toEqual([a, c])
    expect(out.last).toBe("a")
    expect(out.edit).toBe(true)
  })
})
