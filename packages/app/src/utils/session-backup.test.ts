import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { buildBackupFiles, parseBackup } from "./session-backup"

const session = {
  id: "ses_1caeabcd1234",
  title: "Test Session",
  projectID: "project_123",
  directory: "/tmp/project",
  slug: "slug",
  version: "1.0.0",
  time: { created: 1_000, updated: 2_000 },
} as Session

const messages = [
  {
    info: {
      id: "message_1",
      sessionID: session.id,
      role: "user",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
      time: { created: 1_000 },
    } as Message,
    parts: [{ id: "part_1", sessionID: session.id, messageID: "message_1", type: "text", text: "hello" } as Part],
  },
]

describe("session backup utils", () => {
  test("builds versioned JSON", () => {
    const files = buildBackupFiles(session, messages, {
      markdown: false,
      transcript: { thinking: true, toolDetails: true, assistantMetadata: true },
    })
    expect(files.map((file) => file.path)).toEqual(["session-ses_1cae.json"])
    expect(parseBackup(files[0]!.content).version).toBe(1)
  })

  test("builds a Markdown transcript alongside JSON", () => {
    const files = buildBackupFiles(session, messages, {
      markdown: true,
      transcript: { thinking: true, toolDetails: true, assistantMetadata: true },
    })
    expect(files.map((file) => file.path)).toEqual(["session-ses_1cae.json", "session-ses_1cae.md"])
    expect(files[1]?.content).toContain("# Test Session")
  })
})
