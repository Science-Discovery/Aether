import path from "path"
import fs from "fs/promises"
import { createHash } from "crypto"
import { PDFDocument, PDFHexString, PDFName, PDFNumber } from "pdf-lib"
import z from "zod"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Hash } from "../util/hash"

const Quad = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
])

export namespace PdfAnnotations {
  export const Item = z.object({
    id: z.string().min(1).max(128),
    type: z.enum(["highlight", "underline", "strikeout", "note"]),
    color: z.enum(["yellow", "red", "green", "blue"]),
    pages: z
      .array(
        z.object({
          page: z.number().int().positive(),
          quads: z.array(Quad).min(1),
        }),
      )
      .min(1),
    selectedText: z.string().max(100_000),
    note: z.string().max(100_000),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  export type Item = z.infer<typeof Item>

  export const File = z.object({
    version: z.literal("1.2"),
    source: z.object({
      path: z.string(),
      fingerprint: z.string(),
    }),
    annotations: z.array(Item),
  })
  export type File = z.infer<typeof File>

  const root = () => path.join(Global.Path.data, "pdf-annotations", Instance.project.id)
  const key = (input: string) => Hash.fast(path.relative(Instance.directory, input).replaceAll("\\", "/"))
  const target = (input: string) => path.join(root(), `${key(input)}.json`)

  export function resolve(input: string) {
    const abs = path.resolve(path.isAbsolute(input) ? input : path.join(Instance.directory, input))
    if (!Instance.containsPath(abs)) throw new Error("Access denied: path escapes project directory")
    if (path.extname(abs).toLowerCase() !== ".pdf") throw new Error("Path must point to a PDF file")
    return abs
  }

  async function fingerprint(input: string) {
    const hash = createHash("sha256")
    const file = Bun.file(input)
    const reader = file.stream().getReader()
    while (true) {
      const part = await reader.read()
      if (part.done) break
      hash.update(part.value)
    }
    return hash.digest("hex")
  }

  async function parse(input: string) {
    return File.parse(await Bun.file(input).json())
  }

  async function migrate(abs: string, hash: string) {
    const dir = root()
    const rows = await fs.readdir(dir).catch(() => [])
    const files = await Promise.all(
      rows
        .filter((row) => row.endsWith(".json"))
        .map((row) =>
          parse(path.join(dir, row))
            .then(async (data) => ({
              row,
              data,
              exists: await fs
                .stat(path.resolve(Instance.directory, data.source.path))
                .then(() => true)
                .catch(() => false),
            }))
            .catch(() => undefined),
        ),
    )
    const found = files.find((entry) => {
      if (!entry || entry.data.source.fingerprint !== hash) return false
      return !entry.exists
    })
    if (!found) return
    found.data.source.path = path.relative(Instance.directory, abs).replaceAll("\\", "/")
    await write(abs, found.data)
    await fs.rm(path.join(dir, found.row), { force: true })
    return found.data
  }

  export async function read(input: string) {
    const abs = resolve(input)
    const hash = await fingerprint(abs)
    const file = target(abs)
    const data = await parse(file).catch(() => undefined)
    if (!data) {
      const moved = await migrate(abs, hash)
      if (moved) return { status: "ready" as const, data: moved }
      return {
        status: "ready" as const,
        data: {
          version: "1.2" as const,
          source: {
            path: path.relative(Instance.directory, abs).replaceAll("\\", "/"),
            fingerprint: hash,
          },
          annotations: [],
        },
      }
    }
    if (data.source.fingerprint !== hash) return { status: "stale" as const, data }
    return { status: "ready" as const, data }
  }

  export async function write(input: string, data: File) {
    const abs = resolve(input)
    const next = File.parse(data)
    next.source = {
      path: path.relative(Instance.directory, abs).replaceAll("\\", "/"),
      fingerprint: await fingerprint(abs),
    }
    await fs.mkdir(root(), { recursive: true })
    const file = target(abs)
    const tmp = `${file}.${crypto.randomUUID()}.tmp`
    await Bun.write(tmp, JSON.stringify(next, null, 2))
    await fs.rename(tmp, file)
    return next
  }

  const colors = {
    yellow: [1, 0.84, 0.2],
    red: [0.95, 0.25, 0.25],
    green: [0.2, 0.72, 0.36],
    blue: [0.2, 0.48, 0.95],
  } as const

  const date = (time: number) => {
    const value = new Date(time).toISOString().replaceAll(/[-:T]/g, "").slice(0, 14)
    return `D:${value}Z`
  }

  const number = (value: number) => PDFNumber.of(value).toString()

  function bounds(quads: number[][]) {
    return quads
      .flatMap((quad) => [0, 2, 4, 6].map((index) => [quad[index], quad[index + 1]]))
      .reduce(
        (box, point) => [
          Math.min(box[0], point[0]),
          Math.min(box[1], point[1]),
          Math.max(box[2], point[0]),
          Math.max(box[3], point[1]),
        ],
        [Infinity, Infinity, -Infinity, -Infinity],
      )
  }

  function appearance(
    pdf: PDFDocument,
    box: number[],
    color: readonly number[],
    opacity: number,
    commands: string[],
    multiply = false,
  ) {
    return pdf.context.register(
      pdf.context.flateStream(
        [
          "q",
          "/GS gs",
          `${color.map(number).join(" ")} rg`,
          `${color.map(number).join(" ")} RG`,
          ...commands,
          "Q",
        ].join("\n"),
        {
          Type: "XObject",
          Subtype: "Form",
          FormType: 1,
          BBox: box,
          Resources: {
            ExtGState: { GS: { Type: "ExtGState", CA: opacity, ca: opacity, BM: multiply ? "Multiply" : "Normal" } },
          },
        },
      ),
    )
  }

  function position(box: number[], quads: number[][], rotation: number, occupied: number[][]) {
    const width = rotation % 180 ? box[3] - box[1] : box[2] - box[0]
    const height = rotation % 180 ? box[2] - box[0] : box[3] - box[1]
    const size = Math.min(20, width, height)
    const view = (x: number, y: number) => {
      if (rotation === 90) return [y - box[1], x - box[0]]
      if (rotation === 180) return [box[2] - x, y - box[1]]
      if (rotation === 270) return [box[3] - y, box[2] - x]
      return [x - box[0], box[3] - y]
    }
    const points = quads.map((quad) => [0, 2, 4, 6].flatMap((index) => view(quad[index], quad[index + 1])))
    const area = bounds(points)
    const first = bounds([points[0]])
    const xs = [area[2] + 3, area[0] - size - 3, first[0], 0, width - size]
    const ys = [
      first[1],
      area[1] - size - 3,
      area[3] + 3,
      0,
      height - size,
      ...occupied.flatMap((rect) => [rect[1], rect[3] + 3, rect[1] - size - 3]),
    ]
    const candidates = xs
      .flatMap((x) => ys.map((y) => [x, y, x + size, y + size]))
      .filter((rect) => rect[0] >= 0 && rect[1] >= 0 && rect[2] <= width && rect[3] <= height)
    const overlap = (rect: number[]) =>
      [area, ...occupied].reduce(
        (sum, part) =>
          sum +
          Math.max(0, Math.min(rect[2], part[2]) - Math.max(rect[0], part[0])) *
            Math.max(0, Math.min(rect[3], part[3]) - Math.max(rect[1], part[1])),
        0,
      )
    // Prefer space outside the whole selection, including longer subsequent lines.
    // A completely covered page has no empty spot: keep the marker in bounds.
    const rect =
      candidates.find((rect) => !overlap(rect)) ??
      candidates.reduce((best, rect) => (overlap(rect) < overlap(best) ? rect : best))
    const anchor =
      rotation === 90
        ? [box[0] + rect[1], box[1] + rect[0]]
        : rotation === 180
          ? [box[2] - rect[0], box[1] + rect[1]]
          : rotation === 270
            ? [box[2] - rect[1], box[3] - rect[0]]
            : [box[0] + rect[0], box[3] - rect[1]]
    occupied.push(rect)
    // NoRotate Text annotations pivot around Rect's PDF upper-left corner.
    return [anchor[0], anchor[1] - size, anchor[0] + size, anchor[1]]
  }

  export async function exportPdf(input: string) {
    const abs = resolve(input)
    const stored = await read(abs)
    if (stored.status === "stale") throw new Error("PDF changed after annotations were created")
    const pdf = await PDFDocument.load(await Bun.file(abs).arrayBuffer())
    const occupied = new Map<number, number[][]>()
    for (const item of stored.data.annotations) {
      const pages = item.pages.flatMap((page) => {
        if (page.page > pdf.getPageCount()) return []
        const target = pdf.getPage(page.page - 1)
        const crop = target.getCropBox()
        const media = target.getMediaBox()
        const box = [
          Math.max(crop.x, media.x),
          Math.max(crop.y, media.y),
          Math.min(crop.x + crop.width, media.x + media.width),
          Math.min(crop.y + crop.height, media.y + media.height),
        ]
        const quads = page.quads.filter((quad) => {
          const rect = bounds([quad])
          return (
            Math.abs((quad[2] - quad[0]) * (quad[5] - quad[1]) - (quad[3] - quad[1]) * (quad[4] - quad[0])) > 0 &&
            rect[2] > box[0] &&
            rect[0] < box[2] &&
            rect[3] > box[1] &&
            rect[1] < box[3]
          )
        })
        if (!quads.length || box[2] <= box[0] || box[3] <= box[1]) return []
        return [{ target, box, quads, page: page.page }]
      })
      for (const page of pages) {
        const color = colors[item.color]
        const fill = item.type === "highlight" || item.type === "note"
        const rect = bounds(page.quads).map((value, index) => value + (fill ? 0 : index < 2 ? -0.5 : 0.5))
        const opacity = item.type === "note" ? 0.22 : 0.45
        const commands = page.quads.flatMap((quad) => {
          if (fill)
            return [
              `${number(quad[0])} ${number(quad[1])} m ${number(quad[2])} ${number(quad[3])} l ${number(quad[6])} ${number(quad[7])} l ${number(quad[4])} ${number(quad[5])} l h f`,
            ]
          const line =
            item.type === "underline" ? quad.slice(4) : [0, 1, 2, 3].map((index) => (quad[index] + quad[index + 4]) / 2)
          return [`1 w ${number(line[0])} ${number(line[1])} m ${number(line[2])} ${number(line[3])} l S`]
        })
        const annot = pdf.context.obj({
          Type: "Annot",
          Subtype: item.type === "underline" ? "Underline" : item.type === "strikeout" ? "StrikeOut" : "Highlight",
          P: page.target.ref,
          Rect: rect,
          QuadPoints: page.quads.flat(),
          C: [...color],
          CA: opacity,
          AP: { N: appearance(pdf, rect, color, opacity, commands, fill) },
          F: 4,
          NM: PDFHexString.fromText(`${item.id}:${page.page}`),
          ...(item.type === "note"
            ? {}
            : {
                T: PDFHexString.fromText("Aether"),
                Subj: PDFHexString.fromText(item.type),
                Contents: PDFHexString.fromText(item.note.replace(/\r\n|\n/g, "\r")),
              }),
          M: PDFHexString.fromText(date(item.updatedAt)),
        })
        page.target.node.addAnnot(pdf.context.register(annot))
        if (item.type !== "note" || page !== pages[0]) continue

        const rotation = ((page.target.getRotation().angle % 360) + 360) % 360
        const markers = occupied.get(page.page) ?? []
        occupied.set(page.page, markers)
        const location = position(page.box, page.quads, rotation, markers)
        const note = pdf.context.obj({
          Type: "Annot",
          Subtype: "Text",
          P: page.target.ref,
          Rect: location,
          Name: "Note",
          Open: false,
          F: 28,
          C: [...color],
          NM: PDFHexString.fromText(`${item.id}:note`),
          T: PDFHexString.fromText("Aether"),
          Subj: PDFHexString.fromText("Note"),
          Contents: PDFHexString.fromText(item.note.replace(/\r\n|\n/g, "\r")),
          CreationDate: PDFHexString.fromText(date(item.createdAt)),
          M: PDFHexString.fromText(date(item.updatedAt)),
          AP: {
            N: appearance(pdf, [0, 0, 20, 20], color, 1, [
              "0.2 0.2 0.2 RG 1 w 2 1 m 18 1 l 18 14 l 13 19 l 2 19 l h B",
              "13 19 m 13 14 l 18 14 l S 5 11 m 14 11 l S 5 7 m 13 7 l S",
            ]),
          },
        })
        const ref = pdf.context.register(note)
        const width = Math.min(240, page.box[2] - page.box[0])
        const height = Math.min(120, page.box[3] - page.box[1])
        const px = Math.max(page.box[0], Math.min(page.box[2] - width, location[2]))
        const py = Math.max(page.box[1], Math.min(page.box[3] - height, location[3] - height))
        const popup = pdf.context.register(
          pdf.context.obj({
            Type: "Annot",
            Subtype: "Popup",
            P: page.target.ref,
            Parent: ref,
            Rect: [px, py, px + width, py + height],
            Open: false,
          }),
        )
        note.set(PDFName.of("Popup"), popup)
        // PDFium stops at the first annotation Rect under the pointer, even when
        // that annotation has no popup. Keep notes ahead of large highlight boxes.
        page.target.node.Annots()?.insert(0, ref)
        page.target.node.addAnnot(popup)
      }
    }
    return pdf.save()
  }
}
