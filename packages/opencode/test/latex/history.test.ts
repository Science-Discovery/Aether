import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { PDFDocument } from "pdf-lib"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { PdfAnnotations } from "../../src/pdf-annotations"
import { Latex } from "../../src/latex"
import { LatexProject } from "../../src/latex/project"
import { tmpdir } from "../fixture/fixture"

async function seed(count: number) {
  const root = await LatexProject.root()
  const binding = (await Latex.bind({ root: ".", main: "main.tex", driver: "auto", program: "auto" })).binding!
  const dir = path.join(Global.Path.data, "latex", root.owner)
  const pdf = await PDFDocument.create()
  pdf.addPage()
  const bytes = await pdf.save()
  const ids = Array.from({ length: count }, () => crypto.randomUUID())
  for (const [index, id] of ids.entries()) {
    await Bun.write(path.join(dir, "artifacts", `${id}.pdf`), bytes)
    await Bun.write(path.join(dir, "manifests", `${id}.json`), "{}")
    await Bun.write(path.join(dir, "sync", `${id}.json`), "{}")
    await Bun.write(
      path.join(dir, "builds", `${id}.json`),
      JSON.stringify({
        owner: root.owner,
        key: root.key,
        pdfHash: LatexProject.hash(bytes),
        pdfSize: bytes.length,
        build: {
          id,
          root: ".",
          main: "main.tex",
          bindingRevision: binding.revision,
          state: "succeeded",
          createdAt: Date.now() + index * 1000,
          completedAt: Date.now(),
          diagnostics: [],
          log: "",
          truncated: false,
          pdf: true,
        },
      }),
    )
  }
  await Bun.write(
    path.join(dir, "projects", `${root.key}.json`),
    JSON.stringify({
      owner: root.owner,
      key: root.key,
      binding,
      latest: ids.at(-1),
      lastSuccessful: ids.at(-1),
    }),
  )
  return { dir, root, ids, bytes }
}

const item: PdfAnnotations.Item = {
  id: "note-1",
  type: "note",
  color: "yellow",
  pages: [{ page: 1, quads: [[10, 40, 40, 40, 10, 20, 40, 20]] }],
  selectedText: "A formula",
  note: "Check this",
  createdAt: 1,
  updatedAt: 1,
}

