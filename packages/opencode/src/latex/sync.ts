// SyncTeX box parsing and nearest-box lookup adapted from LaTeX Workshop.
// Upstream: d95c5d716e8564c2cb2787902994cf6714f6e852
// See SYNCTEX-LICENSE for the upstream MIT notices and source links.
import fs from "node:fs/promises"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import z from "zod"
import { LatexProject } from "./project"
import { LatexSchema } from "./schema"

export namespace LatexSync {
  export const limit = 32 * 1024 * 1024
  const maximum = 200_000
  const point = z.number().finite().min(-1_000_000).max(1_000_000)
  const rectangle = z.tuple([point, point, point, point])
  const page = z.object({ x: point, y: point, width: point.positive(), height: point.positive() })
  const node = z.object({
    path: z.string().max(4096),
    line: z.number().int().positive(),
    column: z.number().int().positive().optional(),
    page: z.number().int().positive(),
    rect: rectangle,
    box: z.boolean().optional(),
  })
  export const Index = z.object({
    version: z.literal(1),
    owner: z.string(),
    key: z.string(),
    build: z.string().uuid(),
    sourceRevision: z.string(),
    pdfHash: z.string(),
    pages: page.array().min(1).max(10_000),
    nodes: node.array().min(1).max(maximum),
  })
  export type Index = z.infer<typeof Index>
  type Page = z.infer<typeof page>
  type Box = {
    kind: string
    tag: number
    line: number
    column?: number
    left: number
    bottom: number
    width: number
    height: number
    depth: number
    cursor: number
    count: number
    nested: boolean
  }
  type Node = {
    tag: number
    line: number
    column?: number
    page: number
    rect: [number, number, number, number]
    box?: boolean
  }
  const identity = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
  const invalid = () => new Error("The SyncTeX mapping is malformed or uses an unsupported format.")

