// Re-anchoring for live-preview annotations. A text annotation is anchored to its rtex unit and
// its exact text plus surrounding context; image/rule/cached-picture and page anchors cover
// material without selectable glyphs. Layout updates project anchors into the new display lists,
// and anchors whose target no longer exists drop the annotation.
import type { PdfAnnotation } from "../pdf-viewer-shell-official"
import { cachedPicture, type PreviewModel } from "./model"
import type { DisplayList, Item, Line } from "./protocol"
import { imageInfo, IDENTITY, mul, type Mat } from "./render"
import { glyphTextOf, type GlyphText } from "./text"

const BP_TO_SP = 65536 * (72.27 / 72)
const SP_TO_BP = 72 / 72.27 / 65536

export type TextAnchor = {
  kind: "text"
  parId: number
  exact: string
  prefix: string
  suffix: string
  relative: number
}

export type BlockAnchor = {
  kind: "block"
  parId?: number
  item: { kind: "image" | "rule" | "picture"; key: string }
  rect: { x: number; y: number; w: number; h: number }
}

export type PageAnchor = {
  kind: "page"
  page: number
  rect: { x: number; y: number; w: number; h: number }
}

export type Anchor = TextAnchor | BlockAnchor | PageAnchor

type Box = { x: number; y: number; w: number; h: number }
type Glyph = GlyphText["glyphs"][number]
type Hit = { page: number; unit?: number; glyph: Glyph }
type Index = { text: string; map: (Hit | undefined)[] }
type Row = { page: number; dl: DisplayList; line: Line }

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function rows(model: PreviewModel, unit?: number): Row[] {
  const out: Row[] = []
  for (const page of [...model.pages.keys()].sort((a, b) => a - b)) {
    const value = model.pages.get(page)
    if (!value) continue
    for (const line of value.dl.lines) {
      if (unit !== undefined && (line.unit ?? line.par) !== unit) continue
      out.push({ page, dl: value.dl, line })
    }
  }
  return out
}

function index(rows: readonly Row[]): Index {
  const glyphs = glyphTextOf(rows.map((row) => ({ dl: row.dl, line: row.line, dx: 0, dy: 0 })))
  const raw: string[] = []
  const map: (Hit | undefined)[] = []
  let row = -1
  for (const glyph of glyphs.glyphs) {
    if (raw.length && (glyph.row !== row || glyph.gap !== "none")) {
      raw.push(" ")
      map.push(undefined)
    }
    row = glyph.row
    const line = rows[glyph.row]
    for (const char of glyph.text) {
      raw.push(char)
      map.push(line ? { page: line.page, unit: line.line.unit ?? line.line.par, glyph } : undefined)
    }
  }

  let text = ""
  const normalized: (Hit | undefined)[] = []
  let space = false
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) {
      space = true
      continue
    }
    if (space && text) {
      text += " "
      normalized.push(undefined)
      space = false
    }
    text += raw[i]
    normalized.push(map[i])
  }
  return { text, map: normalized }
}

function oldPosition(model: PreviewModel, item: PdfAnnotation) {
  const page = item.pages[0]?.page ?? 1
  const quad = item.pages[0]?.quads[0]
  const height = model.pages.get(page)?.dl.page_height
  return { page, y: quad && height ? height - quad[5] * BP_TO_SP : undefined }
}

function distance(hit: Hit, old: { page: number; y?: number }) {
  const vertical = old.y === undefined ? 0 : Math.abs(hit.glyph.y - old.y)
  return Math.abs(hit.page - old.page) * 1_000_000_000_000 + vertical
}

function find(index: Index, needle: string, old: { page: number; y?: number }) {
  let from = 0
  let best: { at: number; distance: number } | undefined
  while (from <= index.text.length) {
    const at = index.text.indexOf(needle, from)
    if (at < 0) break
    const hit = index.map[at]
    if (hit) {
      const next = { at, distance: distance(hit, old) }
      if (!best || next.distance < best.distance) best = next
    }
    from = at + 1
  }
  return best
}

