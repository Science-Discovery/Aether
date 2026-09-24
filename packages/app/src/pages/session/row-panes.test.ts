import { describe, expect, test } from "bun:test"
import { cascade } from "./cascade"
import { REVIEW_MIN, SESSION_MIN, SIDEBAR_MIN, TREE_MIN } from "./reading-layout"
import { bounds, panes } from "./row-panes"

describe("panes", () => {
  test("review width excludes the tree width when the tree is closed", () => {
    const list = panes({
      desktop: true,
      reading: false,
      rowWidth: 1200,
      chat: 600,
      tree: 344,
      reviewOpen: true,
      treeOpen: false,
    })
    expect(list).toEqual([
      { width: 600, min: SESSION_MIN },
      { width: 600, min: REVIEW_MIN },
    ])
  })

  test("review width keeps the tree share when the tree is open", () => {
    const list = panes({
      desktop: true,
      reading: false,
      rowWidth: 1200,
      chat: 600,
      tree: 344,
      reviewOpen: true,
      treeOpen: true,
    })
    expect(list).toEqual([
      { width: 600, min: SESSION_MIN },
      { width: 256, min: REVIEW_MIN },
      { width: 344, min: TREE_MIN, key: "fileTree" },
    ])
  })

  test("review only row when the tree is closed and dropped from the chain", () => {
    const list = panes({
      desktop: true,
      reading: false,
      rowWidth: 1200,
      chat: 600,
      tree: 344,
      reviewOpen: false,
      treeOpen: false,
    })
    expect(list).toEqual([{ width: 600, min: SESSION_MIN }])
  })

  test("tree pane survives with review closed", () => {
    const list = panes({
      desktop: true,
      reading: false,
      rowWidth: 1200,
      chat: 600,
      tree: 344,
      reviewOpen: false,
      treeOpen: true,
    })
    expect(list).toEqual([
      { width: 600, min: SESSION_MIN },
      { width: 344, min: TREE_MIN, key: "fileTree" },
    ])
  })

  test("empty chain outside desktop or during reading", () => {
    const input = {
      desktop: true,
      reading: false,
      rowWidth: 1200,
      chat: 600,
      tree: 344,
      reviewOpen: true,
      treeOpen: true,
    }
    expect(panes({ ...input, desktop: false })).toEqual([])
    expect(panes({ ...input, reading: true })).toEqual([])
  })

  test("degenerate widths clamp to their own minimums", () => {
    const list = panes({
      desktop: true,
      reading: false,
      rowWidth: 0,
      chat: 0,
      tree: 0,
      reviewOpen: true,
      treeOpen: true,
    })
    expect(list).toEqual([
      { width: SESSION_MIN, min: SESSION_MIN },
      { width: REVIEW_MIN, min: REVIEW_MIN },
      { width: TREE_MIN, min: TREE_MIN, key: "fileTree" },
    ])
  })
})

describe("bounds", () => {
  test("review can shrink to its own minimum with the tree closed", () => {
    const list = panes({
      desktop: true,
      reading: false,
      rowWidth: 1200,
      chat: 600,
      tree: 344,
      reviewOpen: true,
      treeOpen: false,
    })
    const row = bounds(list, undefined)
    expect(row.high).toBe(1200 - REVIEW_MIN)
    expect(row.low).toBe(SESSION_MIN)
    expect(row.span).toBe(600)
    const out = cascade(row.chain, row.at, row.high - row.span)
    expect(out.widths).toEqual([1200 - REVIEW_MIN, REVIEW_MIN])
  })

  test("review can shrink to its own minimum with the tree open", () => {
    const list = panes({
      desktop: true,
      reading: false,
      rowWidth: 1200,
      chat: 600,
      tree: 344,
      reviewOpen: true,
      treeOpen: true,
    })
    const row = bounds(list, undefined)
    expect(row.high).toBe(1200 - REVIEW_MIN - TREE_MIN)
    const out = cascade(row.chain, row.at, row.high - row.span)
    expect(out.widths).toEqual([1200 - REVIEW_MIN - TREE_MIN, REVIEW_MIN, TREE_MIN])
  })

  test("sidebar share does not change the review slack", () => {
    const list = panes({
      desktop: true,
      reading: false,
      rowWidth: 1200,
      chat: 600,
      tree: 344,
      reviewOpen: true,
      treeOpen: false,
    })
    const row = bounds(list, 241)
    expect(row.chain).toHaveLength(3)
    expect(row.at).toBe(2)
    expect(row.span).toBe(241 + 600)
    expect(row.low).toBe(SIDEBAR_MIN + SESSION_MIN)
    expect(row.high - row.span).toBe(1200 - 600 - REVIEW_MIN)
  })

  test("review slack floors at zero for a cramped row", () => {
    const list = panes({
      desktop: true,
      reading: false,
      rowWidth: 200,
      chat: 600,
      tree: 344,
      reviewOpen: true,
      treeOpen: false,
    })
    const row = bounds(list, undefined)
    expect(row.high).toBe(row.span)
    expect(row.high - row.span).toBe(0)
  })
})
