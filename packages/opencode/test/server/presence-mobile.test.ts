import { describe, expect, test } from "bun:test"
import { parse, Presence } from "../../src/server/presence"

describe("presence mobile bridge info", () => {
  test("parse keeps per-platform bridge status", () => {
    const parsed = parse({
      pid: 1,
      channel: "local",
      clients: { desktop: 0, web: 2 },
      mobile: { wechat: "connected", qq: "idle" },
    })
    expect(parsed?.mobile).toEqual({ wechat: "connected", qq: "idle" })
  })

  test("parse omits the mobile field when the payload has none", () => {
    const plain = parse({ pid: 1, channel: "local", clients: { desktop: 1, web: 0 } })
    expect(plain?.mobile).toBeUndefined()
    const empty = parse({ pid: 1, channel: "local", clients: { desktop: 1, web: 0 }, mobile: {} })
    expect(empty?.mobile).toBeUndefined()
  })

  test("parse keeps valid entries among malformed ones", () => {
    const malformed = parse({
      pid: 1,
      channel: "local",
      clients: { desktop: 1, web: 0 },
      mobile: { wechat: 42, qq: "connected" },
    })
    expect(malformed?.mobile).toEqual({ qq: "connected" })
  })

  test("parse still rejects payloads without pid/channel/clients", () => {
    expect(parse({ pid: 1, channel: "local", mobile: { wechat: "connected" } })).toBeNull()
    expect(parse(null)).toBeNull()
  })

  test("info reports the registered bridge snapshot", () => {
    Presence.report(() => ({ wechat: "connected" }))
    const own = Presence.info()
    expect(own.mobile).toEqual({ wechat: "connected" })
    Presence.report(() => ({}))
    expect(Presence.info().mobile).toEqual({})
  })
})