function quads(index: Index, model: PreviewModel, at: number, length: number) {
  const groups = new Map<string, { page: number; row: number; x0: number; x1: number; top: number; bottom: number }>()
  for (let i = at; i < at + length; i++) {
    const hit = index.map[i]
    if (!hit) continue
    const glyph = hit.glyph
    const key = `${hit.page}:${glyph.row}`
    const right = glyph.x + Math.max(glyph.adv, glyph.size * 0.25)
    const top = glyph.y - 0.75 * glyph.size
    const bottom = glyph.y + 0.25 * glyph.size
    const group = groups.get(key)
    if (!group) {
      groups.set(key, { page: hit.page, row: glyph.row, x0: glyph.x, x1: right, top, bottom })
      continue
    }
    group.x0 = Math.min(group.x0, glyph.x)
    group.x1 = Math.max(group.x1, right)
    group.top = Math.min(group.top, top)
    group.bottom = Math.max(group.bottom, bottom)
  }

  const pages = new Map<number, PdfAnnotation["pages"][number]["quads"]>()
  for (const group of groups.values()) {
    const quad = quadFor(group.page, model, group.x0, group.x1, group.top, group.bottom)
    if (!quad) continue
    const list = pages.get(group.page)
    if (list) list.push(quad)
    else pages.set(group.page, [quad])
  }

  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([page, quads]) => ({ page, quads }))
}

function quadFor(page: number, model: PreviewModel, x0: number, x1: number, top: number, bottom: number) {
  const height = model.pages.get(page)?.dl.page_height
  if (!height) return
  const left = x0 * SP_TO_BP
  const right = x1 * SP_TO_BP
  const upper = (height - top) * SP_TO_BP
  const lower = (height - bottom) * SP_TO_BP
  return [left, upper, right, upper, left, lower, right, lower] as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
}

function box(item: PdfAnnotation, model: PreviewModel) {
  const part = item.pages[0]
  const quad = part?.quads[0]
  const height = part ? model.pages.get(part.page)?.dl.page_height : undefined
  if (!part || !quad || !height) return
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]].map((value) => height - value * BP_TO_SP)
  const left = Math.min(...xs) * BP_TO_SP
  const right = Math.max(...xs) * BP_TO_SP
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  return { page: part.page, x: left, y: top, w: right - left, h: bottom - top }
}

type Entry = { key: string; box: Box; kind: "image" | "picture" | "rule" }

function rawBox(it: Item): Box | undefined {
  if (it[0] === "i") {
    const [, , x, y, w, h] = it as [string, number, number, number, number, number]
    return w > 0 && h > 0 ? { x, y, w, h } : undefined
  }
  if (it[0] === "r") {
    const [, x, y, w, h] = it as [string, number, number, number, number]
    return w > 0 && h > 0 ? { x, y, w, h } : undefined
  }
  if (it[0] === "u") {
    const value = cachedPicture(it)
    return value ? { x: value.x, y: value.y, w: value.w, h: value.h } : undefined
  }
  return undefined
}

function moved(matrix: Mat, box: Box): Box {
  const points = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h],
  ].map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]])
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { x: left, y: top, w: Math.max(...xs) - left, h: Math.max(...ys) - top }
}

