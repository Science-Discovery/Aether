import { describe, expect, test } from "bun:test"
import { livePart } from "./session-live"

function tool(status: string, name = "bash") {
  return { type: "tool", tool: name, state: { status } } as any
}

function text(value: string, end?: number) {
  return { type: "text", text: value, time: { start: 1, ...(end === undefined ? {} : { end }) } } as any
}

function reasoning(value: string, end?: number) {
  return { type: "reasoning", text: value, time: { start: 1, ...(end === undefined ? {} : { end }) } } as any
}

describe("livePart", () => {
  test("pending tool is live", () => {
    expect(livePart(tool("pending"), true)).toBe(true)
  })

  test("running tool is live", () => {
    expect(livePart(tool("running"), true)).toBe(true)
  })

  test("completed tool is not live", () => {
    expect(livePart(tool("completed"), true)).toBe(false)
  })

  test("errored tool is not live", () => {
    expect(livePart(tool("error"), true)).toBe(false)
  })

  test("hidden tool is never live", () => {
    expect(livePart(tool("running", "todowrite"), true)).toBe(false)
  })

  test("pending question is live", () => {
    expect(livePart(tool("pending", "question"), true)).toBe(true)
  })

  test("streaming text is live", () => {
    expect(livePart(text("hello"), true)).toBe(true)
  })

  test("finished text is not live", () => {
    expect(livePart(text("hello", 2), true)).toBe(false)
  })

  test("empty streaming text is not live", () => {
    expect(livePart(text("  "), true)).toBe(false)
  })

  test("text without time is not live", () => {
    expect(livePart({ type: "text", text: "hello" } as any, true)).toBe(false)
  })

  test("streaming reasoning is live when summaries shown", () => {
    expect(livePart(reasoning("thinking"), true)).toBe(true)
  })

  test("streaming reasoning is not live when summaries hidden", () => {
    expect(livePart(reasoning("thinking"), false)).toBe(false)
  })

  test("finished reasoning is not live", () => {
    expect(livePart(reasoning("thinking", 2), true)).toBe(false)
  })

  test("reasoning without time is not live", () => {
    expect(livePart({ type: "reasoning", text: "thinking" } as any, true)).toBe(false)
  })

  test("other part types are not live", () => {
    expect(livePart({ type: "step-start" } as any, true)).toBe(false)
    expect(livePart({ type: "file" } as any, true)).toBe(false)
  })
})
