import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Latex } from "../../src/latex"
import type { PdfAnnotations } from "../../src/pdf-annotations"
import { tmpdir } from "../fixture/fixture"

const item: PdfAnnotations.Item = {
  id: "one",
  type: "highlight",
  color: "yellow",
  pages: [{ page: 1, quads: [[1, 2, 3, 2, 1, 4, 3, 4]] }],
  selectedText: "Hello",
  note: "",
  createdAt: 1,
  updatedAt: 1,
  anchor: { kind: "page", page: 1, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } },
  anchors: [{ kind: "page", page: 1, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }],
}

const file = (): PdfAnnotations.File => ({
  version: "1.2",
  source: { path: "stale", fingerprint: "stale" },
  annotations: [item],
})

describe("realtime annotations", () => {
  test("stores annotations per project document and detects stale writes", async () => {
    await using dir = await tmpdir()
    await Bun.write(
      path.join(dir.path, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
    )
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const empty = await Latex.realtimeAnnotations({ root: ".", main: "main.tex" })
        expect(empty.data.annotations).toEqual([])
        expect(empty.revision).toBe("0")
        const saved = await Latex.saveRealtimeAnnotations({
          root: ".",
          main: "main.tex",
          data: file(),
          revision: empty.revision,
        })
        expect(saved.data.source.path).toStartWith("realtime:")
        expect(saved.data.annotations).toEqual([item])
        const read = await Latex.realtimeAnnotations({ root: ".", main: "main.tex" })
        expect(read).toEqual(saved)
        await expect(
          Latex.saveRealtimeAnnotations({ root: ".", main: "main.tex", data: file(), revision: "0" }),
        ).rejects.toThrow("changed")
        await Instance.dispose()
      },
    })
  })
})
