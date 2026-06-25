import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { PDFDict, PDFDocument, PDFHexString, PDFName } from "pdf-lib"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

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
  { ...item, id: "ann_4", type: "note" as const, note: "hello你好" },
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
    expect(await fs.stat(path.join(data.path, "aether.db")).then(() => true).catch(() => false)).toBe(false)

    const output = await app.request("/file/pdf-annotations/export", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "paper.pdf" }),
    })
    expect(output.status).toBe(200)
    expect(output.headers.get("Content-Disposition")).toContain("paper-annotated.pdf")
    const doc = await PDFDocument.load(await output.arrayBuffer())
    const annots = doc.getPage(0).node.Annots()
    expect(annots?.size()).toBe(5)
    const types = annots?.asArray().map((_, index) =>
      annots.lookup(index, PDFDict).lookup(PDFName.of("Subtype"), PDFName).toString(),
    )
    expect(types).toEqual(["/Square", "/Highlight", "/Underline", "/StrikeOut", "/Highlight"])
    expect(annots?.lookup(4, PDFDict).lookup(PDFName.of("Contents"), PDFHexString).decodeText()).toBe("hello你好")

    await fs.rename(path.join(tmp.path, "paper.pdf"), path.join(tmp.path, "renamed.pdf"))
    const moved = await app.request(`/file/pdf-annotations?path=${encodeURIComponent("renamed.pdf")}`, { headers })
    const migrated = (await moved.json()) as { status: string; data: { annotations: unknown[] } }
    expect(migrated.status).toBe("ready")
    expect(migrated.data.annotations).toHaveLength(4)
  })

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
