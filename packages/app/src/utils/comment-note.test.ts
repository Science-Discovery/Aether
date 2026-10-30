import { describe, expect, test } from "bun:test"
import {
  createFileQuoteMetadata,
  createReadingQuoteMetadata,
  readFileQuoteMetadata,
  readReadingQuoteMetadata,
  summarizeReadingQuoteText,
} from "./comment-note"
import {
  createConversationQuoteMetadata,
  readConversationQuoteMetadata,
  readQuoteReferences,
} from "./conversation-quote-metadata"

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

  test("preserves each question and source in a mixed sent reference list", () => {
    const pdf = createReadingQuoteMetadata({
      id: "pdf",
      question: "What does this chart show?",
      order: 2,
      mode: "quick",
      action: "ask",
      contentType: "image",
      pdfFileName: "paper.pdf",
      path: "papers/paper.pdf",
      sourceSession: "source",
      selection: "region:1",
      startPage: 4,
      endPage: 4,
      summary: "chart",
      imageDataUrl: "data:image/png;base64,aGVsbG8=",
    })
    const conversation = createConversationQuoteMetadata({
      id: "reply",
      question: "Why?",
      order: 1,
      start: 10,
      end: 15,
      kind: "conversation-quote",
      source: "assistant",
      action: "ask",
      sourceMessageID: "message",
      summary: "quote",
      fullText: "quote",
    })
    const refs = readQuoteReferences([{ metadata: pdf }, { metadata: conversation }])
    expect(refs.map((ref) => ref.quote.id)).toEqual(["reply", "pdf"])
    expect(refs[0].quote).toMatchObject({ question: "Why?", start: 10, end: 15, order: 1 })
    expect(refs[1].quote).toMatchObject({
      question: "What does this chart show?",
      path: "papers/paper.pdf",
      sourceSession: "source",
      selection: "region:1",
      imageDataUrl: "data:image/png;base64,aGVsbG8=",
    })
  })

  test("keeps legacy reference order and ignores invalid optional fields", () => {
    const pdf = createReadingQuoteMetadata({
      mode: "classic",
      action: "translate",
      contentType: "text",
      pdfFileName: "paper.pdf",
      startPage: 1,
      summary: "legacy PDF",
      fullText: "legacy PDF",
    })
    const conversation = createConversationQuoteMetadata({
      kind: "conversation-quote",
      source: "assistant",
      action: "ask",
      sourceMessageID: "message",
      summary: "legacy reply",
      fullText: "legacy reply",
    })
    expect(readQuoteReferences([{ metadata: pdf }, {}, { metadata: conversation }]).map((ref) => ref.kind)).toEqual([
      "pdf",
      "conversation",
    ])
    expect(
      readConversationQuoteMetadata({
        opencodeConversationQuote: {
          ...conversation.opencodeConversationQuote,
          order: -1,
          start: 5,
          end: 2,
          question: 7,
        },
      }),
    ).toMatchObject({ start: 5 })
    expect(
      readConversationQuoteMetadata({
        opencodeConversationQuote: {
          ...conversation.opencodeConversationQuote,
          order: -1,
          start: 5,
          end: 2,
          question: 7,
        },
      }),
    ).not.toHaveProperty("end")
    expect(
      readReadingQuoteMetadata({ opencodeReadingQuote: { ...pdf.opencodeReadingQuote, order: Infinity, path: 4 } }),
    ).not.toHaveProperty("order")
  })
})
