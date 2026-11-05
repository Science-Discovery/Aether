import { describe, expect, test } from "bun:test"
import type { DisplayList, Item } from "./protocol"
import type { PdfAnnotation } from "../pdf-viewer-shell-official"
import { PreviewModel } from "./model"
import { pageBlocks, reproject, same } from "./annotations"

const page = 39158276
const height = 55380990
const SP_TO_BP = 72 / 72.27 / 65536

function quad(
  x: number,
  y: number,
  w: number,
  h: number,
): [number, number, number, number, number, number, number, number] {
  const upper = (height - y) * SP_TO_BP
  const lower = (height - y - h) * SP_TO_BP
  return [x * SP_TO_BP, upper, (x + w) * SP_TO_BP, upper, x * SP_TO_BP, lower, (x + w) * SP_TO_BP, lower]
}

function glyphs(text: string, x: number, y: number): Item[] {
  return [...text].map((char, index) => ["g", 1, char.codePointAt(0)!, 62, x + index * 500000, y, 500000, 0] as Item)
}

function list(text: string, x = 0, y = 1000000): DisplayList {
  return {
    kind: "page",
    fonts: { "1": { id: 1, size: 655360 } },
    lines: [
      {
        par: 1,
        x,
        y,
        w: text.length * 500000,
        h: 500000,
        d: 100000,
        items: glyphs(text, x, y),
      },
    ],
    other: [],
    flags: [],
    width: page,
    height,
    depth: 0,
    page: 1,
    page_width: page,
    page_height: height,
  }
}

function model(text: string, x = 0, y = 1000000) {
  const value = new PreviewModel()
  value.applyLayout({
    pages: [{ page: 1, exact: true, hash: 1, dl: list(text, x, y) }],
    pagesTotal: 1,
    placements: [],
    keepFromRevision: null,
  })
  return value
}

function block(x = 1000000, y = 2000000) {
  const value = list("", x, y)
  value.lines = [{ par: 1, x, y, w: 1000000, h: 500000, d: 0, items: [["r", x, y, 1000000, 500000]] }]
  const model = new PreviewModel()
  model.applyLayout({
    pages: [{ page: 1, exact: true, hash: 1, dl: value }],
    pagesTotal: 1,
    placements: [],
    keepFromRevision: null,
  })
  return model
}

const annotation = (text: string): PdfAnnotation => ({
  id: "one",
  type: "highlight",
  color: "yellow",
  pages: [{ page: 1, quads: [[0, 0, 1, 0, 0, 1, 1, 1]] }],
  selectedText: text,
  note: "",
  createdAt: 1,
  updatedAt: 1,
})

describe("live preview annotations", () => {
  test("finds the selected text and rebuilds its quads", () => {
    const [item] = reproject(model("Hello world"), [annotation("world")])
    expect(item).toBeDefined()
    expect(item.pages).toHaveLength(1)
    expect(item.pages[0].page).toBe(1)
    expect(item.pages[0].quads[0][0]).toBeGreaterThan(0)
  })

  test("anchors text to its unit and follows it across layouts", () => {
    const first = reproject(model("Hello world"), [annotation("world")])[0]
    expect(first).toBeDefined()
    expect(first.anchors).toMatchObject([{ kind: "text", parId: 1, exact: "world" }])
    const after = reproject(model("Hello world", 2000000), [first])[0]
    expect(after.pages[0].quads[0][0]).toBeGreaterThan(first.pages[0].quads[0][0])
    expect(reproject(model("Hello there"), [first])).toEqual([])
  })

  test("records one anchor per unit for a selection spanning paragraphs", () => {
    const value = list("Hello")
    value.lines = [
      { par: 1, unit: 1, x: 0, y: 1000000, w: 2500000, h: 500000, d: 100000, items: glyphs("Hello", 0, 1000000) },
      {
        par: 2,
        unit: 2,
        x: 0,
        y: 1600000,
        w: 2500000,
        h: 500000,
        d: 100000,
        items: glyphs("world", 0, 1600000),
      },
    ]
    const model = new PreviewModel()
    model.applyLayout({
      pages: [{ page: 1, exact: true, hash: 1, dl: value }],
      pagesTotal: 1,
      placements: [],
      keepFromRevision: null,
    })
    const item = { ...annotation("Hello world"), pages: [{ page: 1, quads: [quad(0, 700000, 500000, 2000000)] }] }
    const [first] = reproject(model, [item])
    expect(first.anchors).toMatchObject([
      { kind: "text", parId: 1, exact: "Hello" },
      { kind: "text", parId: 2, exact: "world" },
    ])
    expect(first.pages[0].quads.length).toBe(2)
    const broken = list("Hello")
    broken.lines = [
      { par: 1, unit: 1, x: 0, y: 1000000, w: 2500000, h: 500000, d: 100000, items: glyphs("Hello", 0, 1000000) },
    ]
    const partial = new PreviewModel()
    partial.applyLayout({
      pages: [{ page: 1, exact: true, hash: 1, dl: broken }],
      pagesTotal: 1,
      placements: [],
      keepFromRevision: null,
    })
    expect(reproject(partial, [first])).toEqual([])
  })

  test("anchors a region to the block under it and follows or drops that block", () => {
    const area = { x: 1000000, y: 2000000, w: 1000000, h: 500000 }
    const item = {
      ...annotation(""),
      type: "note" as const,
      pages: [{ page: 1, quads: [quad(area.x, area.y, area.w, area.h)] }],
    }
    const first = reproject(block(), [item])[0]
    expect(first).toBeDefined()
    expect(first.anchors).toMatchObject([{ kind: "block", item: { kind: "rule" } }])
    const after = reproject(block(3000000, 2000000), [first])[0]
    expect(after.pages[0].quads[0][0]).toBeGreaterThan(first.pages[0].quads[0][0])
    expect(reproject(model("Hello"), [first])).toEqual([])
  })

  test("keeps note-only annotations while their page exists", () => {
    const note = { ...annotation(""), type: "note" as const }
    expect(reproject(model("Hello"), [note])).toHaveLength(1)
    const empty = new PreviewModel()
    empty.applyLayout({ pages: [], pagesTotal: 0, placements: [], keepFromRevision: null })
    expect(reproject(empty, [note])).toEqual([])
  })

  test("compares persisted annotation files", () => {
    const one = annotation("Hello")
    expect(same([one], [{ ...one }])).toBe(true)
    expect(same([one], [{ ...one, note: "changed" }])).toBe(false)
    expect(same([one], [])).toBe(false)
  })
})

