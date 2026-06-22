import { describe, expect, test } from "bun:test"
import {
  createReadingQuoteMetadata,
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
