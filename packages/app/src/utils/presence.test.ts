import { describe, expect, test } from "bun:test"
import { conflictOf, presenceConflict, type PresenceData } from "./presence"

const BASE = "http://127.0.0.1:4096"
const ID = "browser-1"

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe("conflictOf", () => {
  const data = (patch: Partial<PresenceData>): PresenceData => ({ pid: 1, channel: "prod", ...patch })

  test("allows an empty channel", () => {
    expect(conflictOf(data({ programs: [], others: [] }), ID)).toBeNull()
  })

  test("allows the same browser reconnecting", () => {
    expect(conflictOf(data({ programs: [{ type: "web", id: ID }] }), ID)).toBeNull()
  })

  test("blocks a desktop program", () => {
    expect(conflictOf(data({ programs: [{ type: "desktop", id: "app-1" }] }), ID)).toEqual({ channel: "prod" })
  })

  test("blocks another browser", () => {
    expect(conflictOf(data({ programs: [{ type: "web", id: "browser-2" }] }), ID)).toEqual({ channel: "prod" })
  })

  test("blocks unnamed legacy web programs", () => {
    expect(conflictOf(data({ programs: [{ type: "web", id: "" }] }), ID)).toEqual({ channel: "prod" })
  })

  test("blocks when another server serves the same channel, even idle", () => {
    expect(conflictOf(data({ programs: [], others: [{ pid: 2, channel: "prod", programs: [] }] }), ID)).toEqual({
      channel: "prod",
    })
  })

  test("reports the channel name", () => {
    expect(conflictOf(data({ channel: "test", programs: [{ type: "desktop", id: "a" }] }), ID)).toEqual({
      channel: "test",
    })
  })
})

describe("presenceConflict", () => {
  test("returns null when there is no response", async () => {
    const impl = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: impl, id: ID })).toBeNull()
  })

  test("returns null when the response is not ok or malformed", async () => {
    const bad = (() => Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch
    const junk = (() => Promise.resolve(ok("nope"))) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: bad, id: ID })).toBeNull()
    expect(await presenceConflict(BASE, { fetch: junk, id: ID })).toBeNull()
  })

  test("requests the presence endpoint on the given server", async () => {
    let called = ""
    const impl = ((url: unknown) => {
      called = String(url)
      return Promise.resolve(ok({ pid: 1, channel: "prod", programs: [], others: [] }))
    }) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: impl, id: ID })).toBeNull()
    expect(called).toBe("http://127.0.0.1:4096/global/presence")
  })

  test("detects a desktop program through a real response", async () => {
    const impl = (() =>
      Promise.resolve(
        ok({
          pid: 1,
          channel: "local",
          programs: [],
          others: [{ pid: 2, channel: "local", programs: [{ type: "desktop", id: "app-1" }] }],
        }),
      )) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: impl, id: ID })).toEqual({ channel: "local" })
  })
})
