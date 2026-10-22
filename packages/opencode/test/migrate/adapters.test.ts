import { describe, expect, test } from "bun:test"
import path from "node:path"
import * as claude from "../../src/migrate/adapters/claude"
import * as codex from "../../src/migrate/adapters/codex"
import * as copilot from "../../src/migrate/adapters/copilot"
import * as opencode from "../../src/migrate/adapters/opencode"
import * as pi from "../../src/migrate/adapters/pi"
import { buildBackup } from "../../src/migrate/target"

const fixture = (file: string) => path.join(import.meta.dir, "fixtures", file)

describe("migrate adapters", () => {
  test("parses the Claude Code fixture", async () => {
    const session = await claude.parse(fixture("claude/basic.jsonl"))
    expect(session.sessionID).toBe("10000000-0000-4000-8000-000000000000")
    expect(session.cwd).toBe("/work")
    expect(session.cliVersion).toBe("2.1.209")
    expect(session.provider).toBe("anthropic")
    expect(session.events.filter((event) => event.kind === "message").map((event) => event.text)).toContain(
      "Remember synthetic migrator nonce ALPHA-1042.",
    )
    const call = session.events.find((event) => event.kind === "tool_call")
    expect(call?.toolName).toBe("Read")
    expect(call?.toolCallID).toBe("toolu_fixture_1")
    const result = session.events.find((event) => event.kind === "tool_result")
    expect(result?.text).toBe("Synthetic fixture output.")
    const compaction = session.events.find((event) => event.kind === "compaction")
    expect(compaction?.text).toContain("Synthetic summary")
    const backup = buildBackup(session, { directory: "/work" })
    expect(backup.loss).toEqual({})
    expect(backup.backup.messages.length).toBe(7)
    expect(backup.backup.messages.reduce((sum, message) => sum + message.parts.length, 0)).toBe(9)
  })

  test("parses the Codex fixture", async () => {
    const session = await codex.parse(fixture("codex/basic.jsonl"))
    expect(session.sessionID).toBe("20000000-0000-4000-8000-000000000000")
    expect(session.cwd).toBe("/work")
    expect(session.cliVersion).toBe("0.144.4")
    expect(session.provider).toBe("openai")
    expect(session.events.filter((event) => event.kind === "message").map((event) => event.text)).toContain(
      "Remember synthetic migrator nonce BETA-2048.",
    )
    const call = session.events.find((event) => event.kind === "tool_call")
    expect(call?.toolName).toBe("shell")
    expect(call?.toolCallID).toBe("call_fixture_1")
    expect(session.events.find((event) => event.kind === "tool_result")?.text).toBe("/work")
    expect(session.events.find((event) => event.kind === "compaction")?.text).toContain("Synthetic summary")
    const backup = buildBackup(session, { directory: "/work" })
    expect(backup.loss).toEqual({})
    expect(backup.backup.messages.length).toBe(7)
  })

  test("parses a Codex subagent projection", async () => {
    const session = await codex.parse(fixture("codex/subagent.jsonl"))
    expect(session.sessionID).toBe("codex-subagent-fixture")
    expect(session.cwd).toBe("/work")
    expect(session.events.filter((event) => event.kind === "message").map((event) => event.text)).toEqual([
      "SUBAGENT_USER_MARKER",
      "SUBAGENT_ASSISTANT_MARKER",
    ])
    const meta = await codex.meta(fixture("codex/subagent.jsonl"))
    expect(meta.parentID).toBe("20000000-0000-4000-8000-000000000000")
    const backup = buildBackup(session, { directory: "/work" })
    expect(backup.loss["opaque:codex_subagent_history_projection"]).toBe(1)
    expect(backup.loss["session:synthetic_user_parent"]).toBeUndefined()
    expect(backup.backup.info.title).toBe("SUBAGENT_USER_MARKER")
    expect(backup.backup.messages.length).toBe(2)
  })

  test("maps a Codex SubAgentActivity anchor", async () => {
    const session = await codex.parse(
      fixture("codex/rollout-2026-10-01T12-00-01-50000000-0000-4000-8000-000000000000.jsonl"),
    )
    expect(session.sessionID).toBe("50000000-0000-4000-8000-000000000000")
    expect(session.parentActivity?.agent).toBe("fixture_agent")
    expect(session.parentActivity?.callID).toBe("call_fixture_subagent")
    expect(session.parentActivity?.timestamp).toBe(Date.parse("2026-10-01T12:00:01Z"))
  })

  test("parses the Pi fixture", async () => {
    const session = await pi.parse(fixture("pi/basic.jsonl"))
    expect(session.sessionID).toBe("11111111-1111-4111-8111-111111111111")
    expect(session.cwd).toBe("/tmp/session-migrate-fixture")
    expect(session.title).toBe("SYNTHETIC_IMPORTED_NAME")
    expect(session.model).toBe("fixture-model")
    expect(session.provider).toBe("anthropic")
    expect(session.events.filter((event) => event.kind === "message").map((event) => event.text)).toContain(
      "SYNTHETIC_USER_MARKER",
    )
    expect(session.events.find((event) => event.kind === "tool_call")?.toolName).toBe("read")
    expect(session.events.find((event) => event.kind === "tool_result")?.text).toBe("SYNTHETIC_TOOL_RESULT")
    expect(session.events.some((event) => event.kind === "context" && event.payload.block_type === "image")).toBe(true)
    const backup = buildBackup(session, { directory: "/work" })
    expect(backup.loss).toEqual({})
    expect(backup.backup.messages.length).toBe(3)
    expect(backup.backup.messages.reduce((sum, message) => sum + message.parts.length, 0)).toBe(5)
  })

  test("parses the Copilot fixture", async () => {
    const session = await copilot.parse(fixture("copilot/events.jsonl"))
    expect(session.sessionID).toBe("33333333-3333-4333-8333-333333333333")
    expect(session.cwd).toBe("/synthetic/copilot-source/project")
    expect(session.cliVersion).toBe("1.0.70")
    expect(session.title).toBe("SYNTHETIC_COPILOT_SOURCE_TITLE")
    expect(session.model).toBe("fixture-model")
    expect(session.provider).toBe("github-copilot")
    expect(session.events.filter((event) => event.kind === "message").map((event) => event.text)).toContain(
      "SYNTHETIC_COPILOT_SOURCE_USER",
    )
    expect(session.events.find((event) => event.kind === "tool_call")?.toolCallID).toBe("call_copilot_source_probe")
    expect(session.events.find((event) => event.kind === "tool_result")?.text).toBe("SYNTHETIC_COPILOT_SOURCE_TOOL_RESULT")
    expect(session.events.find((event) => event.kind === "compaction")?.text).toBe("SYNTHETIC_COPILOT_SOURCE_SUMMARY")
    const backup = buildBackup(session, { directory: "/work" })
    expect(backup.loss.thinking).toBe(1)
    expect(backup.loss["opaque:copilot_subagent_scoped_event"]).toBe(1)
    expect(backup.backup.messages.length).toBe(5)
  })

  test("parses the OpenCode fixture and loss manifest", async () => {
    const session = await opencode.parse(fixture("opencode/basic.json"))
    expect(session.sessionID).toBe("ses_11111111111141118111111111111111")
    expect(session.title).toBe("SYNTHETIC_IMPORTED_NAME")
    expect(session.events.filter((event) => event.kind === "message").map((event) => event.text)).toContain(
      "SYNTHETIC_USER_MARKER",
    )
    expect(session.events.find((event) => event.kind === "tool_call")?.toolCallID).toBe("synthetic_call_1")
    const backup = buildBackup(session, { directory: "/work" })
    expect(backup.loss["opaque:opencode_tool_metadata"]).toBe(1)
    expect(backup.backup.messages.length).toBe(3)
  })

  test("parses the comprehensive OpenCode fixture", async () => {
    const session = await opencode.parse(fixture("opencode/comprehensive.json"))
    expect(session.title).toBe("SYNTHETIC_OPENCODE_SOURCE_TITLE")
    expect(session.events.some((event) => event.kind === "thinking")).toBe(true)
    expect(session.events.some((event) => event.kind === "compaction")).toBe(true)
    const backup = buildBackup(session, { directory: "/work" })
    expect(backup.loss["opaque:opencode_snapshot_part"]).toBe(1)
    expect(backup.loss["thinking"]).toBe(1)
    expect(backup.backup.messages.length).toBe(4)
  })
})
