import { afterEach, describe, expect, test } from "bun:test"
import { Aether } from "../src/aether"

type WireMessage = {
  info: { id: string; role: string; sessionID: string; parentID?: string; finish?: string; summary?: boolean; agent?: string; mode?: string; error?: unknown }
  parts: { type: string; text?: string; synthetic?: boolean; auto?: boolean; overflow?: boolean }[]
}
const session = "ses_fixture"
const continued = "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
function user(id: string, text = "Inspect requested local files", synthetic = false): WireMessage {
  return { info: { id, role: "user", sessionID: session, agent: "build" }, parts: [{ type: "text", text, ...(synthetic ? { synthetic: true } : {}) }] }
}
function assistant(id: string, parentID: string, text = "Final verified answer", extra: Partial<WireMessage["info"]> = {}): WireMessage {
  return { info: { id, role: "assistant", sessionID: session, parentID, agent: "build", mode: "build", finish: "stop", ...extra }, parts: [{ type: "text", text }] }
}
function compact(id: string): WireMessage {
  return { info: { id, role: "user", sessionID: session, agent: "build" }, parts: [{ type: "compaction", auto: true, overflow: false }] }
}
function summary(id: string, parentID: string): WireMessage {
  return assistant(id, parentID, "Compacted context, not an answer", { summary: true, agent: "compaction", mode: "compaction" })
}
function chain(): WireMessage[] {
  return [user("msg_01"), assistant("msg_02", "msg_01", "working", { finish: "tool-calls" }), compact("msg_03"), summary("msg_04", "msg_03"), user("msg_05", continued, true), assistant("msg_06", "msg_05")]
}
const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })
async function resolved(messages: WireMessage[], original = "msg_01") {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe(`/session/${session}/message`)
    return Response.json(messages)
  } })
  servers.push(server)
  return new Aether(server.url.origin).result("/fixture", session, original)
}

