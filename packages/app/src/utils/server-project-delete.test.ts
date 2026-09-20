import { describe, expect, test } from "bun:test"
import { addProjectDeleteMethod, type AppClient } from "./server"

const makeClient = () => {
  const client = { project: {} } as unknown as AppClient
  addProjectDeleteMethod(client, "http://test.local")
  return client.project
}

describe("addProjectDeleteMethod", () => {
  test("forwards cascade in the request body instead of dropping it", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ status: "ok" }), { headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      const project = makeClient()
      await project.delete({ projectID: "p1" })
      await project.delete({ projectID: "p2", cascade: true })

      expect(calls.length).toBe(2)
      for (const call of calls) {
        expect(call.init.method).toBe("DELETE")
        expect(call.init.headers).toMatchObject({ "Content-Type": "application/json" })
      }
      expect(calls[0]!.url).toBe("http://test.local/project/p1")
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ cascade: false })
      expect(calls[1]!.url).toBe("http://test.local/project/p2")
      expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ cascade: true })
    } finally {
      globalThis.fetch = original
    }
  })

  test("surfaces the server error message and returns empty data without throwOnError", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (_input: any, _init?: any) =>
      new Response(JSON.stringify({ message: "Malformed JSON in request body" }), { status: 400 })) as typeof fetch
    try {
      const project = makeClient()
      const silent = await project.delete({ projectID: "p1" })
      expect(silent.data).toBeUndefined()

      const throwing = addProjectDeleteMethod({ project: {} } as unknown as AppClient, "http://test.local", undefined, {
        throwOnError: true,
      }).project
      await expect(throwing.delete({ projectID: "p1" })).rejects.toThrow("Malformed JSON in request body")
    } finally {
      globalThis.fetch = original
    }
  })
})
