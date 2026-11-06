import { describe, expect, test } from "bun:test"
import { checksum } from "@opencode-ai/util/encode"
import { draft, preview } from "./file-preview"

describe("file preview routing", () => {
  test("recognizes only supported Office and HTML extensions", () => {
    expect(["paper.DOCX", "sheet.xlsx", "slides.pptx", "page.html", "web.HTM"].map(preview)).toEqual([
      "docx",
      "xlsx",
      "pptx",
      "html",
      "html",
    ])
    for (const name of ["paper.doc", "sheet.xls", "slides.ppt", "image.html.png", "code.ts", "readme.md", "paper.pdf"])
      expect(preview(name)).toBeUndefined()
  })
  test("keeps empty and current drafts, never stale or unrelated content", () => {
    const content = "<h1>saved</h1>"
    const base = checksum(content) ?? ""
    expect(draft({ value: "", base, content, editing: true })).toBe("")
    expect(draft({ value: "new", base, content, editing: true })).toBe("new")
    expect(draft({ value: "new", base, content: "changed", editing: true })).toBeUndefined()
    expect(draft({ value: "new", content, editing: true })).toBeUndefined()
    expect(draft({ value: "new", base, content, editing: false })).toBeUndefined()
    expect(draft({ value: "new", base, editing: true })).toBeUndefined()
  })
})
