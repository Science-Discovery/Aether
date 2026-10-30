import { describe, expect, test } from "bun:test"
import { identity, paper, quote, source } from "./pdf-source"
import { createReadingQuoteMetadata, readReadingQuoteMetadata } from "./comment-note"

describe("compiled PDF identity", () => {
  test("keeps a stable paper identity for nested multilingual paths", () => {
    const path = paper("论文/实验 #1", "章节/main.tex")
    expect(source(path)).toEqual({ kind: "latex", root: "论文/实验 #1", main: "章节/main.tex" })
    expect(source("papers/report.pdf")).toEqual({ kind: "file", path: "papers/report.pdf" })
    expect(source("aether-latex:%broken/main.pdf")).toBeUndefined()
    expect(source("aether-latex:broken")).toBeUndefined()
    expect(identity("server", "one", "paper", "main.tex")).not.toBe(identity("server", "two", "paper", "main.tex"))
    expect(identity("server", "one", "paper", "main.tex")).not.toBe(identity("other", "one", "paper", "main.tex"))
  })

  test("retains the exact build in persisted quotation metadata", () => {
    const captured = { root: "paper", main: "main.tex", build: "build-one", hash: "a".repeat(64) }
    const meta = createReadingQuoteMetadata({
      mode: "quick",
      action: "ask",
      contentType: "image",
      pdfFileName: "main.pdf",
      startPage: 2,
      summary: "formula",
      source: captured,
    })
    expect(readReadingQuoteMetadata(meta)?.source).toEqual(captured)
    expect(quote({ ...captured, hash: "invalid" })).toBeUndefined()
    expect(quote({ ...captured, build: "" })).toBeUndefined()
  })
})
