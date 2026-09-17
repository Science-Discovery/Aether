import { describe, expect, test } from "bun:test"
import {
  createFileQuoteMetadata,
  createReadingQuoteMetadata,
  readFileQuoteMetadata,
  readReadingQuoteMetadata,
  summarizeReadingQuoteText,
} from "./comment-note"
import { createConversationQuoteMetadata, readConversationQuoteMetadata } from "./conversation-quote-metadata"

describe("reading quote metadata", () => {
  test("round-trips text quotes", () => {
    const metadata = createReadingQuoteMetadata({
      mode: "classic",
      action: "ask",
      contentType: "text",
      pdfFileName: "paper.pdf",
      startPage: 12,
      endPage: 13,
      summary: "short summary",
      fullText: "full selected text",
    })

    expect(readReadingQuoteMetadata(metadata)).toEqual({
      mode: "classic",
      action: "ask",
      contentType: "text",
      pdfFileName: "paper.pdf",
      startPage: 12,
      endPage: 13,
      summary: "short summary",
      fullText: "full selected text",
      imageDataUrl: undefined,
    })
  })

  test("summarizes long text", () => {
    const summary = summarizeReadingQuoteText("a".repeat(40), 12)
    expect(summary).toBe("aaaaaaaaa...")
  })
})

describe("file quote metadata", () => {
  test("round-trips file quotes with line range", () => {
    const metadata = createFileQuoteMetadata({
      path: "src/agent.ts",
      startLine: 3,
      endLine: 9,
      summary: "short summary",
      fullText: "full selected text",
    })

    expect(readFileQuoteMetadata(metadata)).toEqual({
      path: "src/agent.ts",
      startLine: 3,
      endLine: 9,
      summary: "short summary",
      fullText: "full selected text",
    })
  })

  test("round-trips file quotes without lines", () => {
    const metadata = createFileQuoteMetadata({
      path: "notes.md",
      summary: "note",
      fullText: "selected markdown text",
    })

    expect(readFileQuoteMetadata(metadata)).toEqual({
      path: "notes.md",
      startLine: undefined,
      endLine: undefined,
      summary: "note",
      fullText: "selected markdown text",
    })
  })

  test("rejects invalid metadata", () => {
    expect(readFileQuoteMetadata(undefined)).toBeUndefined()
    expect(readFileQuoteMetadata({})).toBeUndefined()
    expect(readFileQuoteMetadata({ opencodeFileQuote: { path: "" } })).toBeUndefined()
    expect(
      readFileQuoteMetadata(createFileQuoteMetadata({ path: "a.ts", summary: "s", fullText: 42 as unknown as string })),
    ).toBeUndefined()
  })
})

describe("conversation quote metadata", () => {
  test("round-trips assistant quote metadata", () => {
    const metadata = createConversationQuoteMetadata({
      kind: "conversation-quote",
      source: "assistant",
      action: "ask",
      sourceMessageID: "message-123",
      summary: "short summary",
      fullText: "full quoted assistant text",
    })

    expect(readConversationQuoteMetadata(metadata)).toEqual({
      kind: "conversation-quote",
      source: "assistant",
      action: "ask",
      sourceMessageID: "message-123",
      summary: "short summary",
      fullText: "full quoted assistant text",
    })
  })
})