describe("immutable LaTeX PDF history", () => {
  test("annotations bind to one build, reject stale writes and export without changing the source PDF", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "main.tex"), "\\documentclass{article}")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fixture = await seed(2)
        const id = fixture.ids[0]
        const before = await Latex.annotations(id)
        expect(before.data.source.path).toBe(`latex-build:${id}`)
        const next = await Latex.annotate(id, {
          revision: before.revision,
          data: { ...before.data, annotations: [item] },
        })
        expect(next.revision).not.toBe(before.revision)
        await expect(Latex.annotate(id, { revision: before.revision, data: before.data })).rejects.toThrow("changed")
        expect((await Latex.annotations(fixture.ids[1])).data.annotations).toEqual([])
        await expect(
          Latex.annotate(id, {
            revision: next.revision,
            data: {
              ...next.data,
              source: { ...next.data.source, path: `latex-build:${fixture.ids[1]}` },
            },
          }),
        ).rejects.toThrow("different PDF")
        const exported = await PDFDocument.load(await Latex.exportAnnotations(id))
        expect(exported.getPage(0).node.Annots()?.size()).toBe(1)
        expect((await Latex.pdf(id)).bytes).toEqual(Buffer.from(fixture.bytes))
        expect(() => PdfAnnotations.resolve(path.join(fixture.dir, "artifacts", `${id}.pdf`))).toThrow("Access denied")
        await Instance.dispose()
      },
    })
  })

  test("cleanup keeps the newest three ordinary PDFs plus annotations, questions and live viewers", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "main.tex"), "\\documentclass{article}")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fixture = await seed(7)
        const first = await Latex.annotations(fixture.ids[0])
        await Latex.annotate(fixture.ids[0], { revision: first.revision, data: { ...first.data, annotations: [item] } })
        await Latex.reference(fixture.ids[1], "question-1")
        const lease = await Latex.lease(fixture.ids[2])
        const renewed = await Latex.lease(fixture.ids[2], lease.token)
        expect(renewed.token).toBe(lease.token)
        const result = await Latex.cleanup({ root: "." })
        expect(result.removed).toEqual([fixture.ids[3]])
        expect(await Bun.file(path.join(fixture.dir, "sync", `${fixture.ids[3]}.json`)).exists()).toBe(false)
        expect(await Bun.file(path.join(fixture.dir, "sync", `${fixture.ids[0]}.json`)).exists()).toBe(true)
        expect(result.versions.map((row) => row.build.id)).toEqual(
          fixture.ids.toReversed().filter((id) => id !== fixture.ids[3]),
        )
        expect(result.versions.find((row) => row.build.id === fixture.ids[0])?.annotationCount).toBe(1)
        expect(result.versions.find((row) => row.build.id === fixture.ids[1])?.referenced).toBe(true)
        expect(result.versions.find((row) => row.build.id === fixture.ids[2])?.viewing).toBe(true)
        await expect(Latex.pdf(fixture.ids[3])).rejects.toThrow("does not belong")
        await expect(Latex.forward(fixture.ids[0], { path: "main.tex", line: 1 })).rejects.toThrow("no source mapping")
        await Latex.release(fixture.ids[2], lease.token)
        expect((await Latex.cleanup({ root: "." })).removed).toEqual([fixture.ids[2]])
        expect((await Latex.annotations(fixture.ids[0])).data.annotations).toEqual([item])
        await Instance.dispose()
      },
    })
  })

  test("expired viewer leases do not pin builds forever and unknown artifacts are untouched", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "main.tex"), "\\documentclass{article}")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fixture = await seed(4)
        const id = fixture.ids[0]
        const lease = await Latex.lease(id)
        const file = path.join(fixture.dir, "annotations", `${id}.json`)
        const value = await Bun.file(file).json()
        value.leases[lease.token] = Date.now() - 1
        await Bun.write(file, JSON.stringify(value))
        const unknown = path.join(fixture.dir, "artifacts", `${crypto.randomUUID()}.pdf`)
        await Bun.write(unknown, fixture.bytes)
        expect((await Latex.cleanup({ root: "." })).removed).toEqual([id])
        expect(await Bun.file(unknown).exists()).toBe(true)
        await Instance.dispose()
      },
    })
  })

  test("build access remains scoped to its original workspace", async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    await Bun.write(path.join(first.path, "main.tex"), "\\documentclass{article}")
    const id = await Instance.provide({
      directory: first.path,
      fn: async () => {
        const value = (await seed(1)).ids[0]
        await Instance.dispose()
        return value
      },
    })
    await Instance.provide({
      directory: second.path,
      fn: async () => {
        await expect(Latex.annotations(id)).rejects.toThrow("does not belong")
        await expect(Latex.lease(id)).rejects.toThrow("does not belong")
        await expect(Latex.reference(id, "question-2")).rejects.toThrow("does not belong")
        await Instance.dispose()
      },
    })
  })

  test("cleanup bounds failed logs but never deletes malformed or foreign records", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "main.tex"), "\\documentclass{article}")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fixture = await seed(1)
        const source = await Bun.file(path.join(fixture.dir, "builds", `${fixture.ids[0]}.json`)).json()
        const ids = Array.from({ length: 21 }, () => crypto.randomUUID())
        for (const [index, id] of ids.entries())
          await Bun.write(
            path.join(fixture.dir, "builds", `${id}.json`),
            JSON.stringify({
              ...source,
              build: { ...source.build, id, state: "failed", pdf: false, createdAt: index },
            }),
          )
        const foreign = path.join(fixture.dir, "builds", `${crypto.randomUUID()}.json`)
        await Bun.write(foreign, JSON.stringify({ ...source, owner: "another-workspace" }))
        const malformed = path.join(fixture.dir, "builds", `${crypto.randomUUID()}.json`)
        await Bun.write(malformed, "not JSON")
        expect((await Latex.cleanup({ root: "." })).removed).toEqual([ids[0]])
        expect(await Bun.file(foreign).exists()).toBe(true)
        expect(await Bun.file(malformed).exists()).toBe(true)
        expect(await fs.stat(path.join(fixture.dir, "artifacts", `${fixture.ids[0]}.pdf`))).toBeDefined()
        await Instance.dispose()
      },
    })
  })
})
