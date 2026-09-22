import { describe, expect, test } from "bun:test"
import { conflictOf, presenceConflict, type PresenceData } from "./presence"

const BASE = "http://127.0.0.1:4096"

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe("conflictOf", () => {
  const data = (patch: Partial<PresenceData>): PresenceData => ({ pid: 1, channel: "prod", ...patch })

  test("allows an empty channel", () => {
    expect(conflictOf(data({ clients: { desktop: 0, web: 0 }, others: [] }))).toBeNull()
  })

  test("allows web clients on the same server", () => {
    expect(conflictOf(data({ clients: { desktop: 0, web: 3 }, others: [] }))).toBeNull()
  })

  test("blocks a desktop client on this server", () => {
    expect(conflictOf(data({ clients: { desktop: 1, web: 0 }, others: [] }))).toEqual({ channel: "prod" })
  })

  test("blocks when another server serves the same channel, even idle", () => {
    expect(
      conflictOf(
        data({
          clients: { desktop: 0, web: 0 },
          others: [{ pid: 2, channel: "prod", clients: { desktop: 0, web: 0 } }],
        }),
      ),
    ).toEqual({ channel: "prod" })
  })

  test("reports the channel name", () => {
    expect(conflictOf(data({ channel: "test", clients: { desktop: 2, web: 0 } }))).toEqual({ channel: "test" })
  })
})

describe("presenceConflict", () => {
  test("returns null when there is no response", async () => {
    const impl = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: impl })).toBeNull()
  })

  test("returns null when the response is not ok or malformed", async () => {
    const bad = (() => Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch
    const junk = (() => Promise.resolve(ok("nope"))) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: bad })).toBeNull()
    expect(await presenceConflict(BASE, { fetch: junk })).toBeNull()
  })

  test("requests the presence endpoint on the given server", async () => {
    let called = ""
    const impl = ((url: unknown) => {
      called = String(url)
      return Promise.resolve(ok({ pid: 1, channel: "prod", clients: { desktop: 0, web: 0 }, others: [] }))
    }) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: impl })).toBeNull()
    expect(called).toBe("http://127.0.0.1:4096/global/presence")
  })

  test("detects a desktop client through a real response", async () => {
    const impl = (() =>
      Promise.resolve(
        ok({
          pid: 1,
          channel: "local",
          clients: { desktop: 0, web: 1 },
          others: [{ pid: 2, channel: "local", clients: { desktop: 1, web: 0 } }],
        }),
      )) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: impl })).toEqual({ channel: "local" })
  })
})
