import { describe, expect, test } from "bun:test"
import { createReadingQuoteMetadata, readReadingQuoteMetadata, summarizeReadingQuoteText } from "./comment-note"

describe("reading quote metadata", () => {
  test("round-trips text quotes", () => {
    const metadata = createReadingQuoteMetadata({
      mode: "classic",
      action: "ask",
      contentType: "text",
      pdfFileName: "paper.pdf",
      page: 12,
      summary: "short summary",
      fullText: "full selected text",
    })

    expect(readReadingQuoteMetadata(metadata)).toEqual({
      mode: "classic",
      action: "ask",
      contentType: "text",
      pdfFileName: "paper.pdf",
      page: 12,
      summary: "short summary",
      fullText: "full selected text",
      imageDataUrl: undefined,
    })
  })

  test("round-trips image quotes", () => {
    const metadata = createReadingQuoteMetadata({
      mode: "quick",
      action: "translate",
      contentType: "image",
      pdfFileName: "paper.pdf",
      page: 7,
      summary: "captured region",
      imageDataUrl: "data:image/png;base64,abc",
    })

    expect(readReadingQuoteMetadata(metadata)).toEqual({
      mode: "quick",
      action: "translate",
      contentType: "image",
      pdfFileName: "paper.pdf",
      page: 7,
      summary: "captured region",
      fullText: undefined,
      imageDataUrl: "data:image/png;base64,abc",
    })
  })

  test("summarizes long text", () => {
    const summary = summarizeReadingQuoteText("a".repeat(40), 12)
    expect(summary).toBe("aaaaaaaaaaa…")
  })
})
