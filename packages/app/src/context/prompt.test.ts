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
      references: [],
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
      references: [],
    })

    expect(sanitizePromptState(null)).toEqual({
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      context: { items: [] },
      references: [],
    })
    expect(sanitizePromptState({ prompt: null, context: null })).toEqual({
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      context: { items: [] },
      references: [],
    })
  })

  test("keeps scoped references and missing screenshot placeholders through persistence", () => {
    const ref = {
      id: "selection",
      version: 3,
      kind: "pdf",
      question: "What does this diagram mean?",
      text: "Figure 2",
      summary: "Figure 2",
      path: "/papers/a.pdf",
      filename: "a.pdf",
      mode: "quick",
      startPage: 2,
      endPage: 2,
      selection: "rectangle:2:10:20:30:40",
      content: "image",
      image: "data:image/png;base64,large",
      settings: { questionPrompt: "Explain" },
    }
    const value = sanitizePromptState({ prompt: [], references: [ref] })
    expect(value.references).toEqual([{ ...ref, image: undefined }])
    expect(JSON.stringify(value)).not.toContain("base64")
    expect(ref.image).toBe("data:image/png;base64,large")
  })
})
