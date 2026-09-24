import { describe, expect, test } from "bun:test"
import { addProjectOpenMethod, type AppClient } from "./server"

const makeClient = (options?: Parameters<typeof addProjectOpenMethod>[3]) => {
  const client = { project: {} } as unknown as AppClient
  addProjectOpenMethod(client, "http://test.local", undefined, options)
  return client.project
}

describe("addProjectOpenMethod", () => {
  test("posts the directory in the body and keeps the directory query binding", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify({ id: "p1", worktree: "C:/proj", time: { created: 1, updated: 2 }, sandboxes: [] }),
        { headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch
    try {
      const project = makeClient()
      const result = await project.open({ directory: "C:/my dir" })

      expect(calls.length).toBe(1)
      expect(calls[0]!.init.method).toBe("POST")
      expect(calls[0]!.url).toBe("http://test.local/project/open?directory=C%3A%2Fmy%20dir")
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ directory: "C:/my dir" })
      expect(result.data?.id).toBe("p1")
    } finally {
      globalThis.fetch = original
    }
  })

  test("throws the server error message with throwOnError", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (_input: any, _init?: any) =>
      new Response(JSON.stringify({ error: "Directory not found" }), { status: 400 })) as typeof fetch
    try {
      const project = makeClient({ throwOnError: true })
      await expect(project.open({ directory: "C:/missing" })).rejects.toThrow("Directory not found")
    } finally {
      globalThis.fetch = original
    }
  })
})
