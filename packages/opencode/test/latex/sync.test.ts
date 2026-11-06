import { describe, expect, test } from "bun:test"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { LatexSync } from "../../src/latex/sync"
import { tmpdir } from "../fixture/fixture"

const source = path.resolve("synctex-fixture")
const opts = {
  source,
  main: "document/main.tex",
  files: ["document/main.tex", "章节/part.tex"],
  pages: [
    { x: 20, y: 30, width: 600, height: 800 },
    { x: 0, y: 0, width: 600, height: 800 },
  ],
}
const text = (records = "h1,10:6578176,13156352:2631270,657818,131564") =>
  [
    "SyncTeX Version:1",
    "Input:1:../章节/part.tex",
    `Input:2:${path.resolve(source, "..", "outside.tex")}`,
    "Output:pdf",
    "Magnification:1000",
    "Unit:1",
    "X Offset:0",
    "Y Offset:0",
    "Content:",
    "{1",
    "[1,1:0,0:39469056,52625408,0",
    "(1,10:6578176,13156352:2631270,657818,131564",
    records,
    ")",
    "]",
    "}1",
    "Postamble:",
    "Count:9",
    "Post scriptum:",
    "",
  ].join("\n")
const index = (value: string): LatexSync.Index => ({
  version: 1,
  owner: "workspace",
  key: "project",
  build: crypto.randomUUID(),
  sourceRevision: "source",
  pdfHash: "pdf",
  ...LatexSync.parse(value, opts),
})

