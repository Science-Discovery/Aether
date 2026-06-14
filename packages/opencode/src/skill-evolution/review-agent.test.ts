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
    // Should carry the "Do NOT capture" blacklist borrowed from Hermes
    expect(prompt).toContain("self-imposed constraints")
    expect(prompt).toContain("this tool does not work")
    // Should carry the positive concrete-reuse test
    expect(prompt).toContain("name the specific future moment")
    // Should carry the two scope-overreach blacklist entries
    expect(prompt).toContain("dressed as a universal method")
    expect(prompt).toContain("self-re-running artifact")
  })

  test("includes a do-not-evolve warning naming each protected skill when the list is non-empty", async () => {
    const messages: MessageSnapshot[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
    ]
    const prompt = await buildReviewPrompt(messages, "test-project-abc", ["protected-one", "protected-two"])
    // Names the protected skills.
    expect(prompt).toContain("protected-one")
    expect(prompt).toContain("protected-two")
    // States the prohibition: do not modify them, and do not recreate equivalents.
    expect(prompt.toLowerCase()).toContain("do not modify")
    expect(prompt.toLowerCase()).toContain("do not create")
  })

  test("omits the warning entirely when no skills are protected (boundary)", async () => {
    const messages: MessageSnapshot[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
    ]
    const prompt = await buildReviewPrompt(messages, "test-project-abc", [])
    expect(prompt.toLowerCase()).not.toContain("do not modify")
  })
})

describe("isReviewSession", () => {
  test("returns false for unknown session IDs", () => {
    expect(isReviewSession()).toBe(false)
  })
})
