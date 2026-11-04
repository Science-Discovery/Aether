// Adapted from realtime-tex-vsc-plugin (MIT; see LICENSE in this directory).
// Preview state: background pages plus fast-path overlays (realtime-tex docs/VERSIONING.md).
// Pure module (no DOM), unit-tested with node:test.
import type { DisplayList, Fragment, Item, Line, PageUpdate, Placement } from "./protocol"

export interface Overlay {
  parId: number
  dl: DisplayList
  fragments: Fragment[]
  /** source_revision of the edit that produced it. */
  revision: number
}

export interface OverlayRow {
  line: Line
  dx: number
  dy: number
}

export interface PageOverlay {
  overlay: Overlay
  rows: OverlayRow[]
}

export interface LayoutInput {
  pages: PageUpdate[]
  pagesTotal: number
  placements: Placement[]
  /** Keep overlays with revision >= this (the layout is stale since it); null drops them all. */
  keepFromRevision: number | null
}

const MATCH_TOLERANCE = 64 // sp

export class PreviewModel {
  readonly pages = new Map<number, PageUpdate>()
  pagesTotal = 0
  /** Layout placements per unit. */
  readonly placements = new Map<number, Fragment[]>()
  readonly overlays = new Map<number, Overlay>()
  private hiddenCache = new Map<number, Set<number>>()

  get hasLayout(): boolean {
    return this.pagesTotal > 0
  }

  /** Install a background layout. Returns the pages whose drawing changed. */
  applyLayout(input: LayoutInput): Set<number> {
    const dirty = new Set<number>()
    for (const ov of this.overlays.values()) for (const f of ov.fragments) dirty.add(f.page)
    for (const p of input.pages) {
      this.pages.set(p.page, p)
      dirty.add(p.page)
    }
    this.pagesTotal = input.pagesTotal
    for (const n of [...this.pages.keys()]) if (n > input.pagesTotal) this.pages.delete(n)
    this.placements.clear()
    for (const pl of input.placements) this.placements.set(pl.par_id, pl.fragments)
    for (const [id, ov] of [...this.overlays]) {
      if (input.keepFromRevision === null || ov.revision < input.keepFromRevision) {
        this.overlays.delete(id)
        continue
      }
      const placed = this.placements.get(id)
      if (placed) ov.fragments = reanchor(placed, ov.dl.lines)
      for (const f of ov.fragments) dirty.add(f.page)
    }
    this.hiddenCache.clear()
    for (const n of dirty) if (n > this.pagesTotal) dirty.delete(n)
    return dirty
  }

  /** Install a fast-path result. Returns the pages to redraw. */
  applyParagraph(parId: number, dl: DisplayList, fragments: Fragment[], revision: number): Set<number> {
    const dirty = new Set<number>()
    const old = this.overlays.get(parId)
    if (old) for (const f of old.fragments) dirty.add(f.page)
    this.overlays.set(parId, { parId, dl, fragments, revision })
    for (const f of fragments) dirty.add(f.page)
    for (const f of this.placements.get(parId) ?? []) {
      dirty.add(f.page)
      this.hiddenCache.delete(f.page)
    }
    return dirty
  }

  /** Drop overlays (all when `ids` is undefined). Returns the pages to redraw. */
  dropOverlays(ids?: number[]): Set<number> {
    const dirty = new Set<number>()
    const victims = ids ?? [...this.overlays.keys()]
    for (const id of victims) {
      const ov = this.overlays.get(id)
      if (!ov) continue
      this.overlays.delete(id)
      for (const f of ov.fragments) dirty.add(f.page)
      for (const f of this.placements.get(id) ?? []) {
        dirty.add(f.page)
        this.hiddenCache.delete(f.page)
      }
    }
    return dirty
  }

  clear(): void {
    this.pages.clear()
    this.placements.clear()
    this.overlays.clear()
    this.hiddenCache.clear()
    this.pagesTotal = 0
  }

  /** Indices of the page's lines replaced by overlays (rows of units that have one). */
  hiddenLines(page: number): Set<number> {
    let set = this.hiddenCache.get(page)
    if (set) return set
    set = new Set<number>()
    for (const id of this.overlays.keys()) for (const i of this.ownLines(page, id)) set.add(i)
    this.hiddenCache.set(page, set)
    return set
  }

  /**
   * Indices of the page's lines that belong to unit `parId` in the last layout: the lines at
   * the unit's placement rows (baseline and x), plus every other line the capture attributed
   * to the same capture unit (`line.unit`). The second part catches rows a placement does not
   * pin down exactly (a picture row, a display), so nothing of the unit stays behind at its old
   * place while the live result is drawn at the new one.
   */
  ownLines(page: number, parId: number): Set<number> {
    const set = new Set<number>()
    const pu = this.pages.get(page)
    if (!pu) return set
    const units = new Set<number>()
    for (const f of this.placements.get(parId) ?? []) {
      if (f.page !== page) continue
      for (let k = 0; k < f.baselines.length; k++) {
        pu.dl.lines.forEach((line, idx) => {
          if (
            Math.abs(line.y - f.baselines[k]) <= MATCH_TOLERANCE &&
            Math.abs(line.x - (f.xs[k] ?? f.x)) <= MATCH_TOLERANCE
          ) {
            set.add(idx)
            if (line.unit) units.add(line.unit)
          }
        })
      }
    }
    if (units.size) pu.dl.lines.forEach((line, idx) => line.unit && units.has(line.unit) && set.add(idx))
    return set
  }

