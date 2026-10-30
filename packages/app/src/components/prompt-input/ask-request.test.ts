import { describe, expect, test } from "bun:test"
import type { Reference } from "@/utils/ask-reference"
import { referenceParts, referenceRanges } from "./ask-request"

const pdf = (start: number, end = start): Reference => ({
  id: `pdf-${start}`,
  version: 1,
  kind: "pdf",
  question: `Explain page ${start}`,
  text: `Passage ${start}`,
  summary: `Passage ${start}`,
  path: "/papers/a.pdf",
  filename: "a.pdf",
  mode: "classic",
  sourceSession: "reading-a",
  startPage: start,
  endPage: end,
  selection: `position-${start}`,
  content: "text",
  totalPages: 12,
  settings: {
    questionPrompt: "Use {selected_content} to answer {user_question}. {context_pages}",
    contextPageRange: 1,
  },
})

describe("Ask reference requests", () => {
  test("merges overlapping context pages only within the same source", () => {
    const other = pdf(3)
    if (other.kind !== "pdf") throw new Error("Expected PDF")
    expect(
      referenceRanges([
        pdf(1, 2),
        pdf(3, 4),
        pdf(10, 12),
        { ...other, path: "/papers/b.pdf", sourceSession: "reading-b" },
      ]),
    ).toEqual([
      { path: "/papers/a.pdf", filename: "a.pdf", sessionID: "reading-a", startPage: 1, endPage: 5 },
      { path: "/papers/a.pdf", filename: "a.pdf", sessionID: "reading-a", startPage: 9, endPage: 12 },
      { path: "/papers/b.pdf", filename: "a.pdf", sessionID: "reading-b", startPage: 2, endPage: 4 },
    ])
  })

  test("keeps mixed numbered questions, images, and ordinary file quotes together", () => {
    const image = pdf(2)
    if (image.kind !== "pdf") throw new Error("Expected PDF")
    const refs: Reference[] = [
      {
        id: "conversation",
        version: 1,
        kind: "conversation",
        question: "Why?",
        text: "Earlier answer",
        summary: "Earlier answer",
        messageID: "answer",
        start: 3,
        end: 17,
      },
      {
        ...image,
        mode: "quick",
        content: "image",
        image: "data:image/png;base64,capture",
        question: "Explain this diagram",
      },
    ]
    const result = referenceParts({
      refs,
      text: "Compare both",
      file: { sessionID: "current", path: "note.md", text: "File context", summary: "File context" },
    })
    expect(result.parts[0]).toEqual({ text: "Compare both", ignored: true })
    expect(result.parts[1].text).toContain("[Reference 1]")
    expect(result.parts[1].text).toContain("[Question 1]\nWhy?")
    expect(result.parts[1].text).toContain("[Question 2]\nExplain this diagram")
    expect(result.parts[1].text).toContain("[Selected content from note.md]\nFile context")
    expect(result.attachments).toEqual([
      { filename: "reference-2-page-2.png", mime: "image/png", dataUrl: "data:image/png;base64,capture" },
    ])
    expect(result.parts[2]).toMatchObject({
      metadata: { opencodeConversationQuote: { question: "Why?", order: 1, start: 3, end: 17 } },
    })
    expect(result.parts[3]).toMatchObject({
      metadata: { opencodeReadingQuote: { question: "Explain this diagram", order: 2, contentType: "image" } },
    })
    expect(result.parts[4]).toMatchObject({ metadata: { opencodeFileQuote: { path: "note.md" } } })
  })

  test("supports only per-reference questions without duplicating selected text", () => {
    const ref = pdf(1)
    if (ref.kind !== "pdf") throw new Error("Expected PDF")
    const result = referenceParts({ refs: [{ ...ref, mode: "quick" }], text: "" })
    expect(result.parts[0].text).toBe("1. Explain page 1")
    expect(result.parts[1].text.split("Passage 1")).toHaveLength(2)
  })

  test("includes each shared context once and fails if context or image is missing", () => {
    const refs = [pdf(2), pdf(3)]
    const result = referenceParts({
      refs,
      text: "",
      contexts: [
        {
          path: "/papers/a.pdf",
          sessionID: "reading-a",
          startPage: 1,
          endPage: 4,
          text: "Shared paragraph",
          attachment: { filename: "pages.pdf", mime: "application/pdf", dataUrl: "data:application/pdf;base64,pages" },
        },
      ],
    })
    expect(result.parts[1].text.split("Shared paragraph")).toHaveLength(2)
    expect(result.attachments).toHaveLength(1)
    expect(() => referenceParts({ refs, text: "Question" })).toThrow("Missing PDF reading context")
    const ref = pdf(1)
    if (ref.kind !== "pdf") throw new Error("Expected PDF")
    expect(() => referenceParts({ refs: [{ ...ref, content: "image", mode: "quick" }], text: "Question" })).toThrow(
      "Missing selected image",
    )
  })

  test("does not reinterpret template placeholders inside quoted content or questions", () => {
    const ref = pdf(1)
    if (ref.kind !== "pdf") throw new Error("Expected PDF")
    const result = referenceParts({
      text: "",
      refs: [
        {
          ...ref,
          mode: "quick",
          text: "Use {user_question} and {context_pages} literally",
          question: "What is {selected_pages}?",
        },
      ],
    })
    expect(result.parts[1].text).toContain(
      "Use Use {user_question} and {context_pages} literally to answer What is {selected_pages}?",
    )
    expect(result.parts[2]).toMatchObject({
      metadata: { opencodeReadingQuote: { fullText: "Use {user_question} and {context_pages} literally" } },
    })
  })
})
