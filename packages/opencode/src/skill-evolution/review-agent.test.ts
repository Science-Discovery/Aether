import { describe, expect, test } from "bun:test"
import { serializeHistory, buildReviewPrompt, isReviewSession } from "./review-agent"
import type { MessageSnapshot } from "./review-agent"

describe("serializeHistory", () => {
  test("produces XML block from message snapshots", () => {
    const messages: MessageSnapshot[] = [
      { role: "user", parts: [{ type: "text", text: "Hello" }] },
      { role: "assistant", parts: [{ type: "text", text: "Hi there" }] },
    ]
    const xml = serializeHistory(messages)
    expect(xml).toContain("<conversation_history>")
    expect(xml).toContain('role="user"')
    expect(xml).toContain('role="assistant"')
    expect(xml).toContain("Hello")
    expect(xml).toContain("Hi there")
    expect(xml).toContain("</conversation_history>")
  })

  test("escapes XML special characters", () => {
    const messages: MessageSnapshot[] = [
      { role: "user", parts: [{ type: "text", text: 'a < b & c > d "quote"' }] },
    ]
    const xml = serializeHistory(messages)
    expect(xml).toContain("&lt;")
    expect(xml).toContain("&amp;")
    expect(xml).toContain("&gt;")
    expect(xml).toContain("&quot;")
  })

  test("includes tool_call parts", () => {
    const messages: MessageSnapshot[] = [
      {
        role: "assistant",
        parts: [{ type: "tool", tool: "bash", callID: "call-123" }],
      },
    ]
    const xml = serializeHistory(messages)
    expect(xml).toContain('name="bash"')
    expect(xml).toContain('id="call-123"')
  })

  test("handles empty messages array", () => {
    const xml = serializeHistory([])
    expect(xml).toContain("<conversation_history>")
    expect(xml).toContain("</conversation_history>")
  })
})

describe("buildReviewPrompt", () => {
  test("returns a string containing the conversation history and review prompt base", async () => {
    const messages: MessageSnapshot[] = [
      { role: "user", parts: [{ type: "text", text: "Please help me deploy" }] },
    ]
    const prompt = await buildReviewPrompt(messages, "test-project-abc")
    expect(prompt).toContain("<conversation_history>")
    expect(prompt).toContain("Please help me deploy")
    // Should contain the base prompt
    expect(prompt).toContain("skill evolution agent")
  })
})

describe("isReviewSession", () => {
  test("returns false for unknown session IDs", () => {
    expect(isReviewSession("unknown-session-xyz")).toBe(false)
  })
})
