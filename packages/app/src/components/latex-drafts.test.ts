import { describe, expect, test } from "bun:test"
import { checksum } from "@opencode-ai/util/encode"
import { contains, dirty, save, source, type LatexDraft } from "./latex-drafts"

describe("LaTeX project drafts", () => {
  test("keeps sibling projects outside the selected root", () => {
    expect(contains("papers/a", "papers/a/main.tex")).toBe(true)
    expect(contains("papers/a", "papers/another/main.tex")).toBe(false)
    expect(contains("papers\\a", "papers/a/refs.bib")).toBe(true)
    expect(contains(".", "main.tex")).toBe(true)
    expect(dirty({ path: "empty.tex", content: "", base: "" })).toBe(false)
  })

  test("limits automatic project saves to LaTeX source files", async () => {
    const drafts = ["main.tex", "refs.bib", "style.sty", "class.cls", "style.bst", "notes.md", "analysis.py"].map(
      (path) => ({ path, content: "edited", base: "" }),
    )
    const writes: string[] = []
    await save({
      root: ".",
      drafts: () => drafts,
      write: async (draft) => {
        writes.push(draft.path)
      },
      saved: () => undefined,
    })
    expect(writes).toEqual(["main.tex", "refs.bib", "style.sty", "class.cls", "style.bst"])
    expect(source("PAPER.TEX")).toBe(true)
    expect(source("paper.tex.bak")).toBe(false)
  })

  test("saves closed-tab drafts and retains input typed during a save", async () => {
    const drafts: LatexDraft[] = [
      { path: "paper/main.tex", content: "one", base: checksum("before") },
      { path: "paper/closed.bib", content: "entry", base: "" },
      { path: "other/main.tex", content: "unrelated", base: "" },
    ]
    const writes: string[] = []
    const result = await save({
      root: "paper",
      drafts: () => drafts,
      write: async (draft) => {
        writes.push(draft.path)
        if (draft.path === "paper/main.tex") drafts[0].content = "two"
      },
      saved: (draft, base) => {
        drafts.find((item) => item.path === draft.path)!.base = base
      },
    })
    expect(writes).toEqual(["paper/main.tex", "paper/closed.bib"])
    expect(result.errors).toEqual([])
    expect(result.pending.map((item) => item.content)).toEqual(["two"])
    expect(drafts[0].base).toBe(checksum("one"))
  })

  test("reports partial saves and never force-writes a draft without its base", async () => {
    const drafts: LatexDraft[] = [
      { path: "main.tex", content: "saved", base: "" },
      { path: "refs.bib", content: "conflict", base: "old" },
      { path: "section.tex", content: "unknown" },
    ]
    const writes: string[] = []
    const result = await save({
      root: ".",
      drafts: () => drafts,
      write: async (draft) => {
        writes.push(draft.path)
        if (draft.path === "refs.bib") throw { error: "conflict" }
      },
      saved: (draft, base) => {
        drafts.find((item) => item.path === draft.path)!.base = base
      },
    })
    expect(writes).toEqual(["main.tex", "refs.bib"])
    expect(result.errors.map((item) => item.path)).toEqual(["refs.bib", "section.tex"])
    expect(result.pending.map((item) => item.path)).toEqual(["refs.bib", "section.tex"])
    expect(dirty(drafts[0])).toBe(false)
  })
})
