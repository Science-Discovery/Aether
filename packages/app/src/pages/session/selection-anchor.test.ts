import { describe, expect, test } from "bun:test"
import { resolveSelectionAnchorRect } from "./selection-anchor"

describe("resolveSelectionAnchorRect", () => {
  test("returns the first-line rect for single-line selections", () => {
    const result = resolveSelectionAnchorRect({
      containerWidth: 800,
      rects: [{ top: 100, left: 120, right: 280, bottom: 124, width: 160, height: 24 }],
    })

    expect(result).toEqual({
      top: 100,
      left: 120,
      right: 280,
      bottom: 124,
      width: 160,
      height: 24,
    })
  })

  test("filters oversized container rects before positioning", () => {
    const result = resolveSelectionAnchorRect({
      containerWidth: 800,
      rects: [
        { top: 100, left: 120, right: 280, bottom: 124, width: 160, height: 24 },
        { top: 96, left: 40, right: 760, bottom: 132, width: 720, height: 36 },
      ],
    })

    expect(result).toEqual({
      top: 100,
      left: 120,
      right: 280,
      bottom: 124,
      width: 160,
      height: 24,
    })
  })

  test("uses only the first line for multi-line text rects", () => {
    const result = resolveSelectionAnchorRect({
      containerWidth: 800,
      rects: [
        { top: 100, left: 120, right: 280, bottom: 124, width: 160, height: 24 },
        { top: 132, left: 120, right: 360, bottom: 156, width: 240, height: 24 },
      ],
    })

    expect(result).toEqual({
      top: 100,
      left: 120,
      right: 280,
      bottom: 124,
      width: 160,
      height: 24,
    })
  })

  test("falls back to original first-line rects when filtered first-line rects become empty", () => {
    const result = resolveSelectionAnchorRect({
      containerWidth: 800,
      rects: [
        { top: 96, left: 40, right: 760, bottom: 132, width: 720, height: 36 },
        { top: 132, left: 120, right: 360, bottom: 156, width: 240, height: 24 },
      ],
    })

    expect(result).toEqual({
      top: 96,
      left: 40,
      right: 760,
      bottom: 132,
      width: 720,
      height: 36,
    })
  })

  test("uses fallback rect when no client rects are available", () => {
    const result = resolveSelectionAnchorRect({
      containerWidth: 800,
      rects: [],
      fallbackRect: { top: 100, left: 120, right: 280, bottom: 124, width: 160, height: 24 },
    })

    expect(result).toEqual({
      top: 100,
      left: 120,
      right: 280,
      bottom: 124,
      width: 160,
      height: 24,
    })
  })
})
