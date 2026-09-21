import { describe, expect, test } from "bun:test"
import { presenceConflict } from "./presence"

const BASE = "http://127.0.0.1:4096"

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe("presenceConflict", () => {
  test("returns null when there is no response", async () => {
    const impl = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: impl })).toBeNull()
  })

  test("returns null when the response is not ok or malformed", async () => {
    const bad = (() => Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch
    const junk = (() => Promise.resolve(ok({ hello: 1 }))) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: bad })).toBeNull()
    expect(await presenceConflict(BASE, { fetch: junk })).toBeNull()
  })

  test("ignores web-only others", async () => {
    const impl = (() =>
      Promise.resolve(
        ok({
          pid: 1,
          others: [
            { pid: 2, clients: { desktop: 0, web: 3 } },
            { pid: 3, clients: { desktop: 0, web: 1 } },
          ],
        }),
      )) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: impl })).toBeNull()
  })

  test("detects desktop clients on other servers", async () => {
    const impl = (() =>
      Promise.resolve(
        ok({
          pid: 1,
          others: [
            { pid: 2, clients: { desktop: 0, web: 3 } },
            { pid: 4, clients: { desktop: 1, web: 0 } },
          ],
        }),
      )) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: impl })).toEqual({ desktop: 1 })
  })

  test("requests the presence endpoint on the given server", async () => {
    let called = ""
    const impl = ((url: unknown) => {
      called = String(url)
      return Promise.resolve(ok({ pid: 1, others: [] }))
    }) as unknown as typeof fetch
    expect(await presenceConflict(BASE, { fetch: impl })).toBeNull()
    expect(called).toBe("http://127.0.0.1:4096/global/presence")
  })
})
