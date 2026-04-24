import { describe, expect, mock, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { AppClient } from "./server"
import { addPreferenceMethods } from "./server"

describe("addPreferenceMethods", () => {
  test("supports getter-only session.preference on beta SDK", async () => {
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ sessionID: "ses-test", autoAccept: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })

    const client = createOpencodeClient({
      baseUrl: "http://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    }) as unknown as AppClient

    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(client.session), "preference")
    expect(descriptor?.get).toBeDefined()
    expect(descriptor?.set).toBeUndefined()

    const originalGet = client.session.preference.get
    try {
      expect(() => addPreferenceMethods(client, "http://example.test")).not.toThrow()
      expect(client.session.preference.get).not.toBe(originalGet)

      const result = await client.session.preference.get({ sessionID: "ses-test" })
      expect(result.data?.sessionID).toBe("ses-test")
      expect(result.data?.autoAccept).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