test("exposes image blocks for the viewer's automatic block selection", () => {
  const value = list("")
  value.lines = [
    {
      par: 1,
      unit: 1,
      x: 1000000,
      y: 2000000,
      w: 3000000,
      h: 1000000,
      d: 0,
      items: [["i", 1, 1000000, 2000000, 3000000, 1000000]],
    },
  ]
  const model = new PreviewModel()
  model.applyLayout({
    pages: [{ page: 1, exact: true, hash: 1, dl: value }],
    pagesTotal: 1,
    placements: [],
    keepFromRevision: null,
  })
  const blocks = pageBlocks(model, 1)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].kind).toBe("image")
  expect(blocks[0].quad[0]).toBeGreaterThan(0)
})

test("offers rules and page-sized blocks too", () => {
  const value = list("")
  value.lines = [
    {
      par: 1,
      unit: 1,
      x: 0,
      y: 0,
      w: page,
      h: height,
      d: 0,
      items: [["r", 0, 0, page, height]],
    },
  ]
  const model = new PreviewModel()
  model.applyLayout({
    pages: [{ page: 1, exact: true, hash: 1, dl: value }],
    pagesTotal: 1,
    placements: [],
    keepFromRevision: null,
  })
  expect(pageBlocks(model, 1)).toMatchObject([{ kind: "rule" }])
  value.lines[0].items = [["i", 1, 0, 0, page, height]]
  const image = new PreviewModel()
  image.applyLayout({
    pages: [{ page: 1, exact: true, hash: 1, dl: value }],
    pagesTotal: 1,
    placements: [],
    keepFromRevision: null,
  })
  expect(pageBlocks(image, 1)).toMatchObject([{ kind: "image" }])
})

test("applies an image's display-list transform before offering its block", () => {
  const value = list("")
  value.lines = [
    {
      par: 1,
      unit: 1,
      x: 1000000,
      y: 2000000,
      w: 0,
      h: 0,
      d: 0,
      items: [
        ["M", "save", 1000000, 2000000, ""],
        ["M", "set", 1000000, 2000000, ".5 0 0 .5"],
        ["i", 1, 1000000, -1000000, 2000000, 1000000],
        ["M", "restore", 1000000, 2000000, ""],
      ],
    },
  ]
  const model = new PreviewModel()
  model.applyLayout({
    pages: [{ page: 1, exact: true, hash: 1, dl: value }],
    pagesTotal: 1,
    placements: [],
    keepFromRevision: null,
  })
  const [block] = pageBlocks(model, 1)
  const toBp = 72 / 72.27 / 65536
  expect(block).toBeDefined()
  expect(block.quad[0]).toBeCloseTo(1000000 * toBp, 1)
  expect(block.quad[2]).toBeCloseTo(2000000 * toBp, 1)
  expect(block.quad[1]).toBeLessThan(height * toBp)
})