  export async function read(file: string, compressed = false) {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (compressed ? 8 * 1024 * 1024 : limit))
      throw new Error("The SyncTeX mapping exceeds its supported size or is not a regular file.")
    const bytes = await fs.readFile(file)
    if (bytes.length !== stat.size) throw invalid()
    const data = compressed ? gunzipSync(bytes, { maxOutputLength: limit }) : bytes
    return new TextDecoder("utf-8", { fatal: true }).decode(data)
  }

  export async function collect(input: {
    output: string
    source: string
    main: string
    files: string[]
    pages: Page[]
  }) {
    const name = path.join(input.output, `${path.parse(input.main).name}.synctex`)
    const plain = await fs.lstat(name).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return
      throw err
    })
    const text = await read(plain ? name : `${name}.gz`, !plain)
    return parse(text, input)
  }

  export function parse(text: string, input: { source: string; main: string; files: string[]; pages: Page[] }) {
    if (Buffer.byteLength(text) > limit) throw invalid()
    const lines = text.replaceAll("\r\n", "\n").split("\n")
    if (lines.length > 1_000_000 || lines[0] !== "SyncTeX Version:1") throw invalid()
    const files = new Map<number, string>()
    const inputs = new Map<number, string>()
    const known = new Map(input.files.map((file) => [identity(path.resolve(input.source, file)), file]))
    const nodes: Node[] = []
    const stack: Box[] = []
    const sheets = new Set<number>()
    const state = { section: "header", page: 0, vertical: 0, unit: 0, magnification: 0, x: NaN, y: NaN, count: false }
    const number = (value: string) => {
      if (!/^-?\d+$/.test(value)) throw invalid()
      const result = Number(value)
      if (!Number.isSafeInteger(result) || Math.abs(result) > 1e12) throw invalid()
      return result
    }
    const append = (
      item: Pick<Node, "tag" | "line" | "column">,
      left: number,
      bottom: number,
      width: number,
      height: number,
      depth: number,
      box = false,
    ) => {
      if (item.tag < 1 || item.line < 1 || height + depth <= 0 || width <= 0) return
      if (nodes.length >= maximum) throw new Error("The SyncTeX mapping contains too many positions.")
      const scale = (state.unit / 65781.76) * (state.magnification / 1000)
      const origin = input.pages[state.page - 1]
      const x = origin.x + left * scale + (state.x * state.unit) / 65781.76
      const y = origin.y + origin.height - bottom * scale - (state.y * state.unit) / 65781.76
      const edge = x + width * scale
      const top = y + height * scale
      const base = y - depth * scale
      nodes.push({
        tag: item.tag,
        line: item.line,
        ...(item.column ? { column: item.column } : {}),
        page: state.page,
        rect: [Math.min(x, edge), Math.min(base, top), Math.max(x, edge), Math.max(base, top)],
        ...(box ? { box: true } : {}),
      })
    }
    for (const line of lines.slice(1)) {
      if (!line || /^!\d+$/.test(line)) continue
      const source = line.match(/^Input:(\d+):(.*)$/)
      if (source) {
        if (inputs.size >= 10_000) throw invalid()
        const raw = source[2].replace(/^"(.*)"$/, "$1")
        if (raw.includes("\0") || raw.length > 4096) throw invalid()
        const tag = number(source[1])
        // Tectonic uses empty names for files loaded from its bundled resources.
        // They are valid input tags but can never be navigated as project files.
        if (!raw) {
          if (inputs.has(tag) && inputs.get(tag)) throw invalid()
          inputs.set(tag, "")
          continue
        }
        const full = path.resolve(path.dirname(path.join(input.source, input.main)), raw)
        if (inputs.has(tag) && inputs.get(tag) !== identity(full)) throw invalid()
        inputs.set(tag, identity(full))
        const rel = LatexProject.contains(input.source, full) ? known.get(identity(full)) : undefined
        if (rel) files.set(tag, rel)
        continue
      }
      if (line === "Content:") {
        if (
          state.section !== "header" ||
          state.unit <= 0 ||
          state.magnification <= 0 ||
          !Number.isFinite(state.x + state.y)
        )
          throw invalid()
        state.section = "content"
        continue
      }
      if (state.section === "header") {
        if (line === "Output:pdf") continue
        const header = line.match(/^(Magnification|Unit|X Offset|Y Offset):(-?\d+)$/)
        if (!header) throw invalid()
        const key = { Magnification: "magnification", Unit: "unit", "X Offset": "x", "Y Offset": "y" } as const
        state[key[header[1] as keyof typeof key]] = number(header[2])
        continue
      }
      if (line === "Postamble:") {
        if (state.section !== "content" || state.page || stack.length) throw invalid()
        state.section = "postamble"
        continue
      }
      if (line === "Post scriptum:" || line === "Post Scriptum:") {
        if (state.section !== "postamble" || !state.count) throw invalid()
        state.section = "postscript"
        continue
      }
      if (state.section === "postamble" && /^Count:\d+$/.test(line)) {
        state.count = true
        continue
      }
      // Postscript transforms and PDF forms need the complete native parser.
      // Refuse them rather than returning plausible but incorrect coordinates.
      if (state.section !== "content") throw invalid()
      const sheet = line.match(/^([{}])(\d+)$/)
      if (sheet) {
        const value = number(sheet[2])
        if (sheet[1] === "{") {
          if (state.page || stack.length || value < 1 || value > input.pages.length || sheets.has(value))
            throw invalid()
          state.page = value
          sheets.add(value)
          continue
        }
        if (state.page !== value || stack.length) throw invalid()
        state.page = 0
        continue
      }
      if (line === "]" || line === ")") {
        const box = stack.pop()
        if (!box || box.kind !== (line === "]" ? "[" : "(")) throw invalid()
        // Empty horizontal leaf boxes can contain an image or an unreported
        // text run. Never expose vertical/page containers as click targets.
        if (box.kind === "(" && !box.nested && box.count === nodes.length)
          append(box, box.left, box.bottom, box.width, box.height, box.depth, true)
        const parent = stack.at(-1)
        if (parent?.kind === "(") parent.cursor = Math.max(parent.cursor, box.left + box.width)
        continue
      }
      const record = line.match(
        /^([[(hvxgkr$])(\d+),(\d+)(?:,(\d+))?:(-?\d+),(-?\d+|=)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?$/,
      )
      if (!record || !state.page) throw invalid()
      const kind = record[1]
      const left = number(record[5])
      const bottom = record[6] === "=" ? state.vertical : number(record[6])
      if (record[6] !== "=") state.vertical = bottom
      const width = record[7] === undefined ? 0 : number(record[7])
      const height = record[8] === undefined ? (stack.at(-1)?.height ?? 0) : number(record[8])
      const depth = record[9] === undefined ? (stack.at(-1)?.depth ?? 0) : number(record[9])
      const item = {
        tag: number(record[2]),
        line: number(record[3]),
        ...(record[4] && number(record[4]) > 0 ? { column: number(record[4]) } : {}),
      }
      if ("[(hv".includes(kind) && record[9] === undefined) throw invalid()
      if (kind === "[" || kind === "(") {
        if (stack.length >= 256) throw invalid()
        const parent = stack.at(-1)
        if (parent) parent.nested = true
        stack.push({
          ...item,
          kind,
          left,
          bottom,
          width,
          height,
          depth,
          cursor: left,
          count: nodes.length,
          nested: false,
        })
        continue
      }
      const parent = stack.at(-1)
      if (!parent) throw invalid()
      if (kind === "r" || parent.kind !== "(") continue
      if (kind === "h" || kind === "v") {
        if (kind === "h") append(item, left, bottom, width, height, depth)
        parent.cursor = Math.max(parent.cursor, left + width)
        continue
      }
      // XeTeX emits CJK/ASCII text before a kern or glue endpoint rather
      // than individual glyph records. Exclude the kern itself (including
      // paragraph-filling glue) while retaining the preceding text span.
      const end = left - (kind === "k" ? width : 0)
      append(item, parent.cursor, bottom, end - parent.cursor, height, depth)
      parent.cursor = Math.max(parent.cursor, left)
    }
    if (!state.count || state.page || stack.length || !sheets.size) throw invalid()
    const mapped = nodes.flatMap((item) => {
      const file = files.get(item.tag)
      if (!file) return []
      const value = node.safeParse({
        path: file,
        line: item.line,
        column: item.column,
        page: item.page,
        rect: item.rect,
        box: item.box,
      })
      if (!value.success) throw invalid()
      return [value.data]
    })
    if (!mapped.length) throw new Error("No project source positions were found in the SyncTeX mapping.")
    return { pages: input.pages, nodes: mapped }
  }

  export function forward(index: Index, file: string, line: number) {
    const candidates = index.nodes.filter((item) => identity(item.path) === identity(file))
    if (!candidates.length) throw new LatexSchema.Error(404, "This source file has no position in the displayed PDF.")
    const closest = candidates.reduce((best, item) => {
      const distance = Math.abs(item.line - line) - Math.abs(best.line - line)
      return distance < 0 || (distance === 0 && item.line > best.line) ? item : best
    })
    const matches = candidates.filter((item) => item.line === closest.line && item.page === closest.page)
    const concrete = matches.filter((item) => !item.box)
    const ordered = (concrete.length ? concrete : matches).toSorted((a, b) => b.rect[3] - a.rect[3])
    const groups: { rect: [number, number, number, number]; width: number }[] = []
    for (const item of ordered) {
      const group = groups.find((group) => item.rect[3] >= group.rect[1] - 2 && item.rect[1] <= group.rect[3] + 2)
      if (!group) {
        groups.push({ rect: [...item.rect], width: item.rect[2] - item.rect[0] })
        continue
      }
      group.rect = [
        Math.min(group.rect[0], item.rect[0]),
        Math.min(group.rect[1], item.rect[1]),
        Math.max(group.rect[2], item.rect[2]),
        Math.max(group.rect[3], item.rect[3]),
      ]
      group.width += item.rect[2] - item.rect[0]
    }
    // A source line can occur in a heading, paragraph tail and running
    // header. Return one coherent line/block, never the whitespace between.
    const group = groups.reduce((best, item) => (item.width > best.width ? item : best))
    return {
      page: closest.page,
      rect: group.rect,
    }
  }

  export function inverse(index: Index, page: number, x: number, y: number) {
    const bounds = index.pages[page - 1]
    if (!bounds || x < bounds.x || y < bounds.y || x > bounds.x + bounds.width || y > bounds.y + bounds.height)
      throw new LatexSchema.Error(400, "The requested location is outside this PDF page.")
    const candidates = index.nodes.filter((item) => item.page === page)
    if (!candidates.length) throw new LatexSchema.Error(404, "This PDF page has no source position.")
    const distance = (item: Index["nodes"][number]) => {
      const dx = Math.max(item.rect[0] - x, 0, x - item.rect[2])
      const dy = Math.max(item.rect[1] - y, 0, y - item.rect[3])
      return dx * dx + dy * dy
    }
    const closest = candidates.reduce((best, item) => {
      const next = distance(item)
      const previous = distance(best)
      if (next !== previous) return next < previous ? item : best
      if (Boolean(item.box) !== Boolean(best.box)) return item.box ? best : item
      const area = (value: Index["nodes"][number]) => (value.rect[2] - value.rect[0]) * (value.rect[3] - value.rect[1])
      return area(item) < area(best) ? item : best
    })
    if (distance(closest) > 24 * 24)
      throw new LatexSchema.Error(404, "No matching source location was found near this PDF point.")
    return { path: closest.path, line: closest.line, ...(closest.column ? { column: closest.column } : {}) }
  }
}
