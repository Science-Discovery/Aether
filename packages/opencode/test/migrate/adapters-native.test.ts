import { describe, expect, test } from "bun:test"
import path from "node:path"
import * as grok from "../../src/migrate/adapters/grok"
import * as kimi from "../../src/migrate/adapters/kimi"
import * as muse from "../../src/migrate/adapters/muse"
import * as omp from "../../src/migrate/adapters/omp"
import * as openhands from "../../src/migrate/adapters/openhands"
import * as qwen from "../../src/migrate/adapters/qwen"
import * as vibe from "../../src/migrate/adapters/vibe"
import { buildBackup } from "../../src/migrate/target"

const fixture = (file: string) => path.join(import.meta.dir, "fixtures", file)
const kimiID = "session_0e9113f5-23d9-4ad4-8a94-a3f44c175d14"
const qwenID = "44c47f3e-ccfe-4fb7-aa06-0217dc950456"
const museID = "74747474-7474-4747-8747-747474747474"
const grokID = "95959595-9595-4959-8959-959595959595"
const openhandsID = "99e61c51f6e945cc93b022fee3a459f4"

describe("native adapters", () => {
  test("parses OMP", async () => {
    const session = await omp.parse(fixture("omp/basic.jsonl"))
    expect(session.sessionID).toBe("19191919-1919-4919-8919-191919191919")
    expect(session.title).toBe("OMP synthetic fixture")
    expect(session.model).toBe("fixture-model")
    expect(session.provider).toBe("session-migrate-loopback")
    expect(session.events.filter((event) => event.kind === "message").map((event) => event.text)).toContain(
      "OMP_SYNTHETIC_USER_ALPHA",
    )
    expect(session.events.find((event) => event.kind === "compaction")?.text).toBe("OMP_SYNTHETIC_SUMMARY_DELTA")
    const built = buildBackup(session, { directory: "/work" })
    expect(built.loss).toEqual({})
    expect(built.backup.messages.length).toBe(6)
  })

  test("resolves OMP native blob images", async () => {
    const session = await omp.parse(fixture("omp/native/sessions/--fixture-work--/session.jsonl"))
    const urls = session.events.filter((event) => event.kind === "context").map((event) => String(event.payload.image_url))
    expect(urls.some((url) => url.startsWith("data:image/png;base64,"))).toBe(true)
    expect(urls.every((url) => !url.includes("blob:sha256:"))).toBe(true)
    const built = buildBackup(session, { directory: "/work" })
    expect(built.loss["context:image"]).toBe(3)
  })

  test("parses Qwen", async () => {
    const session = await qwen.parse(fixture("qwen/basic.jsonl"))
    expect(session.sessionID).toBe(qwenID)
    expect(session.model).toBe("qwen/qwen3-coder-next")
    expect(session.events.filter((event) => event.kind === "tool_call")).toHaveLength(2)
    expect(session.events.filter((event) => event.kind === "tool_result")).toHaveLength(2)
    expect(session.events.some((event) => event.kind === "message" && event.text?.includes("SM_CORPUS_7319"))).toBe(true)
    const built = buildBackup(session, { directory: "/work" })
    expect(built.loss["opaque:qwen_runtime_or_metadata_record"]).toBe(6)
    expect(built.backup.messages.length).toBe(3)
  })

  test("parses Kimi", async () => {
    const session = await kimi.parse(fixture(`kimi/${kimiID}`))
    expect(session.sessionID).toBe(kimiID)
    expect(session.model).toBe("moonshotai/kimi-k2.7-code")
    expect(session.events.filter((event) => event.kind === "thinking")).toHaveLength(2)
    expect(session.events.filter((event) => event.kind === "tool_call")).toHaveLength(2)
    expect(session.events.some((event) => event.kind === "message" && event.text?.includes("SM_CORPUS_7319"))).toBe(true)
    const built = buildBackup(session, { directory: "/work" })
    expect(built.loss["opaque:kimi_runtime_record"]).toBe(16)
    expect(built.backup.messages.length).toBe(5)
  })

  test("parses Vibe", async () => {
    const session = await vibe.parse(fixture("vibe/basic"))
    expect(session.sessionID).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    expect(session.title).toBe("Synthetic Vibe fixture")
    expect(session.events.find((event) => event.kind === "tool_call")?.toolCallID).toBe("toolu_fixture_1")
    expect(session.events.find((event) => event.kind === "compaction")?.text).toContain("Synthetic summary")
    const built = buildBackup(session, { directory: "/work" })
    expect(built.loss).toEqual({})
    expect(built.backup.messages.length).toBe(7)
  })

  test("parses Muse", async () => {
    const session = await muse.parse(fixture("muse/session.jsonl"))
    expect(session.sessionID).toBe(museID)
    expect(session.model).toBe("meta/muse-glimmer-30b")
    expect(session.provider).toBe("meta")
    expect(session.events.filter((event) => event.kind === "message")).toHaveLength(6)
    expect(session.events.filter((event) => event.kind === "tool_call")).toHaveLength(3)
    expect(session.events.filter((event) => event.kind === "tool_result")).toHaveLength(3)
    const built = buildBackup(session, { directory: "/work" })
    expect(built.backup.messages.length).toBe(9)
  })

  test("parses Grok", async () => {
    const session = await grok.parse(fixture("grok/session"))
    expect(session.sessionID).toBe(grokID)
    expect(session.title).toBe("repair-event-window-boundary")
    expect(session.provider).toBe("xai")
    expect(session.events.filter((event) => event.kind === "tool_call")).toHaveLength(5)
    expect(session.events.filter((event) => event.kind === "tool_result")).toHaveLength(5)
    const built = buildBackup(session, { directory: "/work" })
    expect(built.loss["opaque:grok_tool_call_update"]).toBe(5)
    expect(built.backup.messages.length).toBe(9)
  })

  test("parses OpenHands", async () => {
    const session = await openhands.parse(fixture(`openhands/${openhandsID}`))
    expect(session.sessionID).toBe("99e61c51-f6e9-45cc-93b0-22fee3a459f4")
    expect(session.events).toHaveLength(5)
    expect(session.events.filter((event) => event.kind === "message")).toHaveLength(2)
    expect(session.events.find((event) => event.kind === "tool_result")?.text).toContain("COPPER_4821")
    const built = buildBackup(session, { directory: "/work" })
    expect(built.loss["opaque:openhands_system_prompt"]).toBe(1)
    expect(built.backup.messages.length).toBe(3)
  })
})
