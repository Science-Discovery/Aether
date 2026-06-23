import { describe, expect, test } from "bun:test"
import { createSessionBackup, formatTranscript, parseSessionBackup, SessionBackupSchema } from "./session-backup"

describe("session backup", () => {
  test("requires version 1", () => {
    expect(SessionBackupSchema.safeParse({ info: {}, messages: [] }).success).toBe(false)
    expect(SessionBackupSchema.safeParse({ version: 2, info: {}, messages: [] }).success).toBe(false)
    expect(SessionBackupSchema.parse(createSessionBackup({}, [])).version).toBe(1)
  })

  test("normalizes legacy backups without accepting unknown versions", () => {
    expect(parseSessionBackup({ info: {}, messages: [] })).toEqual({ version: 1, info: {}, messages: [] })
    expect(parseSessionBackup({ version: 1, info: {}, messages: [] })).toEqual({ version: 1, info: {}, messages: [] })
    expect(() => parseSessionBackup({ version: 2, info: {}, messages: [] })).toThrow()
    expect(() => parseSessionBackup({ info: {} })).toThrow()
  })

  test("formats readable transcripts", () => {
    const text = formatTranscript(
      { id: "session_1", title: "Test", time: { created: 1_000, updated: 2_000 } },
      [
        {
          info: { role: "assistant", agent: "build", modelID: "model", time: { created: 2_000, completed: 2_500 } },
          parts: [
            { type: "reasoning", text: "think" },
            { type: "text", text: "answer" },
            { type: "tool", tool: "read", state: { status: "completed", input: { path: "a" }, output: "ok" } },
          ],
        },
      ],
      { thinking: false, toolDetails: false, assistantMetadata: true },
    )
    expect(text).toContain("# Test")
    expect(text).toContain("## Assistant (Build · model · 0.5s)")
    expect(text).toContain("answer")
    expect(text).not.toContain("think")
    expect(text).not.toContain("**Input:**")
  })
})
