// Adapted from realtime-tex-vsc-plugin (MIT; see LICENSE in this directory).
// Drawing rtex display lists (docs/DISPLAY_LIST.md, "Rendering rules") on a 2D canvas.
import * as opentype from "opentype.js"
import { fontKey, FontResource, ImageResource } from "./fontKey"
import type { DisplayList, FontDesc, ImageInfo, Item, Line } from "./protocol"

/** Affine map [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat = [number, number, number, number, number, number]
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/** CSS color of the fill (else stroke) operator in a PDF color string ("1 0 0 rg 1 0 0 RG"). */
export function pdfColor(data: string): string | undefined {
  const t = data.trim().split(/\s+/)
  let fill: string | undefined
  let stroke: string | undefined
  for (let i = 0; i < t.length; i++) {
    const op = t[i]
    const n = (k: number) => t.slice(i - k, i).map(Number)
    let css: string | undefined
    if ((op === "g" || op === "G") && i >= 1) {
      const [v] = n(1)
      css = rgb(v, v, v)
    } else if ((op === "rg" || op === "RG") && i >= 3) {
      const [r, g, b] = n(3)
      css = rgb(r, g, b)
    } else if ((op === "k" || op === "K") && i >= 4) {
      const [c, m, y, k] = n(4)
      css = rgb((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
    } else continue
    if (op === op.toLowerCase()) fill ??= css
    else stroke ??= css
  }
  return fill ?? stroke
}

function rgb(r: number, g: number, b: number): string | undefined {
  if (![r, g, b].every((v) => Number.isFinite(v))) return undefined
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255)
  return `rgb(${c(r)},${c(g)},${c(b)})`
}

type LoadedFont =
  | { kind: "sfnt"; upem: number; font: opentype.Font; paths: Map<number, Path2D | null> }
  | {
      kind: "type1"
      upem: number
      src: Record<number, string>
      paths: Map<number, Path2D | null>
      slant?: number
      extend?: number
    }
  | { kind: "missing"; reason: string }

export class FontStore {
  private fonts = new Map<string, LoadedFont>()

  has(key: string): boolean {
    return this.fonts.has(key)
  }

  add(key: string, res: FontResource): void {
    if (res.kind === "sfnt") {
      try {
        const data = res.data
        const font = opentype.parse(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        )
        this.fonts.set(key, { kind: "sfnt", upem: font.unitsPerEm || 1000, font, paths: new Map() })
      } catch (e) {
        this.fonts.set(key, { kind: "missing", reason: `cannot parse font: ${(e as Error).message}` })
      }
    } else if (res.kind === "type1") {
      this.fonts.set(key, {
        kind: "type1",
        upem: res.upem,
        src: res.glyphs,
        paths: new Map(),
        slant: res.slant,
        extend: res.extend,
      })
    } else {
      this.fonts.set(key, res)
    }
  }

  get(desc: FontDesc): LoadedFont | undefined {
    return this.fonts.get(fontKey(desc))
  }

  /** Outline of a glyph in font units (y up), or null when the font lacks it. */
  glyph(f: LoadedFont, index: number | null, char: number): Path2D | null {
    if (f.kind === "missing") return null
    const id = f.kind === "sfnt" ? index : char
    if (id === null || id === undefined) return null
    let p = f.paths.get(id)
    if (p !== undefined) return p
    p = null
    if (f.kind === "sfnt") {
      const g = id < f.font.numGlyphs ? f.font.glyphs.get(id) : undefined
      if (g) {
        p = new Path2D()
        for (const c of g.path.commands) {
          if (c.type === "M") p.moveTo(c.x!, c.y!)
          else if (c.type === "L") p.lineTo(c.x!, c.y!)
          else if (c.type === "C") p.bezierCurveTo(c.x1!, c.y1!, c.x2!, c.y2!, c.x!, c.y!)
          else if (c.type === "Q") p.quadraticCurveTo(c.x1!, c.y1!, c.x!, c.y!)
          else if (c.type === "Z") p.closePath()
        }
      }
    } else if (f.src[id] !== undefined) {
      p = new Path2D(f.src[id])
    }
    f.paths.set(id, p)
    return p
  }
}

export type LoadedImage =
  | { kind: "bitmap"; image: CanvasImageSource }
  | { kind: "pending" }
  | { kind: "missing"; reason: string }

export class ImageStore {
  private images = new Map<string, LoadedImage>()
  onLoaded: () => void = () => undefined

  constructor(private readonly renderPdfImage: (data: Uint8Array, page: number) => Promise<CanvasImageSource>) {}

  has(file: string): boolean {
    return this.images.has(file)
  }

  get(file: string): LoadedImage | undefined {
    return this.images.get(file)
  }

  add(file: string, res: ImageResource, page = 1): void {
    if (res.kind === "missing") {
      this.images.set(file, res)
      return
    }
    this.images.set(file, { kind: "pending" })
    const done = (image: CanvasImageSource) => {
      this.images.set(file, { kind: "bitmap", image })
      this.onLoaded()
    }
    const fail = (e: unknown) => {
      this.images.set(file, { kind: "missing", reason: String(e) })
      this.onLoaded()
    }
    if (res.kind === "pdf") this.renderPdfImage(res.data, page).then(done, fail)
    else createImageBitmap(new Blob([res.data as BlobPart], { type: res.mime })).then(done, fail)
  }
}

/** The image an IMAGE item refers to. Items carry LuaTeX's image index (1, 2, … in creation
 * order) while rtex keys `images_info` by \lastsavedimageresourceindex (an object number); when
 * the key does not match, map by rank: both grow in creation order. */
export function imageInfo(dl: DisplayList, index: number): ImageInfo | undefined {
  const infos = dl.images_info
  if (!infos) return undefined
  const direct = infos[String(index)]
  if (direct) return direct
  // cached pictures are not LuaTeX images: leave them out of the ranking
  const sorted = Object.keys(infos)
    .filter((k) => !infos[k].cached_picture)
    .map(Number)
    .sort((a, b) => a - b)
  const key = sorted[index - 1]
  return key === undefined ? undefined : infos[String(key)]
}

/** Why a display list cannot be drawn exactly (undefined when it can). */
export function inexactReason(
  dl: DisplayList,
  fonts: FontStore,
  images: ImageStore,
  lines?: Iterable<Line>,
): string | undefined {
  const flags = dl.flags && typeof dl.flags === "object" ? Object.keys(dl.flags as object) : []
  if (flags.length && !Array.isArray(dl.flags))
    return `contains material the live renderer cannot draw (${flags.join(", ")})`
  const check = (items: Item[]): string | undefined => {
    for (const it of items) {
      if (it[0] === "g") {
        const desc = dl.fonts[String(it[1])]
        const f = desc && fonts.get(desc)
        if (!f) return "fonts are loading"
        if (f.kind === "missing") return f.reason
        if (!fonts.glyph(f, it[3] as number | null, it[2] as number))
          return `a glyph is missing from ${desc.psname ?? desc.name ?? "a font"}`
      } else if (it[0] === "i") {
        const info = imageInfo(dl, it[1] as number)
        const im = info && images.get(info.file)
        if (!info) return "an image has no source file"
        if (!im || im.kind === "pending") return "images are loading"
        if (im.kind === "missing") return im.reason
      } else if (it[0] === "l" || it[0] === "u") {
        return "contains drawing commands (e.g. TikZ) the live renderer cannot draw"
      }
    }
    return undefined
  }
  const r = check(dl.other ?? [])
  if (r) return r
  for (const line of lines ?? dl.lines) {
    const lr = check(line.items)
    if (lr) return lr
  }
  return undefined
}

/** Draws display-list items onto a canvas whose base transform maps sp to device pixels. */
export class Painter {
  private stacks = new Map<number, string[]>()
  private color = "rgb(0,0,0)"
  private mstack: Mat[] = []
  private cur: Mat = IDENTITY

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly base: Mat,
    private readonly fonts: FontStore,
    private readonly images: ImageStore,
  ) {}

  /** Draw `items` of `dl` translated by (dx, dy) sp. */
  draw(dl: DisplayList, items: readonly Item[], dx = 0, dy = 0): void {
    const ctx = this.ctx
    for (const it of items) {
      switch (it[0]) {
        case "g": {
          const [, font, char, index, x, y, , ef] = it as [
            string,
            number,
            number,
            number | null,
            number,
            number,
            number,
            number,
          ]
          const desc = dl.fonts[String(font)]
          if (!desc) break
          const size = desc.size ?? 655360
          const f = this.fonts.get(desc)
          const path = f ? this.fonts.glyph(f, index, char) : null
          ctx.fillStyle = this.color
          if (!f || f.kind === "missing" || !path) {
            // approximate: the character in a generic font
            if (char > 32) {
              const m = mul(mul(this.base, this.cur), [size / 100, 0, 0, size / 100, x + dx, y + dy])
              ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
              ctx.font = "100px serif"
              ctx.fillText(String.fromCodePoint(char), 0, 0)
            }
            break
          }
          const s = size / f.upem
          const extendRaw = desc.extend ?? 0
          let hx = (1 + (ef ?? 0) / 1_000_000) * (extendRaw ? extendRaw / 1000 : 1)
          let slant = (desc.slant ?? 0) / 1000
          if (f.kind === "type1") {
            if (f.extend) hx *= f.extend
            if (f.slant && !slant) slant = f.slant
          }
          const m = mul(mul(this.base, this.cur), [s * hx, 0, s * slant, -s, x + dx, y + dy])
          ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
          ctx.fill(path)
          break
        }
        case "r": {
          const [, x, yTop, w, h] = it as [string, number, number, number, number]
          const m = mul(this.base, this.cur)
          ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
          ctx.fillStyle = this.color
          // keep hairlines visible: at least 0.75 device px
          const minW = 0.75 / Math.hypot(m[0], m[1])
          const minH = 0.75 / Math.hypot(m[2], m[3])
          ctx.fillRect(x + dx, yTop + dy, Math.max(w, minW), Math.max(h, minH))
          break
        }
        case "c": {
          const [, stackId, cmd, data] = it as [string, number, number | null, string]
          this.colorOp(stackId ?? 0, cmd, data ?? "")
          break
        }
        case "i": {
          const [, index, x, yTop, w, h] = it as [string, number, number, number, number, number]
          const info = imageInfo(dl, index)
          const im = info && this.images.get(info.file)
          const m = mul(this.base, this.cur)
          ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
          if (im?.kind === "bitmap") ctx.drawImage(im.image, x + dx, yTop + dy, w, h)
          else {
            ctx.fillStyle = "rgba(128,128,128,0.15)"
            ctx.fillRect(x + dx, yTop + dy, w, h)
          }
          break
        }
        case "M": {
          const [, op, x, y, data] = it as [string, string, number, number, string]
          if (op === "save") this.mstack.push(this.cur)
          else if (op === "restore") this.cur = this.mstack.pop() ?? IDENTITY
          else {
            const v = (data ?? "").trim().split(/\s+/).map(Number)
            if (v.length === 4 && v.every(Number.isFinite)) {
              // PDF matrices are y-up; display lists are y-down: conjugate by the flip
              const [a, b, c, d] = [v[0], -v[1], -v[2], v[3]]
              const px = x + dx
              const py = y + dy
              this.cur = mul(this.cur, [a, b, c, d, px - (a * px + c * py), py - (b * px + d * py)])
            }
          }
          break
        }
        default:
          break
      }
    }
  }

  /** Paint the boxes of `lines` (translated) with `fill`, enlarged by `pad` sp vertically (and
   * at least 1 pt horizontally). */
  clearLines(rows: { line: Line; dx: number; dy: number }[], fill: string, pad = 65536): void {
    const ctx = this.ctx
    const m = this.base
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
    ctx.fillStyle = fill
    const hpad = Math.max(pad, 65536)
    for (const { line, dx, dy } of rows) {
      ctx.fillRect(line.x + dx - hpad, line.y + dy - line.h - pad, line.w + 2 * hpad, line.h + line.d + 2 * pad)
    }
  }

  /** Fill rectangles [x0, y0, x1, y1] given in sp. */
  clearRects(rects: [number, number, number, number][], fill: string): void {
    const ctx = this.ctx
    const m = this.base
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
    ctx.fillStyle = fill
    for (const [x0, y0, x1, y1] of rects) ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
  }

  private colorOp(stack: number, cmd: number | null, data: string): void {
    let st = this.stacks.get(stack)
    if (!st) this.stacks.set(stack, (st = []))
    // LuaTeX reports the colorstack command in `cmd` (0 set, 1 push, 2 pop, 3 current); when it
    // is absent, a non-empty data string is a push and an empty one a pop
    const op = typeof cmd === "number" && cmd <= 3 ? cmd : data.trim() ? 1 : 2
    if (op === 0) {
      if (st.length) st[st.length - 1] = data
      else st.push(data)
    } else if (op === 1) st.push(data)
    else if (op === 2) st.pop()
    else return
    const top = st[st.length - 1]
    this.color = (top && pdfColor(top)) ?? "rgb(0,0,0)"
  }
}