/** Block items of one item list, with the affine matrix in force at each item applied. */
function entries(dl: DisplayList, items: readonly Item[]): Entry[] {
  const out: Entry[] = []
  const stack: Mat[] = []
  const seen = new Map<string, number>()
  let matrix: Mat = IDENTITY
  for (const it of items) {
    if (it[0] === "M") {
      const [, op, x, y, data] = it as [string, string, number, number, unknown]
      if (op === "save") {
        stack.push(matrix)
        continue
      }
      if (op === "restore") {
        matrix = stack.pop() ?? IDENTITY
        continue
      }
      const raw = Array.isArray(data)
        ? data
        : String(data ?? "")
            .trim()
            .split(/\s+/)
      const value = raw.map(Number)
      if (value.length !== 4 || !value.every(Number.isFinite)) continue
      const [a, b, c, d] = [value[0], -value[1], -value[2], value[3]]
      matrix = mul(matrix, [a, b, c, d, x - (a * x + c * y), y - (b * x + d * y)])
      continue
    }
    const box = rawBox(it)
    if (!box) continue
    const movedBox = moved(matrix, box)
    const key = itemKey(dl, it, movedBox, seen)
    if (key) out.push({ key, box: movedBox, kind: it[0] === "i" ? "image" : it[0] === "u" ? "picture" : "rule" })
  }
  return out
}

