import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
  degrees,
} from "pdf-lib"
import { getDocumentProxy, getResolvedPDFJS } from "unpdf"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { PdfAnnotations } from "../../src/pdf-annotations"

const original = Global.Path.data

afterEach(async () => {
  ;(Global.Path as { data: string }).data = original
  await Instance.disposeAll()
  await resetDatabase()
})

async function pdf() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 400])
  const annot = doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: [5, 5, 15, 15], C: [0, 0, 0] })
  page.node.addAnnot(doc.context.register(annot))
  return doc.save()
}

const item = {
  id: "ann_1",
  type: "highlight" as const,
  color: "yellow" as const,
  pages: [{ page: 1, quads: [[20, 80, 120, 80, 20, 60, 120, 60] as const] }],
  selectedText: "selected text",
  note: "reader note",
  createdAt: 1,
  updatedAt: 2,
}

const items = [
  item,
  { ...item, id: "ann_2", type: "underline" as const, color: "blue" as const },
  { ...item, id: "ann_3", type: "strikeout" as const, color: "red" as const },
  { ...item, id: "ann_4", type: "note" as const, color: "green" as const, note: "hello你好\n第二行\r\nthird line" },
]

describe.serial("PDF annotations", () => {
  test("persists outside the session database and exports standard annotations", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "paper.pdf"), await pdf())
      },
    })
    await using data = await tmpdir()
    ;(Global.Path as { data: string }).data = data.path
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()
    const headers = { "x-opencode-directory": tmp.path, "Content-Type": "application/json" }

    const empty = await app.request(`/file/pdf-annotations?path=${encodeURIComponent("paper.pdf")}`, { headers })
    expect(empty.status).toBe(200)
    const initial = (await empty.json()) as { data: { source: { path: string; fingerprint: string } } }
    const saved = await app.request("/file/pdf-annotations", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        path: "paper.pdf",
        data: { version: "1.2", source: initial.data.source, annotations: items },
      }),
    })
    expect(saved.status).toBe(200)
    expect(
      await fs
        .stat(path.join(data.path, "aether.db"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false)

    const output = await app.request("/file/pdf-annotations/export", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "paper.pdf" }),
    })
    expect(output.status).toBe(200)
    expect(output.headers.get("Content-Disposition")).toContain("paper-annotated.pdf")
    const bytes = new Uint8Array(await output.arrayBuffer())
    const doc = await PDFDocument.load(bytes)
    const annots = doc.getPage(0).node.Annots()
    expect(annots?.size()).toBe(7)
    const types = annots
      ?.asArray()
      .map((_, index) => annots.lookup(index, PDFDict).lookup(PDFName.of("Subtype"), PDFName).toString())
    expect(types).toEqual(["/Text", "/Square", "/Highlight", "/Underline", "/StrikeOut", "/Highlight", "/Popup"])
    const note = annots!.lookup(0, PDFDict)
    const popup = annots!.lookup(6, PDFDict)
    expect(note.lookup(PDFName.of("Contents"), PDFHexString).decodeText()).toBe("hello你好\r第二行\rthird line")
    expect(
      note
        .lookup(PDFName.of("C"), PDFArray)
        .asArray()
        .map((value) => (value as PDFNumber).asNumber()),
    ).toEqual([0.2, 0.72, 0.36])
    expect(note.get(PDFName.of("Popup"))).toEqual(annots!.get(6))
    expect(popup.get(PDFName.of("Parent"))).toEqual(annots!.get(0))
    expect(popup.has(PDFName.of("AP"))).toBe(false)
    expect(annots!.lookup(5, PDFDict).has(PDFName.of("Contents"))).toBe(false)
    for (const index of [0, 2, 3, 4, 5]) {
      const stream = annots!.lookup(index, PDFDict).lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"))
      if (!(stream instanceof PDFRawStream)) throw new Error("Missing annotation appearance stream")
      expect(stream.dict.lookup(PDFName.of("Subtype"), PDFName).toString()).toBe("/Form")
      expect(new TextDecoder().decode(decodePDFRawStream(stream).decode())).toContain("/GS gs")
      expect(stream.dict.lookup(PDFName.of("Resources"), PDFDict).has(PDFName.of("ExtGState"))).toBe(true)
    }
    // Parse real appearance streams through a different PDF implementation.
    const viewer = await getDocumentProxy(bytes.slice(), { verbosity: 0 })
    try {
      const page = await viewer.getPage(1)
      const rows = await page.getAnnotations()
      const text = rows.find((row) => row.subtype === "Text")
      expect(text?.contentsObj.str).toBe("hello你好\r第二行\rthird line")
      expect(text?.hasAppearance).toBe(true)
      expect(text?.popupRef).toBeTruthy()
      const ops = await page.getOperatorList()
      const engine = await getResolvedPDFJS()
      expect(ops.fnArray.filter((op) => op === engine.OPS.beginAnnotation).length).toBeGreaterThanOrEqual(5)
    } finally {
      await viewer.destroy()
    }

    await fs.rename(path.join(tmp.path, "paper.pdf"), path.join(tmp.path, "renamed.pdf"))
    const moved = await app.request(`/file/pdf-annotations?path=${encodeURIComponent("renamed.pdf")}`, { headers })
    const migrated = (await moved.json()) as { status: string; data: { annotations: unknown[] } }
    expect(migrated.status).toBe("ready")
    expect(migrated.data.annotations).toHaveLength(4)
  })

  test.each([0, 90, 180, 270])("exports one native note across cropped pages at rotation %s", async (rotation) => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const doc = await PDFDocument.create()
        const page = doc.addPage([300, 400])
        page.setMediaBox(20, 30, 280, 360)
        page.setCropBox(40, 50, 220, 300)
        page.setRotation(degrees(rotation))
        doc.addPage([300, 400])
        await Bun.write(path.join(dir, "paper.pdf"), await doc.save())
      },
    })
    await using data = await tmpdir()
    ;(Global.Path as { data: string }).data = data.path
    const bytes = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = await PdfAnnotations.read("paper.pdf")
        await PdfAnnotations.write("paper.pdf", {
          ...file.data,
          annotations: [
            {
              ...items[3],
              pages: [
                { page: 99, quads: [[20, 80, 120, 80, 20, 60, 120, 60]] },
                { page: 2, quads: [[0, 0, 0, 0, 0, 0, 0, 0]] },
                {
                  page: 1,
                  quads: [
                    [225, 340, 255, 340, 225, 320, 255, 320],
                    [60, 110, 160, 110, 60, 90, 160, 90],
                  ],
                },
                { page: 2, quads: [[20, 80, 120, 80, 20, 60, 120, 60]] },
              ],
            },
          ],
        })
        return PdfAnnotations.exportPdf("paper.pdf")
      },
    })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPage(0).getCropBox()).toEqual({ x: 40, y: 50, width: 220, height: 300 })
    expect(doc.getPage(0).getRotation().angle).toBe(rotation)
    expect(doc.getPage(0).node.Annots()?.size()).toBe(3)
    expect(doc.getPage(1).node.Annots()?.size()).toBe(1)
    const viewer = await getDocumentProxy(bytes.slice(), { verbosity: 0 })
    try {
      const first = await viewer.getPage(1)
      const rows = await first.getAnnotations()
      const note = rows.find((row) => row.subtype === "Text")
      expect(note?.contentsObj.str).toBe("hello你好\r第二行\rthird line")
      expect(rows.filter((row) => row.subtype === "Text")).toHaveLength(1)
      expect(rows.find((row) => row.subtype === "Highlight")?.contentsObj.str).toBe("")
      const view = first.getViewport({ scale: 1 })
      const point = view.convertToViewportPoint(note!.rect[0], note!.rect[3])
      expect(point[0]).toBeGreaterThanOrEqual(0)
      expect(point[1]).toBeGreaterThanOrEqual(0)
      expect(point[0] + 20).toBeLessThanOrEqual(view.width)
      expect(point[1] + 20).toBeLessThanOrEqual(view.height)
      const second = await viewer.getPage(2)
      const more = await second.getAnnotations()
      expect(more.filter((row) => row.subtype === "Text" || row.subtype === "Popup")).toHaveLength(0)
      expect(more.find((row) => row.subtype === "Highlight")?.contentsObj.str).toBe("")
      const engine = await getResolvedPDFJS()
      expect((await first.getOperatorList()).fnArray.filter((op) => op === engine.OPS.beginAnnotation)).toHaveLength(2)
      expect((await second.getOperatorList()).fnArray.filter((op) => op === engine.OPS.beginAnnotation)).toHaveLength(1)
    } finally {
      await viewer.destroy()
    }
  })

  test.each([0, 90, 180, 270])(
    "places multiline note icons before highlights and outside selections at rotation %s",
    async (rotation) => {
      const cases = [
        {
          size: [300, 400],
          crop: [40, 50, 220, 300],
          quads: [
            [70, 290, 125, 290, 70, 278, 125, 278],
            [60, 260, 235, 260, 60, 248, 235, 248],
            [60, 230, 190, 230, 60, 218, 190, 218],
          ],
        },
        {
          size: [90, 160],
          crop: [10, 15, 70, 130],
          quads: [
            [13, 100, 50, 100, 13, 88, 50, 88],
            [13, 80, 77, 80, 13, 68, 77, 68],
          ],
        },
        {
          size: [300, 400],
          crop: [40, 50, 220, 300],
          quads: [
            [245, 348, 259, 348, 245, 336, 259, 336],
            [60, 326, 259, 326, 60, 314, 259, 314],
          ],
        },
      ] as const
      await using tmp = await tmpdir({
        init: async (dir) => {
          const doc = await PDFDocument.create()
          for (const entry of cases) {
            const page = doc.addPage([...entry.size])
            page.setCropBox(entry.crop[0], entry.crop[1], entry.crop[2], entry.crop[3])
            page.setRotation(degrees(rotation))
            page.node.addAnnot(
              doc.context.register(
                doc.context.obj({
                  Type: "Annot",
                  Subtype: "Highlight",
                  Rect: [0, 0, ...entry.size],
                  QuadPoints: [0, entry.size[1], entry.size[0], entry.size[1], 0, 0, entry.size[0], 0],
                  Contents: PDFHexString.fromText("Original highlight"),
                  NM: PDFHexString.fromText("original"),
                  C: [1, 1, 0],
                }),
              ),
            )
          }
          await Bun.write(path.join(dir, "paper.pdf"), await doc.save())
        },
      })
      await using data = await tmpdir()
      ;(Global.Path as { data: string }).data = data.path
      const bytes = await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const file = await PdfAnnotations.read("paper.pdf")
          await PdfAnnotations.write("paper.pdf", {
            ...file.data,
            annotations: cases.flatMap((entry, page) =>
              [0, 1, 2].map((index) => ({
                ...items[3],
                id: `note-${page}-${index}`,
                pages: [{ page: page + 1, quads: entry.quads.map((quad) => [...quad]) }],
                note: `中文备注 ${page}-${index}\nEnglish note ${page}-${index}`,
              })),
            ),
          })
          return PdfAnnotations.exportPdf("paper.pdf")
        },
      })
      const doc = await PDFDocument.load(bytes)
      const viewer = await getDocumentProxy(bytes.slice(), { verbosity: 0 })
      try {
        for (const [index, entry] of cases.entries()) {
          const annots = doc.getPage(index).node.Annots()!
          const dictionaries = annots.asArray().map((_, offset) => annots.lookup(offset, PDFDict))
          expect(
            dictionaries.slice(0, 3).map((annot) => annot.lookup(PDFName.of("Subtype"), PDFName).toString()),
          ).toEqual(["/Text", "/Text", "/Text"])
          const original = dictionaries.find(
            (annot) => annot.lookupMaybe(PDFName.of("NM"), PDFHexString)?.decodeText() === "original",
          )!
          expect(dictionaries.indexOf(original)).toBeGreaterThanOrEqual(3)
          expect(original.lookup(PDFName.of("Contents"), PDFHexString).decodeText()).toBe("Original highlight")
          expect(
            original
              .lookup(PDFName.of("Rect"), PDFArray)
              .asArray()
              .map((value) => (value as PDFNumber).asNumber()),
          ).toEqual([0, 0, ...entry.size])
          for (const number of [0, 1, 2]) {
            expect(
              dictionaries.filter(
                (annot) =>
                  annot.lookupMaybe(PDFName.of("Contents"), PDFHexString)?.decodeText() ===
                  `中文备注 ${index}-${number}\rEnglish note ${index}-${number}`,
              ),
            ).toHaveLength(1)
          }
          const page = await viewer.getPage(index + 1)
          const rows = await page.getAnnotations()
          const notes = rows.filter((row) => row.subtype === "Text")
          expect(notes).toHaveLength(3)
          const view = page.getViewport({ scale: 1 })
          const highlight = dictionaries.find(
            (annot) =>
              annot.lookup(PDFName.of("Subtype"), PDFName).toString() === "/Highlight" &&
              !annot.has(PDFName.of("Contents")),
          )!
          expect(
            highlight
              .lookup(PDFName.of("QuadPoints"), PDFArray)
              .asArray()
              .map((value) => (value as PDFNumber).asNumber()),
          ).toEqual(entry.quads.flat())
          const points = entry.quads.flatMap((quad) =>
            [0, 2, 4, 6].map((offset) => view.convertToViewportPoint(quad[offset], quad[offset + 1])),
          )
          const selection = [
            Math.min(...points.map((point) => point[0])),
            Math.min(...points.map((point) => point[1])),
            Math.max(...points.map((point) => point[0])),
            Math.max(...points.map((point) => point[1])),
          ]
          const rectangles = notes.map((note) => {
            const point = view.convertToViewportPoint(note.rect[0], note.rect[3])
            return [point[0], point[1], point[0] + note.rect[2] - note.rect[0], point[1] + note.rect[3] - note.rect[1]]
          })
          for (const [number, rect] of rectangles.entries()) {
            expect(rect[0]).toBeGreaterThanOrEqual(0)
            expect(rect[1]).toBeGreaterThanOrEqual(0)
            expect(rect[2]).toBeLessThanOrEqual(view.width)
            expect(rect[3]).toBeLessThanOrEqual(view.height)
            expect(
              rect[2] <= selection[0] || rect[0] >= selection[2] || rect[3] <= selection[1] || rect[1] >= selection[3],
            ).toBe(true)
            for (const other of rectangles.slice(0, number)) {
              expect(rect[2] <= other[0] || rect[0] >= other[2] || rect[3] <= other[1] || rect[1] >= other[3]).toBe(
                true,
              )
            }
          }
        }
      } finally {
        await viewer.destroy()
      }
    },
  )

  test("rejects traversal and pauses drafts after the source changes", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "paper.pdf"), await pdf())
      },
    })
    await using data = await tmpdir()
    ;(Global.Path as { data: string }).data = data.path
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.Default()
    const headers = { "x-opencode-directory": tmp.path, "Content-Type": "application/json" }

    const escaped = await app.request(`/file/pdf-annotations?path=${encodeURIComponent("../paper.pdf")}`, { headers })
    expect(escaped.status).toBe(400)

    const empty = await app.request(`/file/pdf-annotations?path=${encodeURIComponent("paper.pdf")}`, { headers })
    const initial = (await empty.json()) as { data: { source: { path: string; fingerprint: string } } }
    await app.request("/file/pdf-annotations", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        path: "paper.pdf",
        data: { version: "1.2", source: initial.data.source, annotations: [item] },
      }),
    })
    const changed = await PDFDocument.create()
    changed.addPage([500, 500])
    await Bun.write(path.join(tmp.path, "paper.pdf"), await changed.save())

    const stale = await app.request(`/file/pdf-annotations?path=${encodeURIComponent("paper.pdf")}`, { headers })
    expect((await stale.json()) as { status: string }).toMatchObject({ status: "stale" })
    const output = await app.request("/file/pdf-annotations/export", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "paper.pdf" }),
    })
    expect(output.status).toBe(409)
  })
})
