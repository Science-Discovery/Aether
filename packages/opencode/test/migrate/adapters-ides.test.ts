import { describe, expect, test } from "bun:test"
import path from "node:path"
import * as codebuddy from "../../src/migrate/adapters/codebuddy"
import * as qoder from "../../src/migrate/adapters/qoder"
import * as qodercn from "../../src/migrate/adapters/qodercn"
import { buildBackup } from "../../src/migrate/target"

const fixture = (file: string) => path.join(import.meta.dir, "fixtures", file)
const qoderID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const qodercnID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const codebuddyID = "01a0f1c7-5e3a-7c41-9b8d-6f2a4e8d1b30"

describe("IDE adapters", () => {
  test("parses Qoder as Claude-format JSONL", async () => {
    const session = await qoder.parse(fixture("qoder/basic.jsonl"))
    expect(session.source).toBe("qoder")
    expect(session.sessionID).toBe(qoderID)
    expect(session.title).toBe("QODER_TITLE")
    expect(session.model).toBe("qoder-model")
    expect(session.events.filter((event) => event.kind === "message")).toHaveLength(2)
    const built = buildBackup(session, { directory: "/work" })
    expect(built.backup.messages.length).toBe(2)
    expect(built.loss["opaque:non_conversation_record"]).toBe(1)
  })

  test("parses Qoder CN as Claude-format JSONL", async () => {
    const session = await qodercn.parse(fixture("qodercn/basic.jsonl"))
    expect(session.source).toBe("qodercn")
    expect(session.sessionID).toBe(qodercnID)
    expect(session.title).toBe("QODERCN_TITLE")
    expect(session.model).toBe("qodercn-model")
    const built = buildBackup(session, { directory: "/work" })
    expect(built.backup.messages.length).toBe(2)
  })

  test("parses CodeBuddy event JSONL", async () => {
    const session = await codebuddy.parse(fixture("codebuddy/basic.jsonl"))
    expect(session.source).toBe("codebuddy")
    expect(session.sessionID).toBe(codebuddyID)
    expect(session.title).toBe("CODEBUDDY_TITLE")
    expect(session.model).toBe("codebuddy-model")
    expect(session.events.filter((event) => event.kind === "tool_call")).toHaveLength(1)
    expect(session.events.find((event) => event.kind === "tool_result")?.text).toBe("CODEBUDDY_TOOL_RESULT")
    expect(session.events.find((event) => event.kind === "compaction")?.text).toBe("CODEBUDDY_COMPACTION_SUMMARY")
    const built = buildBackup(session, { directory: "/work" })
    expect(built.loss.thinking).toBe(1)
    expect(built.loss["opaque:codebuddy_turn-metrics"]).toBe(1)
    expect(built.backup.messages.length).toBe(5)
  })
})
