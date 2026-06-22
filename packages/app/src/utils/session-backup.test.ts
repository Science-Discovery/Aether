import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import {
  BACKUP_WARN_BYTES,
  buildBackupFiles,
  formatBackupSize,
  parseBackup,
  sessionExportBlocked,
} from "./session-backup"

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
  const date = new Date(2026, 5, 22, 14, 30, 5)

  test("builds versioned JSON", () => {
    const files = buildBackupFiles(session, messages, {
      markdown: false,
      transcript: { thinking: true, toolDetails: true, assistantMetadata: true },
      date,
    })
    expect(files.map((file) => file.path)).toEqual(["session-ses_1cae-20260622-143005.json"])
    expect(parseBackup(files[0]!.content).version).toBe(1)
  })

  test("builds a Markdown transcript alongside JSON", () => {
    const files = buildBackupFiles(session, messages, {
      markdown: true,
      transcript: { thinking: true, toolDetails: true, assistantMetadata: true },
      date,
    })
    expect(files.map((file) => file.path)).toEqual([
      "session-ses_1cae-20260622-143005.json",
      "session-ses_1cae-20260622-143005.md",
    ])
    expect(files[1]?.content).toContain("# Test Session")
  })

  test("uses a 50 MiB soft warning threshold", () => {
    expect(BACKUP_WARN_BYTES).toBe(50 * 1024 * 1024)
    expect(formatBackupSize(BACKUP_WARN_BYTES)).toBe("50.0 MiB")
  })

  test("blocks export for active and incomplete sessions", () => {
    expect(sessionExportBlocked({ type: "busy" }, false)).toBe(true)
    expect(sessionExportBlocked({ type: "retry" }, false)).toBe(true)
    expect(sessionExportBlocked({ type: "idle" }, true)).toBe(true)
    expect(sessionExportBlocked({ type: "idle" }, false)).toBe(false)
  })
})
