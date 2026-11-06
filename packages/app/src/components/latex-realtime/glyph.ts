// Adapted from realtime-tex-vsc-plugin (MIT; see LICENSE in this directory).
// Character-exact mapping between preview glyphs and the source text of their unit. TeX keeps no
// column positions, so the glyph text of a unit is aligned with the unit's source text, with the
// markup that prints nothing taken out (longest common subsequence).
import type { PreviewModel } from "./model"
import { glyphTextOf, type GlyphText, type TextRow } from "./text"

/** A character of `text` under a click: the glyph whose box holds (`x`, `y`) or is nearest it,
 * and whether the click is on the character's right half (the caret goes after it). */
export function charAt(
  gt: GlyphText,
  x: number,
  y: number,
): { index: number; after: boolean; on: boolean } | undefined {
  let best: GlyphText["glyphs"][number] | undefined
  let bestV = Infinity
  let bestX = Infinity
  for (const g of gt.glyphs) {
    const [t, b] = [g.y - 0.75 * g.size, g.y + 0.25 * g.size]
    const v = y < t ? t - y : y > b ? y - b : 0
    const dx = x < g.x ? g.x - x : x > g.x + g.adv ? x - g.x - g.adv : 0
    if (v < bestV || (v === bestV && dx < bestX)) [best, bestV, bestX] = [g, v, dx]
  }
  if (!best) return undefined
  const f = best.adv > 0 ? Math.min(Math.max((x - best.x) / best.adv, 0), 0.999) * best.text.length : 0
  return { index: best.start + Math.floor(f), after: f - Math.floor(f) >= 0.5, on: bestV === 0 && bestX === 0 }
}

/** Source text with the markup that prints nothing removed; `start`/`end` give each character's
 * source range (a `--` is one character there, like the dash it prints). */
export interface Visible {
  text: string
  start: number[]
  end: number[]
}

const HIDDEN_ARG = new Set([
  "label",
  "ref",
  "eqref",
  "pageref",
  "autoref",
  "nameref",
  "cref",
  "Cref",
  "cite",
  "citep",
  "citet",
  "parencite",
  "textcite",
  "autocite",
  "footcite",
  "nocite",
  "begin",
  "end",
  "includegraphics",
  "input",
  "include",
  "hspace",
  "vspace",
  "color",
  "textcolor",
  "href",
  "index",
  "hyperref",
  "cline",
  "multicolumn",
  "multirow",
  "setlength",
  "addtolength",
])

const TWO_HIDDEN_ARGS = new Set(["multicolumn", "multirow"])

export function visibleSource(src: string): Visible {
  const v: Visible = { text: "", start: [], end: [] }
  const emit = (ch: string, s: number, e: number) => {
    v.text += ch
    v.start.push(s)
    v.end.push(e)
  }
  const isLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "@"
  const group = (i: number, open: string, close: string): number => {
    if (src[i] !== open) return i
    let depth = 0
    for (let k = i; k < src.length; k++) {
      if (src[k] === "\\") k++
      else if (src[k] === open) depth++
      else if (src[k] === close && --depth === 0) return k + 1
    }
    return src.length
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "%") {
      while (i < src.length && src[i] !== "\n") i++
    } else if (c === "\\") {
      const n = src[i + 1] ?? ""
      if (isLetter(n)) {
        let k = i + 1
        while (k < src.length && isLetter(src[k])) k++
        const name = src.slice(i + 1, k)
        if (src[k] === "*") k++
        while (src[k] === " " || src[k] === "\t") k++
        if (src[k] === "\n") k++
        if (HIDDEN_ARG.has(name)) {
          for (let j = group(k, "[", "]"); j !== k; j = group(k, "[", "]")) k = j
          k = group(k, "{", "}")
          if (TWO_HIDDEN_ARGS.has(name)) k = group(k, "{", "}")
        }
        i = k
      } else {
        if ("&%$#_{}".includes(n) && n) emit(n, i, i + 2)
        else if ((n === " " || n === "\\") && !v.text.endsWith(" ")) emit(" ", i, i + 2)
        i += 2
      }
    } else if ("{}$&^_#".includes(c)) {
      i++
    } else if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "~") {
      if (v.text && !v.text.endsWith(" ")) emit(" ", i, i + 1)
      i++
    } else if ((c === "`" || c === "'") && src[i + 1] === c) {
      emit('"', i, i + 2)
      i += 2
    } else if (c === "`") {
      emit("'", i, i + 1)
      i++
    } else if (c === "-") {
      const n = src.startsWith("---", i) ? 3 : src.startsWith("--", i) ? 2 : 1
      emit("-", i, i + n)
      i += n
    } else {
      emit(c, i, i + 1)
      i++
    }
  }
  return v
}