  /** Overlay rows to draw on `page`, with the translation of each row into page coordinates. */
  overlaysOn(page: number): PageOverlay[] {
    const out: PageOverlay[] = []
    for (const ov of this.overlays.values()) {
      const rows: OverlayRow[] = []
      for (const f of ov.fragments) {
        if (f.page !== page) continue
        for (let k = 0; k < f.baselines.length; k++) {
          const line = ov.dl.lines[f.first_line - 1 + k]
          if (!line) continue
          rows.push({ line, dx: (f.xs[k] ?? f.x) - line.x, dy: f.baselines[k] - line.y })
        }
      }
      if (rows.length) out.push({ overlay: ov, rows })
    }
    return out
  }

  /** Where each unit currently is: overlay fragments win over layout placements. */
  currentPlacements(): Map<number, Fragment[]> {
    const out = new Map(this.placements)
    for (const ov of this.overlays.values()) out.set(ov.parId, ov.fragments)
    return out
  }
}

/** Place a unit's rows at a layout's placement rows (the algorithm of rtex layout.rs
 * `fragments`): rows are positioned relative to the first placement row of each page; rows
 * beyond the placement continue on its last page. */
export function reanchor(placed: readonly Fragment[], rows: readonly Line[]): Fragment[] {
  const pl: { page: number; x: number; y: number }[] = []
  for (const f of placed)
    for (let k = 0; k < f.baselines.length; k++) pl.push({ page: f.page, x: f.xs[k] ?? f.x, y: f.baselines[k] })
  const frags: Fragment[] = []
  let i = 0
  while (i < pl.length && i < rows.length) {
    const page = pl[i].page
    const anchor = pl[i]
    const ax = rows[i].x
    const ay = rows[i].y
    const first = i
    const xs: number[] = []
    const baselines: number[] = []
    while (i < pl.length && pl[i].page === page && i < rows.length) {
      xs.push(anchor.x + (rows[i].x - ax))
      baselines.push(anchor.y + (rows[i].y - ay))
      i++
    }
    let approximate = false
    if (i >= pl.length) {
      while (i < rows.length) {
        xs.push(anchor.x + (rows[i].x - ax))
        baselines.push(anchor.y + (rows[i].y - ay))
        i++
        approximate = true
      }
    }
    frags.push({ page, first_line: first + 1, last_line: i, x: xs[0], xs, baselines, approximate })
  }
  return frags
}

/** A rectangle in sp. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A picture rtex reused from its picture cache: `["u", "cached_picture", "<index> <x> <top> <width> <height>"]`
 * (rtex f345c45; sp, in the list's frame). Undefined for any other item. */
export function cachedPicture(it: Item): (Rect & { index: number }) | undefined {
  if (it[0] !== "u" || it[1] !== "cached_picture") return undefined
  const raw = it[2]
  const v = (
    Array.isArray(raw)
      ? raw
      : String(raw ?? "")
          .trim()
          .split(/\s+/)
  ).map(Number)
  if (v.length < 5 || !v.every(Number.isFinite)) return undefined
  const [index, x, y, w, h] = v
  return w > 0 && h > 0 ? { index, x, y, w, h } : undefined
}

/**
 * Where the cached pictures of a live unit were on the page (`src`, from the page's display
 * list) and where they are now (`dst`, the unit's item moved by its row's translation). A
 * live compile carries a cached picture only as an item; its pixels come from the page as the
 * last layout drew it, so they are carried over to the new position. Only pictures on the
 * unit's own page lines (`own`, from PreviewModel.ownLines) are candidates, paired by picture
 * index, else by size: a picture of another unit is never taken. A picture with no
 * counterpart among them (e.g. it moved here from another page) is skipped.
 */
export function cachedPictureMoves(
  page: DisplayList,
  rows: readonly OverlayRow[],
  own: ReadonlySet<number>,
): { src: Rect; dst: Rect }[] {
  const onPage: (Rect & { index: number })[] = []
  page.lines.forEach((line, idx) => {
    if (!own.has(idx)) return
    for (const it of line.items) {
      const c = cachedPicture(it)
      if (c) onPage.push(c)
    }
  })
  const used = new Set<number>()
  const out: { src: Rect; dst: Rect }[] = []
  for (const { line, dx, dy } of rows) {
    for (const it of line.items) {
      const c = cachedPicture(it)
      if (!c) continue
      const same = (k: number) =>
        !used.has(k) && Math.abs(onPage[k].w - c.w) <= MATCH_TOLERANCE && Math.abs(onPage[k].h - c.h) <= MATCH_TOLERANCE
      let k = onPage.findIndex((p, i) => p.index === c.index && same(i))
      if (k < 0) k = onPage.findIndex((_, i) => same(i))
      if (k < 0) continue
      used.add(k)
      const p = onPage[k]
      out.push({ src: { x: p.x, y: p.y, w: p.w, h: p.h }, dst: { x: c.x + dx, y: c.y + dy, w: c.w, h: c.h } })
    }
  }
  return out
}