describe("independent Aether compaction continuation association", () => {
  test("ordinary direct final answer preserves its exact parent", async () => {
    const final = assistant("msg_02", "msg_01")
    expect(await resolved([user("msg_01"), final])).toEqual(final)
  })

  test("verified automatic compaction returns final answer with normalized parent and provenance", async () => {
    const history = chain(), before = JSON.stringify(history)
    const final = await resolved(history)
    expect(final?.info.id).toBe("msg_06")
    expect(final?.info.parentID).toBe("msg_01")
    expect(final?.info.sourceParentID).toBe("msg_05")
    expect(final?.parts[0]?.text).toBe("Final verified answer")
    expect(JSON.stringify(history)).toBe(before)
    expect(history.at(-1)!.info.parentID).toBe("msg_05")
  })

  test("normalization copies final info without mutating the history object", async () => {
    const history = chain(), original = history.at(-1)!, before = JSON.stringify(history)
    const adapter = new Aether("http://127.0.0.1:1")
    adapter.request = async <T>() => history as unknown as T
    const final = await adapter.result("/fixture", session, "msg_01")
    expect(final).not.toBe(original)
    expect(final?.info).not.toBe(original.info)
    expect(final?.info.parentID).toBe("msg_01")
    expect(JSON.stringify(history)).toBe(before)
  })

  test("two verified compactions can continue one original request", async () => {
    const history = chain().slice(0, -1)
    history.push(assistant("msg_06", "msg_05", "more work", { finish: "tool-calls" }), compact("msg_07"), summary("msg_08", "msg_07"), user("msg_09", continued, true), assistant("msg_10", "msg_09", "After two compactions"))
    const final = await resolved(history)
    expect(final?.info.id).toBe("msg_10")
    expect(final?.info.parentID).toBe("msg_01")
    expect(final?.info.sourceParentID).toBe("msg_09")
  })

  test("summary stop without its continuation is never a completed worker answer", async () => {
    expect(await resolved(chain().slice(0, 4))).toBeUndefined()
    expect(await resolved([user("msg_01"), summary("msg_02", "msg_01")])).toBeUndefined()
  })

  test("a real intervening user prevents attribution to the previous request", async () => {
    const history = chain()
    history.splice(2, 0, user("msg_new_user", "A different actual user request"))
    expect(await resolved(history)).toBeUndefined()
  })

  test("other synthetic text, mixed user parts, and standalone continuation do not establish a chain", async () => {
    const other = chain(); other[4] = user("msg_05", "Continue some unrelated task", true)
    expect(await resolved(other)).toBeUndefined()
    const mixed = chain(); mixed[4]!.parts.push({ type: "text", text: "New real user content" })
    expect(await resolved(mixed)).toBeUndefined()
    expect(await resolved([user("msg_01"), user("msg_05", continued, true), assistant("msg_06", "msg_05")])).toBeUndefined()
  })

  test("manual or overflow compaction cannot silently bridge request ownership", async () => {
    for (const patch of [{ auto: false }, { overflow: true }]) {
      const history = chain(); Object.assign(history[2]!.parts[0]!, patch)
      expect(await resolved(history)).toBeUndefined()
    }
  })

  test("summary must have the correct parent, compaction identity, success and finish", async () => {
    for (const patch of [
      { parentID: "msg_other" }, { summary: false }, { agent: "build" }, { mode: "build" },
      { finish: "length" }, { error: { name: "SummaryFailed" } },
    ]) {
      const history = chain(); Object.assign(history[3]!.info, patch)
      expect(await resolved(history)).toBeUndefined()
    }
  })

  test("summary and synthetic continuation must be adjacent in the verified chain", async () => {
    const history = chain()
    history.splice(4, 0, assistant("msg_inserted", "msg_01", "unexpected intervening work", { finish: "tool-calls" }))
    expect(await resolved(history)).toBeUndefined()
  })

  test("foreign session metadata at any chain step stops association", async () => {
    for (const index of [0, 1, 2, 3, 4, 5]) {
      const history = chain(); history[index]!.info.sessionID = "ses_other"
      expect(await resolved(history)).toBeUndefined()
    }
  })

  test("incomplete session metadata cannot authorize compaction continuation", async () => {
    for (const index of [0, 2, 3, 4, 5]) {
      const history = chain(); delete (history[index]!.info as Partial<WireMessage["info"]>).sessionID
      expect(await resolved(history)).toBeUndefined()
    }
  })

  test("an assistant attached to another parent stops the chain", async () => {
    const history = chain(); history[1]!.info.parentID = "msg_other"
    expect(await resolved(history)).toBeUndefined()
    const later = chain(); later.splice(5, 0, assistant("msg_wrong", "msg_other", "wrong turn", { finish: "tool-calls" }))
    expect(await resolved(later)).toBeUndefined()
  })

  test("an already completed original turn is not replaced by subsequent automatic continuation", async () => {
    const original = assistant("msg_original_final", "msg_01", "Original answer")
    const history = chain(); history.splice(1, 0, original)
    expect(await resolved(history)).toEqual(original)
  })

  test("a continued assistant error is preserved as an error, not converted into success", async () => {
    const history = chain(); history[5]!.info.error = { name: "ModelFailure" }; delete history[5]!.info.finish
    const failed = await resolved(history)
    expect(failed?.info.parentID).toBe("msg_01")
    expect(failed?.info.sourceParentID).toBe("msg_05")
    expect(failed?.info.error).toEqual({ name: "ModelFailure" })
    expect(failed?.info.finish).toBeUndefined()
  })

  test("missing original user allows only exact-parent ordinary assistant fallback", async () => {
    expect(await resolved(chain().slice(1))).toBeUndefined()
    const direct = assistant("msg_direct", "msg_01")
    expect(await resolved([direct])).toEqual(direct)
    expect(await resolved([summary("msg_summary", "msg_01")])).toBeUndefined()
  })

  test("synchronous prompt rejects an unverified changed parent instead of inventing ownership", async () => {
    const history = chain(); history[4] = user("msg_05", "A new actual user request")
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      return Response.json(request.method === "POST" ? history.at(-1) : history)
    } })
    servers.push(server)
    await expect(new Aether(server.url.origin).prompt("/fixture", session, "msg_01", "inspect")).rejects.toThrow("Cannot bind")
  })

  test("synchronous prompt validates changed parent against history before returning", async () => {
    const history = chain(), methods: string[] = []
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      methods.push(request.method)
      if (request.method === "POST") {
        const body = await request.json() as { messageID: string }
        expect(body.messageID).toBe("msg_01")
        return Response.json(history.at(-1))
      }
      return Response.json(history)
    } })
    servers.push(server)
    const final = await new Aether(server.url.origin).prompt("/fixture", session, "msg_01", "inspect")
    expect(final.info.id).toBe("msg_06")
    expect(final.info.parentID).toBe("msg_01")
    expect(final.info.sourceParentID).toBe("msg_05")
    expect(methods).toEqual(["POST", "GET"])
  })
})
