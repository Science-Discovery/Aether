// Adapted from realtime-tex-vsc-plugin (MIT; see LICENSE in this directory).
// Glyphs of a set of display-list rows, as the text a page shows.
import type { DisplayList, Item, Line } from "./protocol"

export interface TextRow {
  dl: DisplayList
  line: Line
  dx: number
  dy: number
}

// OT1/T1 slots of TFM fonts that are not their ASCII character (ligatures, quotes, dashes)
const TFM_CHARS: Record<number, string> = {
  11: "ff",
  12: "fi",
  13: "fl",
  14: "ffi",
  15: "ffl",
  27: "ff",
  28: "fi",
  29: "fl",
  30: "ffi",
  31: "ffl",
  16: "“",
  17: "”",
  21: "–",
  22: "—",
  34: "”",
  92: "“",
  96: "‘",
  39: "’",
  123: "–",
  124: "—",
}

export function glyphText(char: number, index: unknown): string {
  if (index === null || index === undefined) {
    if (char in TFM_CHARS) return TFM_CHARS[char]
    return char > 32 && char < 127 ? String.fromCharCode(char) : ""
  }
  if (char <= 32 || (char >= 0xe000 && char <= 0xf8ff) || char >= 0xf0000 || char > 0x10ffff) return ""
  return String.fromCodePoint(char).normalize("NFKC")
}

export interface RowGlyph {
  x: number
  y: number
  adv: number
  size: number
  text: string
  /** Index of its row in the `rows` passed in. */
  row: number
  gap: "none" | "space" | "break"
}

/** The glyphs of `rows` that have text, in order: a gap wider than a sixth of the font size is a
 * space. */
export function rowGlyphs(rows: readonly TextRow[]): RowGlyph[] {
  const out: RowGlyph[] = []
  rows.forEach(({ dl, line, dx, dy }, row) => {
    let prev: RowGlyph | undefined
    let end = 0
    for (const it of line.items as Item[]) {
      if (it[0] !== "g") continue
      const [, font, char, index, gx, gy, adv] = it as [string, number, number, number | null, number, number, number]
      const text = glyphText(char, index)
      if (!text) continue
      const size = dl.fonts[String(font)]?.size ?? 655360
      const x = gx + dx
      const y = gy + dy
      let gap: RowGlyph["gap"] = "none"
      if (prev && (Math.abs(y - prev.y) > size * 0.3 || x - end > size / 6 || x < end - size)) {
        gap = Math.abs(y - prev.y) <= size * 0.3 ? "space" : "break"
      }
      prev = { x, y, adv: adv ?? 0, size, text, row, gap }
      out.push(prev)
      end = x + (adv ?? 0)
    }
  })
  return out
}

/** The text of `rows` (words, rows and baselines within a row split by a space) and, per glyph, where its text is. */
export interface GlyphText {
  text: string
  glyphs: (RowGlyph & { start: number })[]
}

export function glyphTextOf(rows: readonly TextRow[]): GlyphText {
  let text = ""
  const glyphs: GlyphText["glyphs"] = []
  let row = -1
  for (const g of rowGlyphs(rows)) {
    if (text && (g.row !== row || g.gap !== "none")) text += " "
    row = g.row
    glyphs.push({ ...g, start: text.length })
    text += g.text
  }
  return { text, glyphs }
}
