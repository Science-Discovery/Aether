import { describe, expect, test } from "bun:test"
import { byteOffset, hitTest, lineColumn, spanAt, targetInFragments, utf16Offset } from "./source"

const spans = [
  { id: 1, kind: "Preamble", hash: 0, last_revision: 1, range: { start: 0, end: 40 } },
  { id: 2, kind: "Body", hash: 0, last_revision: 1, range: { start: 40, end: 80 } },
]

describe("realtime source positions", () => {
  test("finds the span that contains a byte offset", () => {
    expect(spanAt(spans, 0)?.id).toBe(1)
    expect(spanAt(spans, 39)?.id).toBe(1)
    expect(spanAt(spans, 40)?.id).toBe(2)
    expect(spanAt(spans, 999)?.id).toBe(2)
    expect(spanAt([], 1)).toBeUndefined()
  })

  test("maps a row fraction across pages", () => {
    const frags = [
      { page: 1, first_line: 1, last_line: 2, x: 100, xs: [100, 110], baselines: [200, 220], approximate: false },
      { page: 2, first_line: 3, last_line: 3, x: 120, xs: [120], baselines: [300], approximate: false },
    ]
    expect(targetInFragments(frags, 0)).toEqual({ page: 1, y: 200, x: 100 })
    expect(targetInFragments(frags, 0.5)).toEqual({ page: 1, y: 220, x: 110 })
    expect(targetInFragments(frags, 0.99)).toEqual({ page: 2, y: 300, x: 120 })
    expect(targetInFragments([], 0.5)).toBeUndefined()
  })

  test("finds the nearest placed row", () => {
    const placed = new Map([
      [2, [{ page: 1, first_line: 1, last_line: 1, x: 100, xs: [100], baselines: [200], approximate: false }]],
      [3, [{ page: 1, first_line: 1, last_line: 1, x: 100, xs: [100], baselines: [400], approximate: false }]],
    ])
    expect(hitTest(placed, 1, 200 - 3 * 65536 + 10)).toEqual({ parId: 2, fraction: 0 })
    expect(hitTest(placed, 1, 400)).toEqual({ parId: 3, fraction: 0 })
    expect(hitTest(placed, 2, 400)).toBeUndefined()
  })

  test("converts between UTF-8 byte offsets and UTF-16 source positions", () => {
    const text = "你好\nworld"
    expect(byteOffset(text, 1, 1)).toBe(0)
    expect(byteOffset(text, 1, 2)).toBe(3)
    expect(byteOffset(text, 2, 1)).toBe(7)
    expect(byteOffset(text, 2, 6)).toBe(12)
    expect(lineColumn(text, 0)).toEqual({ line: 1, column: 1 })
    expect(lineColumn(text, 1)).toEqual({ line: 1, column: 2 })
    expect(lineColumn(text, 3)).toEqual({ line: 2, column: 1 })
    expect(lineColumn(text, 7)).toEqual({ line: 2, column: 5 })
    expect(utf16Offset(text, 3)).toBe(1)
    expect(utf16Offset(text, 7)).toBe(3)
    expect(utf16Offset(text, 1)).toBe(0)
  })
})
