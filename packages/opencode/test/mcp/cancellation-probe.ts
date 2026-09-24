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

type CallToolResult = { content: Array<{ type: "text"; text: string }> }
type Scenario = { name: string; pass: boolean; detail?: string }

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

function opts(signal?: AbortSignal): ToolCallOptions {
  return { toolCallId: "call-1", messages: [], abortSignal: signal }
}

type Harness = Awaited<ReturnType<typeof harness>>

async function scenario(name: string, fn: (h: Harness) => Promise<void>): Promise<Scenario> {
  const h = await harness()
  const result = await fn(h).then(
    () => ({ name, pass: true }),
    (err) => ({ name, pass: false, detail: String(err) }),
  )
  await h.cleanup().catch(() => {})
  return result
}

const results: Scenario[] = []

results.push(
  await scenario("abort during in-flight call sends notifications/cancelled and settles the request", async (h) => {
    const controller = new AbortController()
    const pending = h.tool.execute!({}, opts(controller.signal))
    await h.started()
    if (h.state.calls !== 1) throw new Error(`expected 1 call, got ${h.state.calls}`)

    controller.abort()
    await pending.then(
      () => {
        throw new Error("execute resolved despite abort")
      },
      () => {},
    )
    await waitFor(() => h.state.handlerSawAbort)
    if (!h.state.handlerSawAbort) throw new Error("server handler never saw cancellation")
  }),
)

results.push(
  await scenario("pre-aborted signal rejects without dispatching a remote call", async (h) => {
    const controller = new AbortController()
    controller.abort()

    await h.tool.execute!({}, opts(controller.signal)).then(
      () => {
        throw new Error("execute resolved despite pre-abort")
      },
      () => {},
    )

    await Bun.sleep(20)
    if (h.state.calls !== 0) throw new Error(`expected 0 calls, got ${h.state.calls}`)
  }),
)

results.push(
  await scenario("undefined abortSignal keeps normal execution", async (h) => {
    const result = await h.tool.execute!({}, opts(undefined))
    if (JSON.stringify(result.content[0]) !== JSON.stringify({ type: "text", text: "done" }))
      throw new Error(`unexpected result: ${JSON.stringify(result.content)}`)
    if (h.state.calls !== 1) throw new Error(`expected 1 call, got ${h.state.calls}`)
    if (h.state.handlerSawAbort) throw new Error("handler saw spurious cancellation")
  }),
)

console.log(JSON.stringify(results))
