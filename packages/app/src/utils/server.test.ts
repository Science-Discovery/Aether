import { describe, expect, test } from "bun:test"
import { addPreferenceMethods, type AppClient } from "./server"

describe("addPreferenceMethods", () => {
  test("preserves native session preference clients", () => {
    const pref = {
      get: async () => ({ data: null }),
      set: async () => ({ data: null }),
    } as unknown as AppClient["session"]["preference"]
    const client = {
      session: {},
    } as unknown as AppClient

    Object.defineProperty(client.session, "preference", {
      configurable: true,
      get: () => pref,
    })

    expect(() => addPreferenceMethods(client, "http://localhost:4096")).not.toThrow()
    expect(client.session.preference).toBe(pref)
  })

  test("adds fallback session preference methods when missing", async () => {
    const calls: Array<{ url: string; method: string; body?: string | null }> = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      })
      return new Response(JSON.stringify({ sessionID: "s1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    const client = {
      session: {},
    } as unknown as AppClient

    try {
      addPreferenceMethods(client, "http://localhost:4096")
      await client.session.preference.get({ sessionID: "s1" })
      await client.session.preference.set({ sessionID: "s1", approval: "auto" })
    } finally {
      globalThis.fetch = orig
    }

    expect(calls).toEqual([
      {
        url: "http://localhost:4096/session/s1/preference",
        method: "GET",
        body: null,
      },
      {
        url: "http://localhost:4096/session/s1/preference",
        method: "PUT",
        body: JSON.stringify({ approval: "auto" }),
      },
    ])
  })
})
