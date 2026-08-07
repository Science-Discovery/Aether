import { describe, expect, test } from "bun:test"
import { attachmentInput, toolcall } from "./model-capabilities"

describe("model capabilities compatibility", () => {
  test("reads the runtime provider capabilities shape", () => {
    const model = {
      capabilities: {
        toolcall: true,
        input: { image: true, pdf: true },
      },
    }
    expect(toolcall(model)).toBe(true)
    expect(attachmentInput(model)).toEqual({ image: true, pdf: true })
  })

  test("reads the legacy provider schema shape", () => {
    const model = {
      tool_call: true,
      attachment: true,
      modalities: { input: ["text", "image"] },
    }
    expect(toolcall(model)).toBe(true)
    expect(attachmentInput(model)).toEqual({ image: true, pdf: false })
  })

  test("prefers explicit runtime capabilities", () => {
    const model = {
      tool_call: true,
      attachment: true,
      modalities: { input: ["text", "image", "pdf"] },
      capabilities: {
        toolcall: false,
        input: { image: false, pdf: false },
      },
    }
    expect(toolcall(model)).toBe(false)
    expect(attachmentInput(model)).toEqual({ image: false, pdf: false })
  })
})
