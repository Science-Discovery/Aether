import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import type { ToolCallOptions } from "ai"
import { MCP } from "../../src/mcp"

async function waitFor(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error("waitFor timeout")
    await Bun.sleep(5)
  }
}

async function harness() {
  const client = new Client({ name: "test-client", version: "0.0.0" })
  const server = new Server({ name: "test-server", version: "0.0.0" }, { capabilities: { tools: {} } })

  let calls = 0
  let handlerSawAbort = false
  let markStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => (markStarted = resolve))

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "slow", description: "slow tool", inputSchema: { type: "object", properties: {} } }],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
    calls++
    markStarted()
    await new Promise<void>((resolve) => {
      const work = setTimeout(resolve, 10)
      if (extra.signal.aborted) {
        clearTimeout(work)
        return resolve()
      }
      extra.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(work)
          resolve()
        },
        { once: true },
      )
    })
    handlerSawAbort = extra.signal.aborted
    return { content: [{ type: "text", text: "done" }] } satisfies CallToolResult
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  const mcpTool = {
    name: "slow",
    description: "slow tool",
    inputSchema: { type: "object" as const, properties: {} },
  } as MCPToolDef
  const tool = MCP.convertMcpTool(mcpTool, client, 5000)

  return {
    tool,
    state: {
      get calls() {
        return calls
      },
      get handlerSawAbort() {
        return handlerSawAbort
      },
    },
    started: () => started,
    cleanup: async () => {
      await client.close()
      await server.close()
    },
  }
}

type CallToolResult = { content: Array<{ type: "text"; text: string }> }

function opts(signal?: AbortSignal): ToolCallOptions {
  return { toolCallId: "call-1", messages: [], abortSignal: signal }
}

describe("MCP tool cancellation", () => {
  test("abort during in-flight call sends notifications/cancelled and settles the request", async () => {
    const h = await harness()
    const controller = new AbortController()

    const pending = h.tool.execute!({}, opts(controller.signal))
    await h.started()
    expect(h.state.calls).toBe(1)

    controller.abort()
    await expect(pending).rejects.toThrow()
    await waitFor(() => h.state.handlerSawAbort)

    expect(h.state.calls).toBe(1)
    expect(h.state.handlerSawAbort).toBe(true)
    await h.cleanup()
  })

  test("pre-aborted signal rejects without dispatching a remote call", async () => {
    const h = await harness()
    const controller = new AbortController()
    controller.abort()

    await expect(h.tool.execute!({}, opts(controller.signal))).rejects.toThrow()

    await Bun.sleep(20)
    expect(h.state.calls).toBe(0)
    expect(h.state.handlerSawAbort).toBe(false)
    await h.cleanup()
  })

  test("undefined abortSignal keeps normal execution", async () => {
    const h = await harness()

    const result = await h.tool.execute!({}, opts(undefined))
    expect(result.content[0]).toEqual({ type: "text", text: "done" })
    expect(h.state.calls).toBe(1)
    expect(h.state.handlerSawAbort).toBe(false)
    await h.cleanup()
  })
})
