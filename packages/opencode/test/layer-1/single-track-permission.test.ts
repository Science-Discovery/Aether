import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { TaskTool } from "../../src/tool/task"
import { Permission } from "../../src/permission"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

Log.init({ print: false })

type Usage = {
  input: number
  output: number
}

type Item =
  | {
      type: "text"
      text: string
      usage?: Usage
    }
  | {
      type: "tool"
      tool: string
      input: unknown
      usage?: Usage
    }
  | {
      type: "error"
      status: number
      body: unknown
    }

type Hit = {
  url: URL
  body: Record<string, unknown>
}

const pid = ProviderID.make("single-track-local")
const mid = ModelID.make("tiny")
const model = { providerID: pid, modelID: mid }
const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

function line(input: unknown) {
  if (input === "done") return "data: [DONE]\n\n"
  return `data: ${JSON.stringify(input)}\n\n`
}

function chunk(input: { text?: string; finish?: string; usage?: Usage; delta?: Record<string, unknown> }) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [
      {
        delta: input.delta ?? (input.text ? { content: input.text } : {}),
        ...(input.finish ? { finish_reason: input.finish } : {}),
      },
    ],
    ...(input.usage
      ? {
          usage: {
            prompt_tokens: input.usage.input,
            completion_tokens: input.usage.output,
            total_tokens: input.usage.input + input.usage.output,
          },
        }
      : {}),
  }
}

function tool(item: Extract<Item, { type: "tool" }>) {
  const args = JSON.stringify(item.input)
  return [
    line(
      chunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_test",
              type: "function",
              function: {
                name: item.tool,
                arguments: "",
              },
            },
          ],
        },
      }),
    ),
    line(
      chunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: args,
              },
            },
          ],
        },
      }),
    ),
    line(chunk({ finish: "tool_calls", usage: item.usage })),
  ]
}

function stream(item: Extract<Item, { type: "text" | "tool" }>) {
  const body = [
    line(chunk({})),
    ...(item.type === "text"
      ? [line(chunk({ text: item.text })), line(chunk({ finish: "stop", usage: item.usage }))]
      : tool(item)),
    line("done"),
  ].join("")
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  })
}

async function stub(items: Item[]) {
  const hits: Hit[] = []
  const queue = [...items]
  const server = await serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      const url = new URL(req.url)
      hits.push({ url, body })
      if (JSON.stringify(body).includes("Generate a title for this conversation")) {
        return stream({ type: "text", text: "Single Track Test", usage: { input: 4, output: 2 } })
      }
      const item = queue.shift()
      if (!item) return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 })
      if (item.type === "error") {
        return new Response(JSON.stringify(item.body), {
          status: item.status,
          headers: { "Content-Type": "application/json" },
        })
      }
      return stream(item)
    },
  })
  servers.push(server)
  return {
    hits,
    url: `${server.url.origin}/v1`,
  }
}

async function setup(url: string, cfg: Record<string, unknown> = {}) {
  return tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          ...cfg,
          provider: {
            [pid]: {
              name: "Single Track Local",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                [mid]: {
                  name: "Tiny",
                  tool_call: true,
                  temperature: true,
                  limit: { context: 100, output: 20 },
                  modalities: {
                    input: ["text", "image"],
                    output: ["text"],
                  },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: url,
              },
            },
            ...((cfg.provider as Record<string, unknown> | undefined) ?? {}),
          },
        }),
      )
    },
  })
}

function main(hits: Hit[]) {
  return hits.filter((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"))
}

describe("Layer 1.5 — single-track permission contract", () => {
  test("prompt without tools preserves session.permission", async () => {
    // noReply: true returns at prompt.ts:194, AFTER the tools→permission
    // conversion block (prompt.ts:181-192). With no `tools` passed, the
    // `permissions` array stays empty, `if (permissions.length > 0)` is false,
    // so session.permission is NOT overwritten and the rich ruleset survives.
    await using tmp = await setup("http://localhost:9/v1")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rich: Permission.Ruleset = [
          { permission: "edit", pattern: "src/**", action: "allow" },
          { permission: "edit", pattern: "*", action: "deny" },
          { permission: "bash", pattern: "*", action: "deny" },
        ]
        const session = await Session.create({ permission: rich })

        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          noReply: true,
          parts: [{ type: "text", text: "test" }],
        })

        const updated = await Session.get(session.id)
        expect(updated.permission).toEqual(rich)
      },
    })
  })

  test("task dispatch preserves finalPermission and inherits the caller model", async () => {
    const srv = await stub([
      { type: "text", text: "ok", usage: { input: 4, output: 2 } },
      { type: "text", text: "done", usage: { input: 4, output: 2 } },
    ])
    await using tmp = await setup(srv.url, {
      experimental: { primary_tools: ["bash"] },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: parent.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "dispatch" }],
        })
        const msgs = await Session.messages({ sessionID: parent.id })
        const assistant = msgs.findLast((m) => m.info.role === "assistant")!

        const caller = await Agent.get("build")
        const tool = await TaskTool.init({ agent: caller! })
        const result = await tool.execute(
          { description: "test", prompt: "say hi", subagent_type: "general" },
          {
            sessionID: parent.id,
            messageID: assistant.info.id,
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: async () => {},
            extra: { bypassAgentCheck: true },
          },
        )

        const child = await Session.get(result.metadata.sessionId)
        const user = (await Session.messages({ sessionID: child.id })).find((x) => x.info.role === "user")
        if (user?.info.role !== "user") throw new Error("Child user message not found")
        const hasBashDeny = child.permission?.some(
          (r) => r.permission === "bash" && r.pattern === "*" && r.action === "deny",
        )
        expect(user.info.model).toEqual(model)
        expect(result.metadata.model).toEqual(model)
        expect(hasBashDeny).toBe(true)
      },
    })
  })
})