describe("SyncTeX source positions", () => {
  test("resolves nested Unicode source paths and converts top-left points to PDF MediaBox coordinates", () => {
    const value = index(text())
    const result = LatexSync.forward(value, "章节/part.tex", 10)
    expect(result.page).toBe(1)
    expect(result.rect[0]).toBeCloseTo(120, 4)
    expect(result.rect[1]).toBeCloseTo(628, 4)
    expect(result.rect[2]).toBeCloseTo(160, 4)
    expect(result.rect[3]).toBeCloseTo(640, 4)
    expect(LatexSync.inverse(value, 1, 140, 634)).toEqual({ path: "章节/part.tex", line: 10 })
    expect(LatexSync.forward(value, "章节/part.tex", 1)).toEqual(result)
    expect(LatexSync.forward(value, "章节/part.tex", 100)).toEqual(result)
  })

  test("handles columns, compressed coordinates, signed offsets, and header scale", () => {
    const value = index(
      text(["h1,10:6578176,13156352:2631270,657818,131564", "h1,11,3:19734528,=:2631270,657818,131564"].join("\n"))
        .replace("Magnification:1000", "Magnification:2000")
        .replace("X Offset:0", "X Offset:-657818"),
    )
    const first = LatexSync.forward(value, "章节/part.tex", 10)
    const second = LatexSync.forward(value, "章节/part.tex", 11)
    expect(first.rect[0]).toBeCloseTo(210, 4)
    expect(first.rect[1]).toBeCloseTo(426, 4)
    expect(second.rect[1]).toBeCloseTo(first.rect[1], 4)
    expect(LatexSync.inverse(value, 1, 615, 440)).toEqual({ path: "章节/part.tex", line: 11, column: 3 })
  })

  test("only maps actual snapshot inputs, rejects invalid pages and returns no matches for empty pages", () => {
    const value = index(text("h1,10:6578176,13156352:2631270,657818,0\nh2,20:19734528,13156352:2631270,657818,0"))
    expect(value.nodes).toHaveLength(1)
    expect(() => LatexSync.forward(value, "../outside.tex", 20)).toThrow("no position")
    expect(() => LatexSync.inverse(value, 2, 100, 100)).toThrow("no source position")
    expect(() => LatexSync.inverse(value, 1, -10, 100)).toThrow("outside")
    expect(() => LatexSync.inverse(value, 9, 100, 100)).toThrow("outside")
    expect(() => LatexSync.inverse(value, 1, 30, 100)).toThrow("No matching")
    expect(LatexSync.inverse(value, 1, 140, 650)).toEqual({ path: "章节/part.tex", line: 10 })
  })

  test("real Tectonic output accepts unnamed bundle inputs and late Unicode chapter inputs without conflating basenames", async () => {
    const value: LatexSync.Index = {
      version: 1,
      owner: "workspace",
      key: "project",
      build: crypto.randomUUID(),
      sourceRevision: "source",
      pdfHash: "pdf",
      ...LatexSync.parse(await Bun.file(path.join(import.meta.dir, "fixtures", "tectonic-0.17.synctex")).text(), {
        source,
        main: "document/main.tex",
        files: ["document/main.tex", "章节 空格/段落.tex", "appendix/段落.tex"],
        pages: [
          { x: 0, y: 0, width: 612, height: 792 },
          { x: 0, y: 0, width: 612, height: 792 },
        ],
      }),
    }
    expect(new Set(value.nodes.map((item) => item.path))).toEqual(
      new Set(["document/main.tex", "章节 空格/段落.tex", "appendix/段落.tex"]),
    )
    expect(LatexSync.forward(value, "章节 空格/段落.tex", 4).page).toBe(1)
    expect(LatexSync.forward(value, "appendix/段落.tex", 4).page).toBe(2)
    for (const line of [1, 2, 3]) {
      const result = LatexSync.forward(value, "章节 空格/段落.tex", line)
      expect(
        LatexSync.inverse(value, 1, (result.rect[0] + result.rect[2]) / 2, (result.rect[1] + result.rect[3]) / 2),
      ).toEqual({ path: "章节 空格/段落.tex", line })
      expect(result.rect[3] - result.rect[1]).toBeLessThan(30)
    }
    const paragraph = LatexSync.forward(value, "章节 空格/段落.tex", 2)
    expect(paragraph.rect[2] - paragraph.rect[0]).toBeGreaterThan(300)
    expect(LatexSync.inverse(value, 1, paragraph.rect[2] - 2, (paragraph.rect[1] + paragraph.rect[3]) / 2)).toEqual({
      path: "章节 空格/段落.tex",
      line: 2,
    })
    expect(() => LatexSync.inverse(value, 1, 5, 780)).toThrow("No matching")
  })

  test("real Tectonic unspaced ASCII and long words retain their full ink span, including overfull text", async () => {
    const value: LatexSync.Index = {
      version: 1,
      owner: "workspace",
      key: "project",
      build: crypto.randomUUID(),
      sourceRevision: "source",
      pdfHash: "pdf",
      ...LatexSync.parse(await Bun.file(path.join(import.meta.dir, "fixtures", "tectonic-ascii.synctex")).text(), {
        source,
        main: "ascii.tex",
        files: ["ascii.tex"],
        pages: [{ x: 0, y: 0, width: 612, height: 792 }],
      }),
    }
    // TeX tags these paragraphs with the following empty line. The second
    // query is equidistant from both paragraphs and must choose the next one.
    for (const [line, target] of [
      [3, 4],
      [5, 6],
      [7, 7],
    ]) {
      const result = LatexSync.forward(value, "ascii.tex", line)
      expect(LatexSync.inverse(value, 1, result.rect[2] - 1, (result.rect[1] + result.rect[3]) / 2)).toEqual({
        path: "ascii.tex",
        line: target,
      })
    }
    expect(LatexSync.forward(value, "ascii.tex", 3).rect[2]).toBeGreaterThan(500)
    expect(() => LatexSync.inverse(value, 1, 500, 400)).toThrow("No matching")
  })

  test("horizontal leaf boxes are a fallback, while separated occurrences never highlight the gap between them", () => {
    const leaf = index(text(""))
    expect(leaf.nodes).toHaveLength(1)
    expect(leaf.nodes[0].box).toBe(true)
    expect(LatexSync.inverse(leaf, 1, 140, 634)).toEqual({ path: "章节/part.tex", line: 10 })
    const value = index(
      text("h1,10:6578176,13156352:2631270,657818,131564\nh1,10:6578176,26312704:657818,657818,131564"),
    )
    const result = LatexSync.forward(value, "章节/part.tex", 10)
    expect(result.rect[3] - result.rect[1]).toBeLessThan(13)
    expect(
      LatexSync.inverse(value, 1, (result.rect[0] + result.rect[2]) / 2, (result.rect[1] + result.rect[3]) / 2),
    ).toEqual({ path: "章节/part.tex", line: 10 })
  })

  test("malformed, partial or unsupported mappings are rejected instead of returning misleading positions", () => {
    for (const value of [
      text().replace("SyncTeX Version:1", "SyncTeX Version:2"),
      text().replace("Postamble:\nCount:9", ""),
      text().replace("}1", "}2"),
      text().replace("Unit:1", "Unit:0"),
      text().replace("Post scriptum:", "Post scriptum:\nMagnification:2"),
      text().replace("h1,10:", "f1:"),
      text().replace("Content:", "Input:1:../different.tex\nContent:"),
      text().replace("h1,10:6578176", "h1,10:99999999999999999999999"),
    ])
      expect(() => LatexSync.parse(value, opts)).toThrow()
  })

  test("reads bounded gzip output and rejects malformed or expanded oversized input", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "main.synctex.gz")
    await Bun.write(file, gzipSync(text()))
    expect(await LatexSync.read(file, true)).toBe(text())
    await Bun.write(file, "not gzip")
    await expect(LatexSync.read(file, true)).rejects.toThrow()
    await Bun.write(file, gzipSync(Buffer.alloc(LatexSync.limit + 1, 32)))
    await expect(LatexSync.read(file, true)).rejects.toThrow()
  })
})