function fold(c: string): string {
  if (c === "“" || c === "”" || c === "„") return '"'
  if (c === "‘" || c === "’" || c === "`") return "'"
  if (c === "–" || c === "—" || c === "‐" || c === "−") return "-"
  if (c === " ") return " "
  return c
}

const MAX_CELLS = 8_000_000

export function align(a: string, b: string, a0 = 0, a1 = a.length, b0 = 0, b1 = b.length): Int32Array {
  const out = new Int32Array(a.length).fill(-1)
  const n = a1 - a0
  const m = b1 - b0
  if (n <= 0 || m <= 0) return out
  const w = m + 1
  const dp = new Uint16Array((n + 1) * w)
  const fa = Array.from(a.slice(a0, a1), fold)
  for (let i = 1; i <= n; i++) {
    const ca = fa[i - 1]
    for (let j = 1; j <= m; j++) {
      dp[i * w + j] =
        ca === b[b0 + j - 1] ? dp[(i - 1) * w + j - 1] + 1 : Math.max(dp[(i - 1) * w + j], dp[i * w + j - 1])
    }
  }
  for (let i = n, j = m; i > 0 && j > 0; ) {
    if (fa[i - 1] === b[b0 + j - 1] && dp[i * w + j] === dp[(i - 1) * w + j - 1] + 1) {
      out[a0 + i - 1] = b0 + j - 1
      i--
      j--
    } else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) i--
    else j--
  }
  return out
}

function nearestMatch(match: Int32Array, index: number, a0: number, a1: number, self = false): number | undefined {
  if (self && match[index] >= 0) return match[index]
  for (let d = 1; index - d >= a0 || index + d < a1; d++) {
    if (index - d >= a0 && match[index - d] >= 0) return match[index - d] + d
    if (index + d < a1 && match[index + d] >= 0) return match[index + d] - d
  }
  return undefined
}

export function foldText(s: string): string {
  return Array.from(s, fold).join("")
}

export function charMap(
  gt: GlyphText,
  src: string,
  around: number,
): { vis: Visible; at: Int32Array; a0: number; a1: number } {
  const vis = visibleSource(src)
  const n = gt.text.length
  let [a0, a1, b0, b1] = [0, n, 0, vis.text.length]
  if (n * vis.text.length > MAX_CELLS) {
    a0 = Math.max(0, around - 300)
    a1 = Math.min(n, around + 300)
    const width = Math.min(vis.text.length, Math.floor(MAX_CELLS / (a1 - a0)))
    const mid = Math.round((around / Math.max(1, n)) * vis.text.length)
    b0 = Math.max(0, Math.min(vis.text.length - width, mid - (width >> 1)))
    b1 = b0 + width
  }
  const match = align(gt.text, vis.text, a0, a1, b0, b1)
  const at = Int32Array.from(match)
  for (let ws = a0; ws < a1; ) {
    let we = ws
    while (we < a1 && gt.text[we] !== " ") we++
    const word = foldText(gt.text.slice(ws, we))
    if (word) {
      const near = nearestMatch(match, ws, a0, a1, true)
      let occ = -1
      for (
        let k = vis.text.indexOf(word), tries = 0;
        k >= 0 && tries < 256;
        k = vis.text.indexOf(word, k + 1), tries++
      ) {
        if (occ < 0 || (near !== undefined && Math.abs(k - near) < Math.abs(occ - near))) occ = k
      }
      if (occ >= 0) for (let i = ws; i < we; i++) at[i] = occ + i - ws
    }
    ws = we + 1
  }
  return { vis, at, a0, a1 }
}

export function sourceOffset(gt: GlyphText, index: number, after: boolean, src: string): number | undefined {
  const { vis, at, a0, a1 } = charMap(gt, src, index)
  if (at[index] >= 0) return after ? vis.end[at[index]] : vis.start[at[index]]
  for (let k = index - 1; k >= a0; k--) if (at[k] >= 0) return vis.end[at[k]]
  for (let k = index + 1; k < a1; k++) if (at[k] >= 0) return vis.start[at[k]]
  return undefined
}

