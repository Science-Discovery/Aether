import { describe, expect, mock, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { SessionBackupData } from "@opencode-ai/util/session-backup"
import type { AppClient } from "./server"
import { addPreferenceMethods, addSessionBackupMethods } from "./server"

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

describe("addSessionBackupMethods", () => {
  test("encodes non-ascii directory headers for import requests", async () => {
    let init: RequestInit | undefined
    const fetchMock = mock(async (_input: RequestInfo | URL, req?: RequestInit) => {
      init = req
      return new Response(JSON.stringify({ sessionID: "ses-copy", title: "Greeting" }), {
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

    const data: SessionBackupData = {
      info: { id: "ses_1", title: "Greeting" },
      messages: [{ info: { id: "msg_1", role: "user" }, parts: [{ id: "prt_1", type: "text", text: "hello" }] }],
    }
    const dir = "C:\\Users\\Yan\\Desktop\\本学期课程\\量子统计物理"
    try {
      addSessionBackupMethods(client, "http://example.test", undefined, { directory: dir })
      const result = await client.session.import(data)
      expect(result.data?.sessionID).toBe("ses-copy")
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect((init?.headers as Record<string, string> | undefined)?.["x-opencode-directory"]).toBe(encodeURIComponent(dir))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
