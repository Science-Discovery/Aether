import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { checksum } from "@opencode-ai/util/encode"
import { Instance } from "../../src/project/instance"
import { LatexProject } from "../../src/latex/project"
import { Latex } from "../../src/latex"
import { tmpdir } from "../fixture/fixture"

describe("LaTeX saved project", () => {
  test("resolves explicit bindings, ambiguous mains and safe root comments", async () => {
    await using dir = await tmpdir()
    await fs.mkdir(path.join(dir.path, "paper", "sections"), { recursive: true })
    await Bun.write(path.join(dir.path, "paper", "main.tex"), "\\documentclass{article}")
    await Bun.write(path.join(dir.path, "paper", "other.tex"), "\\documentclass{book}")
    await Bun.write(path.join(dir.path, "main.tex"), "\\documentclass{article}")
    await Bun.write(path.join(dir.path, "paper", "sections", "part.tex"), "% !TeX root = ../main.tex\nChapter")
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const result = await Latex.inspect({ root: "paper" })
        expect(result.reason).toBe("ambiguous")
        expect(result.candidates).toEqual(["main.tex", "other.tex"])
        expect((await Latex.inspect({ root: "paper", path: "main.tex" })).reason).toBe("ambiguous")
        await expect(Latex.inspect({ root: "paper", path: "../main.tex" })).rejects.toThrow("escapes this workspace")
        expect((await Latex.inspect({ root: "paper", path: "paper/sections/part.tex" })).main).toBe("main.tex")
        const bound = await Latex.bind({ root: "paper", main: "main.tex", driver: "auto", program: "auto" })
        expect((await Latex.inspect({ path: "paper/sections/part.tex" })).binding).toEqual(bound.binding)
        await expect(Latex.bind({ root: "paper", main: "other.tex", driver: "auto", program: "auto" })).rejects.toThrow(
          "binding changed",
        )
        await expect(LatexProject.root("..")).rejects.toThrow("inside this workspace")
        await Bun.write(path.join(dir.path, "paper", "main.tex"), "% !TeX root = sections/part.tex")
        await expect(LatexProject.magic(await LatexProject.root("paper"), "main.tex")).rejects.toThrow("cycle")
        await Bun.write(path.join(dir.path, "paper", "sections", "part.tex"), "% !TeX root = ../../main.tex")
        await expect(LatexProject.magic(await LatexProject.root("paper"), "sections/part.tex")).rejects.toThrow(
          "escapes the LaTeX project",
        )
        await Instance.dispose()
      },
    })
  })

  test("hashes all actual inputs including ignored PDF and bbl, and reports editor checksum", async () => {
    await using dir = await tmpdir()
    await Bun.write(path.join(dir.path, "main.tex"), "\\documentclass{article}")
    await Bun.write(path.join(dir.path, "figure.pdf"), "%PDF-figure")
    await Bun.write(path.join(dir.path, "references.bbl"), "Reference")
    await Bun.write(path.join(dir.path, ".gitignore"), "figure.pdf\nreferences.bbl")
    await Bun.write(path.join(dir.path, ".env"), "not copied")
    await Bun.write(path.join(dir.path, "node_modules", "large.js"), "excluded")
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const root = await LatexProject.root()
        const first = await LatexProject.scan(root, { editors: ["main.tex", "missing.tex"] })
        expect(first.manifest.files.map((file) => file.path)).toEqual([
          ".gitignore",
          "figure.pdf",
          "main.tex",
          "references.bbl",
        ])
        expect(first.editors).toEqual([
          { path: "main.tex", checksum: checksum("\\documentclass{article}") ?? "" },
          { path: "missing.tex", checksum: null },
        ])
        const before = await fs.stat(path.join(dir.path, "references.bbl"))
        await Bun.write(path.join(dir.path, "references.bbl"), "Changed!!")
        await fs.utimes(path.join(dir.path, "references.bbl"), before.atime, before.mtime)
        expect((await LatexProject.scan(root)).manifest.revision).not.toBe(first.manifest.revision)
        await Instance.dispose()
      },
    })
  })

  test("rejects junction escape, oversized source and unsupported program comments", async () => {
    await using dir = await tmpdir()
    await using outside = await tmpdir()
    await fs.symlink(outside.path, path.join(dir.path, "link"), process.platform === "win32" ? "junction" : "dir")
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await expect(LatexProject.scan(await LatexProject.root())).rejects.toThrow("symbolic links")
        await expect(LatexProject.root("link")).rejects.toThrow("inside this workspace")
        await fs.unlink(path.join(dir.path, "link"))
        const file = await fs.open(path.join(dir.path, "large.bin"), "w")
        await file.truncate(LatexProject.limit + 1)
        await file.close()
        await expect(LatexProject.scan(await LatexProject.root())).rejects.toThrow("256 MiB")
        expect(() => LatexProject.program("% !TeX program = lualatex")).toThrow("Unsupported")
        expect(() => LatexProject.program("% !TeX program = xelatex && echo nope")).toThrow("Unsupported")
        expect(LatexProject.program("% !TeX program = XeLaTeX")).toBe("xelatex")
        await Instance.dispose()
      },
    })
  })
})
