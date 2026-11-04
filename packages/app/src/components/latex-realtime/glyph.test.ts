import { describe, expect, test } from "bun:test"
import { charAt, charAtOffset, caretAt, sourceOffset, visibleSource } from "./glyph"
import type { GlyphText } from "./text"

const glyphs = Array.from("Hello").map((text, index) => ({
  x: index * 100,
  y: 200,
  adv: 100,
  size: 100,
  text,
  row: 0,
  gap: "none" as const,
  start: index,
}))
const gt: GlyphText = { text: "Hello", glyphs }

describe("realtime glyph mapping", () => {
  test("removes source markup that prints nothing", () => {
    expect(visibleSource("\\textbf{Hello} -- world").text).toBe("Hello - world")
    expect(visibleSource("a\\label{sec:a}b").text).toBe("ab")
    expect(visibleSource("100\\%").text).toBe("100%")
  })

  test("maps source offsets to characters and back", () => {
    const source = "\\textbf{Hello}"
    expect(charAtOffset(gt, source, 9)).toMatchObject({ index: 1, after: false, distance: 0 })
    expect(sourceOffset(gt, 1, false, source)).toBe(9)
    expect(sourceOffset(gt, 4, true, source)).toBe(13)
  })

  test("locates characters and carets in a row", () => {
    expect(charAt(gt, 150, 200)).toMatchObject({ index: 1, after: true, on: true })
    expect(caretAt(gt, { index: 1, after: false })).toEqual({ x: 100, y: 200, size: 100 })
    expect(caretAt(gt, { index: 1, after: true })).toEqual({ x: 200, y: 200, size: 100 })
  })
})
