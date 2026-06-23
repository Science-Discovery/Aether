import path from "path"
import fs from "fs/promises"
import { createHash } from "crypto"
import { PDFDocument, PDFHexString } from "pdf-lib"
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

  export async function exportPdf(input: string) {
    const abs = resolve(input)
    const stored = await read(abs)
    if (stored.status === "stale") throw new Error("PDF changed after annotations were created")
    const pdf = await PDFDocument.load(await Bun.file(abs).arrayBuffer())
    for (const item of stored.data.annotations) {
      for (const page of item.pages) {
        if (page.page > pdf.getPageCount()) continue
        const target = pdf.getPage(page.page - 1)
        if (!target) continue
        const points = page.quads.flat()
        const xs = points.filter((_, index) => index % 2 === 0)
        const ys = points.filter((_, index) => index % 2 === 1)
        const color = item.type === "note" ? colors.yellow : colors[item.color]
        const annot = pdf.context.obj({
          Type: "Annot",
          Subtype:
            item.type === "underline" ? "Underline" : item.type === "strikeout" ? "StrikeOut" : "Highlight",
          Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          QuadPoints: points,
          C: [...color],
          CA: item.type === "note" ? 0.22 : 0.45,
          F: 4,
          NM: PDFHexString.fromText(`${item.id}:${page.page}`),
          T: PDFHexString.fromText("Aether"),
          Subj: PDFHexString.fromText(item.type === "note" ? "Note" : item.type),
          Contents: PDFHexString.fromText(item.note),
          M: PDFHexString.fromText(date(item.updatedAt)),
        })
        target.node.addAnnot(pdf.context.register(annot))
      }
    }
    return pdf.save()
  }
}
