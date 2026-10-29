import { expect, test } from "bun:test"
import { NativeMcp } from "../../src/native/mcp"

test("MCP pagination preserves native connection status, auth, tool descriptions and errors", async () => {
  const cursors: unknown[] = []
  const result = await NativeMcp.list({
    request: async <T>(method: string, params: unknown) => {
      expect(method).toBe("mcpServerStatus/list")
      const cursor = (params as { cursor?: string }).cursor
      cursors.push(cursor)
      return (
        cursor
          ? {
              data: [
                {
                  name: "broken",
                  authStatus: "notLoggedIn",
                  runtimeStatus: "authenticationRequired",
                  toolsError: "Login required",
                  tools: {},
                },
              ],
              nextCursor: null,
            }
          : {
              data: [
                { name: "papers", authStatus: "unsupported", tools: { search: { description: "Search papers" } } },
              ],
              nextCursor: "next",
            }
      ) as T
    },
  })
  expect(cursors).toEqual([undefined, "next"])
  expect(result.servers).toEqual([
    {
      name: "papers",
      status: "unknown",
      auth: "unsupported",
      error: undefined,
      tools: [{ name: "search", description: "Search papers" }],
    },
    { name: "broken", status: "authenticationRequired", auth: "notLoggedIn", error: "Login required", tools: [] },
  ])
})

test("MCP repeated cursors and malformed inventories fail rather than return a partial ready catalog", async () => {
  await expect(NativeMcp.list({ request: async <T>() => ({ data: [], nextCursor: "loop" }) as T })).rejects.toThrow(
    "repeated",
  )
  await expect(NativeMcp.list({ request: async <T>() => ({ data: [{ name: "bad" }] }) as T })).rejects.toThrow()
})