function itemKey(dl: DisplayList, it: Item, box: Box, seen: Map<string, number>) {
  if (it[0] === "i") {
    const index = it[1] as number
    const info = imageInfo(dl, index)
    const base = `image:${info?.file ?? "?"}:${info?.page ?? 1}:${index}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return `${base}:${count}`
  }
  if (it[0] === "r") {
    const base = `rule:${Math.round(box.w)}x${Math.round(box.h)}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return `${base}:${count}`
  }
  if (it[0] === "u") {
    const value = cachedPicture(it)
    if (!value) return
    const base = `picture:${value.index}:${Math.round(box.w)}x${Math.round(box.h)}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return `${base}:${count}`
  }
  return
}

function itemAt(model: PreviewModel, page: number, x: number, y: number) {
  const value = model.pages.get(page)
  if (!value) return
  let best: { box: Box; key: string; parId?: number; area: number } | undefined
  const scan = (items: readonly Item[], parId?: number) => {
    for (const entry of entries(value.dl, items)) {
      const box = entry.box
      if (x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h) continue
      const area = box.w * box.h
      if (!best || area < best.area) best = { box, key: entry.key, parId, area }
    }
  }
  for (const line of value.dl.lines) scan(line.items, line.unit ?? line.par)
  scan(value.dl.other)
  return best
}

function findItem(model: PreviewModel, anchor: BlockAnchor) {
  for (const page of [...model.pages.keys()].sort((a, b) => a - b)) {
    const value = model.pages.get(page)
    if (!value) continue
    const scan = (items: readonly Item[], parId?: number) => {
      if (anchor.parId !== undefined && parId !== anchor.parId) return
      for (const entry of entries(value.dl, items)) {
        if (entry.key === anchor.item.key) return { page, box: entry.box }
      }
    }
    for (const line of value.dl.lines) {
      const found = scan(line.items, line.unit ?? line.par)
      if (found) return found
    }
    if (anchor.parId === undefined) {
      const found = scan(value.dl.other)
      if (found) return found
    }
  }
  return
}

function blockAnchor(model: PreviewModel, item: PdfAnnotation): BlockAnchor | undefined {
  const area = box(item, model)
  if (!area) return
  const found = itemAt(model, area.page, area.x + area.w / 2, area.y + area.h / 2)
  if (!found) return
  return {
    kind: "block",
    parId: found.parId,
    item: {
      kind: found.key.startsWith("image:") ? "image" : found.key.startsWith("rule:") ? "rule" : "picture",
      key: found.key,
    },
    rect: {
      x: (area.x - found.box.x) / found.box.w,
      y: (area.y - found.box.y) / found.box.h,
      w: area.w / found.box.w,
      h: area.h / found.box.h,
    },
  }
}

function pageAnchor(model: PreviewModel, item: PdfAnnotation): PageAnchor | undefined {
  const area = box(item, model)
  if (!area) return
  const page = model.pages.get(area.page)
  if (!page?.dl.page_width || !page.dl.page_height) return
  return {
    kind: "page",
    page: area.page,
    rect: {
      x: area.x / page.dl.page_width,
      y: area.y / page.dl.page_height,
      w: area.w / page.dl.page_width,
      h: area.h / page.dl.page_height,
    },
  }
}

function textAnchors(model: PreviewModel, item: PdfAnnotation, needle: string): TextAnchor[] {
  const all = index(rows(model))
  const found = find(all, needle, oldPosition(model, item))
  if (!found) return []
  const groups = new Map<number, { chars: string[]; glyph?: Glyph }>()
  let last: number | undefined
  for (let i = found.at; i < found.at + needle.length; i++) {
    const hit = all.map[i]
    if (hit?.unit === undefined) {
      if (last !== undefined) groups.get(last)?.chars.push(" ")
      continue
    }
    let group = groups.get(hit.unit)
    if (!group) {
      group = { chars: [] }
      groups.set(hit.unit, group)
    }
    group.chars.push(needle[i - found.at])
    group.glyph ??= hit.glyph
    last = hit.unit
  }

  const out: TextAnchor[] = []
  for (const [parId, group] of groups) {
    const exact = normalize(group.chars.join(""))
    if (!exact) continue
    const unit = index(rows(model, parId))
    if (!unit.text) continue
    let best: { at: number; distance: number } | undefined
    let from = 0
    while (from <= unit.text.length) {
      const at = unit.text.indexOf(exact, from)
      if (at < 0) break
      const glyph = unit.map[at]?.glyph
      const distance =
        glyph && group.glyph ? Math.abs(glyph.y - group.glyph.y) + Math.abs(glyph.x - group.glyph.x) : Infinity
      if (!best || distance < best.distance) best = { at, distance }
      from = at + 1
    }
    if (!best) continue
    out.push({
      kind: "text",
      parId,
      exact,
      prefix: normalize(unit.text.slice(Math.max(0, best.at - 24), best.at)),
      suffix: normalize(unit.text.slice(best.at + exact.length, best.at + exact.length + 24)),
      relative: best.at / Math.max(1, unit.text.length),
    })
  }
  return out
}

export function anchorsFor(model: PreviewModel, item: PdfAnnotation): Anchor[] {
  const needle = normalize(item.selectedText)
  if (needle) return textAnchors(model, item, needle)
  const block = blockAnchor(model, item)
  if (block) return [block]
  const page = pageAnchor(model, item)
  return page ? [page] : []
}

function project(model: PreviewModel, anchor: Anchor) {
  if (anchor.kind === "text") {
    const unit = index(rows(model, anchor.parId))
    if (!unit.text) return
    const exact = normalize(anchor.exact)
    if (!exact) return
    let best: { at: number; score: number } | undefined
    let from = 0
    while (from <= unit.text.length) {
      const at = unit.text.indexOf(exact, from)
      if (at < 0) break
      const prefix = normalize(unit.text.slice(Math.max(0, at - anchor.prefix.length), at))
      const suffix = normalize(unit.text.slice(at + exact.length, at + exact.length + anchor.suffix.length))
      const score =
        (prefix === anchor.prefix ? 2 : 0) +
        (suffix === anchor.suffix ? 2 : 0) -
        Math.abs(at / Math.max(1, unit.text.length) - anchor.relative)
      if (!best || score > best.score) best = { at, score }
      from = at + 1
    }
    if (!best) return
    return quads(unit, model, best.at, exact.length)
  }

  if (anchor.kind === "block") {
    const found = findItem(model, anchor)
    if (!found) return
    const x0 = found.box.x + anchor.rect.x * found.box.w
    const y0 = found.box.y + anchor.rect.y * found.box.h
    const quad = quadFor(found.page, model, x0, x0 + anchor.rect.w * found.box.w, y0, y0 + anchor.rect.h * found.box.h)
    return quad ? [{ page: found.page, quads: [quad] }] : undefined
  }

  const page = model.pages.get(anchor.page)
  if (!page?.dl.page_width || !page.dl.page_height) return
  const quad = quadFor(
    anchor.page,
    model,
    anchor.rect.x * page.dl.page_width,
    (anchor.rect.x + anchor.rect.w) * page.dl.page_width,
    anchor.rect.y * page.dl.page_height,
    (anchor.rect.y + anchor.rect.h) * page.dl.page_height,
  )
  return quad ? [{ page: anchor.page, quads: [quad] }] : undefined
}

function isAnchor(value: unknown): value is Anchor {
  if (!value || typeof value !== "object") return false
  const kind = (value as { kind?: unknown }).kind
  return kind === "text" || kind === "block" || kind === "page"
}

function list(item: PdfAnnotation): Anchor[] {
  if (Array.isArray(item.anchors)) {
    const values = item.anchors.filter(isAnchor)
    if (values.length) return values
  }
  return isAnchor(item.anchor) ? [item.anchor] : []
}

function merge(lists: (PdfAnnotation["pages"] | undefined)[]): PdfAnnotation["pages"] {
  const pages = new Map<number, PdfAnnotation["pages"][number]["quads"]>()
  const seen = new Map<number, Set<string>>()
  for (const parts of lists) {
    for (const part of parts ?? []) {
      let keys = seen.get(part.page)
      if (!keys) {
        keys = new Set()
        seen.set(part.page, keys)
      }
      const quads = pages.get(part.page) ?? []
      for (const quad of part.quads) {
        const key = JSON.stringify(quad)
        if (keys.has(key)) continue
        keys.add(key)
        quads.push(quad)
      }
      pages.set(part.page, quads)
    }
  }
  return [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([page, quads]) => ({ page, quads }))
}

/** Re-anchor annotations on the current layout, dropping those whose target is gone. */
export function reproject(model: PreviewModel, annotations: readonly PdfAnnotation[]): PdfAnnotation[] {
  const all = index(rows(model))
  return annotations.flatMap((item) => {
    const anchors = list(item)
    if (anchors.length) {
      const projected = anchors.map((anchor) => project(model, anchor))
      if (projected.some((pages) => !pages?.length)) return []
      return [{ ...item, anchors, pages: merge(projected) }]
    }

    const needle = normalize(item.selectedText)
    if (!needle) {
      const next = anchorsFor(model, item)
      const pages = merge(next.map((anchor) => project(model, anchor)))
      return pages.length ? [{ ...item, anchors: next, pages }] : []
    }

    const found = find(all, needle, oldPosition(model, item))
    if (!found) return []
    const pages = quads(all, model, found.at, needle.length)
    if (!pages.length) return []
    const next = textAnchors(model, item, needle)
    return [{ ...item, ...(next.length ? { anchors: next } : {}), pages }]
  })
}

/** Block boxes on a page, for the viewer's automatic block selection. */
export function pageBlocks(model: PreviewModel, page: number) {
  const value = model.pages.get(page)
  if (!value) return []
  const out: { kind: "image" | "picture" | "rule"; quad: PdfAnnotation["pages"][number]["quads"][number] }[] = []
  const add = (entry: Entry) => {
    const box = entry.box
    const quad = quadFor(page, model, box.x, box.x + box.w, box.y, box.y + box.h)
    if (quad) out.push({ kind: entry.kind, quad })
  }
  for (const line of value.dl.lines) for (const entry of entries(value.dl, line.items)) add(entry)
  for (const entry of entries(value.dl, value.dl.other)) add(entry)
  const seen = new Set<string>()
  return out.filter((item) => {
    const key = JSON.stringify(item.quad)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Whether two annotation lists are the same as far as persistence is concerned. */
export function same(annotations: readonly PdfAnnotation[], other: readonly PdfAnnotation[]) {
  if (annotations.length !== other.length) return false
  const shape = (item: PdfAnnotation) =>
    JSON.stringify([
      item.id,
      item.type,
      item.color,
      item.pages,
      item.selectedText,
      item.note,
      item.createdAt,
      item.updatedAt,
      item.anchor,
      item.anchors,
    ])
  return annotations.every((item, index) => shape(item) === shape(other[index]))
}
