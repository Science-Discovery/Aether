import { describe, expect, test } from "bun:test"
import { sanitizePrompt, sanitizePromptState } from "./prompt-persist"

describe("prompt persistence", () => {
  test("keeps draft content without persisting attachments", () => {
    const source = {
      prompt: [
        { type: "text", content: "summarize", start: 0, end: 9 },
        {
          type: "image",
          id: "pdf",
          filename: "large.pdf",
          mime: "application/pdf",
          dataUrl: "data:application/pdf;base64,large",
        },
      ],
      cursor: 9,
      context: { items: [{ type: "file", path: "paper.md", key: "paper.md" }] },
    }
    const value = sanitizePromptState(source)

    expect(value).toEqual({
      prompt: [{ type: "text", content: "summarize", start: 0, end: 9 }],
      cursor: 9,
      context: { items: [{ type: "file", path: "paper.md", key: "paper.md" }] },
    })
    expect(JSON.stringify(value)).not.toContain("data:application/pdf")
    expect(source.prompt).toHaveLength(2)
  })

  test("drops malformed and attachment-only persisted parts", () => {
    expect(sanitizePrompt([null, "bad", { type: "unknown" }, { type: "image", dataUrl: "data:large" }])).toEqual([])
    expect(
      sanitizePromptState({
        prompt: [null, { type: "image", dataUrl: "data:large" }],
        cursor: 0,
      }),
    ).toEqual({
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      cursor: 0,
      context: { items: [] },
    })

    expect(sanitizePromptState(null)).toEqual({
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      context: { items: [] },
    })
    expect(sanitizePromptState({ prompt: null, context: null })).toEqual({
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      context: { items: [] },
    })
  })
})
