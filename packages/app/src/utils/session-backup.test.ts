import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { buildBackupFiles, parseBackup } from "./session-backup"

const session = {
  id: "ses_1caeabcd1234",
  title: "Test Session",
  projectID: "pro_123",
  directory: "/tmp/project",
  slug: "slug",
  version: "1.0.0",
  time: {
    created: 1_000,
    updated: 2_000,
  },
} as Session

const messages = [
  {
    info: {
      id: "msg_1",
      sessionID: session.id,
      role: "user",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
      time: { created: 1_000 },
    } as Message,
    parts: [
      {
        id: "part_1",
        sessionID: session.id,
        messageID: "msg_1",
        type: "text",
        text: "hello",
      } as Part,
    ],
  },
  {
    info: {
      id: "msg_2",
      sessionID: session.id,
      role: "assistant",
      agent: "build",
      modelID: "claude-sonnet-4-20250514",
      providerID: "anthropic",
      parentID: "msg_1",
      mode: "",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 2_000, completed: 2_500 },
    } as Message,
    parts: [
      {
        id: "part_2",
        sessionID: session.id,
        messageID: "msg_2",
        type: "text",
        text: "world",
      } as Part,
    ],
  },
]

describe("session backup utils", () => {
  test("builds json export files with short session id names", () => {
    const files = buildBackupFiles(session, messages, {
      markdown: false,
      transcript: {
        thinking: true,
        toolDetails: true,
        assistantMetadata: true,
      },
    })

    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe("session-ses_1cae.json")
    expect(parseBackup(files[0]!.content).info).toBeDefined()
  })

  test("builds markdown alongside json when requested", () => {
    const files = buildBackupFiles(session, messages, {
      markdown: true,
      transcript: {
        thinking: true,
        toolDetails: true,
        assistantMetadata: true,
      },
    })

    expect(files.map((file) => file.path)).toEqual(["session-ses_1cae.json", "session-ses_1cae.md"])
    expect(files[1]?.content).toContain("# Test Session")
    expect(files[1]?.content).toContain("## Assistant")
  })
})