export function charAtOffset(
  gt: GlyphText,
  src: string,
  offset: number,
): { index: number; after: boolean; distance: number } | undefined {
  const around = Math.round((offset / Math.max(1, src.length)) * gt.text.length)
  const { vis, at, a0, a1 } = charMap(gt, src, around)
  let best: { index: number; after: boolean; distance: number } | undefined
  for (let i = a0; i < a1; i++) {
    if (at[i] < 0) continue
    const [s, e] = [vis.start[at[i]], vis.end[at[i]]]
    if (offset >= s && offset < e) return { index: i, after: false, distance: 0 }
    const c =
      e <= offset ? { index: i, after: true, distance: offset - e } : { index: i, after: false, distance: s - offset }
    if (!best || c.distance < best.distance || (c.distance === best.distance && c.after)) best = c
  }
  return best
}

/** Where the caret for `char` of `gt` goes, in sp: x, baseline and font size. */
export function caretAt(
  gt: GlyphText,
  char: { index: number; after: boolean },
): { x: number; y: number; size: number } | undefined {
  const g = gt.glyphs.find((g) => g.start <= char.index && char.index < g.start + g.text.length)
  if (!g) return undefined
  return { x: g.x + (g.adv * (char.index - g.start + (char.after ? 1 : 0))) / g.text.length, y: g.y, size: g.size }
}

/** How much of `gt`'s text `src` has: the share of its words (3 characters or more) found in the
 * visible source. */
export function matchScore(gt: GlyphText, src: string): number {
  const vis = visibleSource(src).text
  const words = foldText(gt.text)
    .split(" ")
    .filter((w) => w.length >= 3)
  return words.length ? words.filter((w) => vis.includes(w)).length / words.length : 0
}

/** The rows of each unit on `page` as the preview draws them: a unit's live rows where it has
 * them, else its rows in the last layout. */
export function unitRows(model: PreviewModel, page: number): Map<number, TextRow[]> {
  const units = new Map<number, TextRow[]>()
  const pu = model.pages.get(page)
  if (!pu) return units
  for (const { overlay, rows } of model.overlaysOn(page))
    units.set(
      overlay.parId,
      rows.map((r) => ({ dl: overlay.dl, ...r })),
    )
  for (const [parId, frags] of model.placements) {
    if (units.has(parId) || !frags.some((f) => f.page === page)) continue
    const own = [...model.ownLines(page, parId)].sort((a, b) => a - b)
    units.set(
      parId,
      own.map((i) => ({ dl: pu.dl, line: pu.dl.lines[i], dx: 0, dy: 0 })),
    )
  }
  return units
}

/** The page's lines that no unit owns (footnote text, margin notes, running heads), one row each. */
export function orphanRows(model: PreviewModel, page: number, units = unitRows(model, page)): TextRow[] {
  const pu = model.pages.get(page)
  if (!pu) return []
  const owned = new Set(model.hiddenLines(page))
  for (const parId of units.keys()) for (const i of model.ownLines(page, parId)) owned.add(i)
  return pu.dl.lines.filter((_, i) => !owned.has(i)).map((line) => ({ dl: pu.dl, line, dx: 0, dy: 0 }))
}

/** The unit and character under a click at (page, x, y), in sp, as the preview draws the page. */
export function clickedChar(
  model: PreviewModel,
  page: number,
  x: number,
  y: number,
): { parIds: number[]; gt: GlyphText; index: number; after: boolean } | undefined {
  const units = unitRows(model, page)
  const groups: { parIds: number[]; rows: TextRow[] }[] = [...units].map(([parId, rows]) => ({ parIds: [parId], rows }))
  const dist = (frags: readonly { page: number }[]) => Math.min(...frags.map((f) => Math.abs(f.page - page)))
  const everyUnit = [...model.placements].sort((a, b) => dist(a[1]) - dist(b[1])).map(([id]) => id)
  for (const row of orphanRows(model, page, units)) groups.push({ parIds: everyUnit, rows: [row] })
  let best: { parIds: number[]; rows: TextRow[]; v: number; h: number } | undefined
  for (const { parIds, rows } of groups) {
    for (const { line, dx, dy } of rows) {
      const [l, r, t, b] = [line.x + dx, line.x + dx + line.w, line.y + dy - line.h, line.y + dy + line.d]
      const v = Math.max(t - y, 0, y - b)
      const h = Math.max(l - x, 0, x - r)
      if (!best || v < best.v || (v === best.v && h < best.h)) best = { parIds, rows, v, h }
    }
  }
  if (!best || best.v > 24 * 65536) return undefined
  const gt = glyphTextOf(best.rows)
  const at = charAt(gt, x, y)
  return at && { parIds: best.parIds, gt, index: at.index, after: at.after }
}
