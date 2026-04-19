import { describe, expect, test } from "bun:test"
import {
  getReadingLayoutMode,
  getReadingLayoutVariant,
  CHAT_RATIO_BOUNDS,
  FILE_TREE_RATIOS,
  PDF_RATIO_BOUNDS,
  VARIANT_DEFAULTS,
} from "./reading-layout"

describe("reading layout helpers", () => {
  test("maps side-panel open state to layout variant", () => {
    expect(getReadingLayoutVariant(false, false)).toBe("two-pane")
    expect(getReadingLayoutVariant(false, true)).toBe("tree")
    expect(getReadingLayoutVariant(true, false)).toBe("review")
    expect(getReadingLayoutVariant(true, true)).toBe("review-tree")
  })

  test("maps variant and swap state to layout mode", () => {
    expect(getReadingLayoutMode("two-pane", false)).toBe("two-left")
    expect(getReadingLayoutMode("two-pane", true)).toBe("two-right")
    expect(getReadingLayoutMode("tree", false)).toBe("tree-left")
    expect(getReadingLayoutMode("tree", true)).toBe("tree-right")
    expect(getReadingLayoutMode("review", false)).toBe("review-left")
    expect(getReadingLayoutMode("review", true)).toBe("review-right")
    expect(getReadingLayoutMode("review-tree", false)).toBe("review-tree-left")
    expect(getReadingLayoutMode("review-tree", true)).toBe("review-tree-right")
  })

  test("keeps classic layout defaults intact", () => {
    expect(VARIANT_DEFAULTS["two-pane"]).toEqual({ pdf: 0.55, chat: 0.45 })
    expect(FILE_TREE_RATIOS["review-tree"]).toBe(0.12)
    expect(PDF_RATIO_BOUNDS.review).toEqual({ min: 0.3, max: 0.45 })
    expect(CHAT_RATIO_BOUNDS["review-tree"]).toEqual({ min: 0.25, max: 0.3 })
  })
})
