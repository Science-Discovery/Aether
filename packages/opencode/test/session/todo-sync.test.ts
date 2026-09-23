import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Bus } from "../../src/bus"
import { Todo } from "../../src/session/todo"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

Log.init({ print: false })

type Item =
  | {
      type: "text"
      text: string
    }
  | {
      type: "tool"
      tool: string
      input: unknown
    }

const pid = ProviderID.make("todo-local")
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

function chunk(input: { text?: string; finish?: string; delta?: Record<string, unknown> }) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [
      {
        delta: input.delta ?? (input.text ? { content: input.text } : {}),
        ...(input.finish ? { finish_reason: input.finish } : {}),
      },
    ],
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
    line(chunk({ finish: "tool_calls" })),
  ]
}

function stream(item: Item) {
  const body = [
    line(chunk({})),
    ...(item.type === "text" ? [line(chunk({ text: item.text })), line(chunk({ finish: "stop" }))] : tool(item)),
    line("done"),
  ].join("")
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  })
}

async function stub(items: Item[]) {
  const queue = [...items]
  const server = await serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      if (JSON.stringify(body).includes("Generate a title for this conversation")) {
        return stream({ type: "text", text: "Todo Test" })
      }
      const item = queue.shift()
      if (!item) return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 })
      return stream(item)
    },
  })
  servers.push(server)
  return { url: `${server.url.origin}/v1` }
}

async function setup(url: string) {
  return tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            [pid]: {
              name: "Todo Local",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                [mid]: {
                  name: "Tiny",
                  tool_call: true,
                  temperature: true,
                  limit: { context: 100, output: 20 },
                  modalities: {
                    input: ["text"],
                    output: ["text"],
                  },
                },
              },
              options: {
                apiKey: "test-key",
                baseURL: url,
              },
            },
          },
        }),
      )
    },
  })
}

const todo = (content: string, status: string) => ({ content, status, priority: "high" })

async function collect() {
  const seen: Array<{ todos: Todo.Info[]; at: number }> = []
  const off = Bus.subscribe(Todo.Event.Updated, (event) => {
    seen.push({ todos: event.properties.todos, at: Date.now() })
  })
  return { seen, stop: off }
}

describe("todo live sync", () => {
  test("emits todo.updated during execution and re-asserts it at the next step", async () => {
    const v1 = [todo("task one", "in_progress"), todo("task two", "pending")]
    const srv = await stub([
      { type: "tool", tool: "todowrite", input: { todos: v1 } },
      { type: "text", text: "step done" },
    ])
    await using tmp = await setup(srv.url)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const feed = await collect()
        const session = await Session.create({})
        const started = Date.now()
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          tools: { todowrite: true },
          parts: [{ type: "text", text: "work through the list" }],
        })
        feed.stop()

        expect(feed.seen.length).toBeGreaterThanOrEqual(2)
        expect(feed.seen[0].todos).toEqual(v1)
        expect(feed.seen[0].at).toBeLessThan(Date.now())
        const reassert = feed.seen.at(-1)!
        expect(reassert.todos).toEqual(v1)
        expect(reassert.at).toBeGreaterThan(started)
        expect(await Todo.get(session.id)).toEqual(v1)
      },
    })
  })

  test("a client that missed the tool event receives stored truth on the follow-up turn", async () => {
    const v1 = [todo("task one", "completed"), todo("task two", "in_progress")]
    const srv = await stub([
      { type: "tool", tool: "todowrite", input: { todos: v1 } },
      { type: "text", text: "turn one done" },
      { type: "text", text: "turn two answer" },
    ])
    await using tmp = await setup(srv.url)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          tools: { todowrite: true },
          parts: [{ type: "text", text: "start the task" }],
        })

        const feed = await collect()
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "follow-up question" }],
        })
        feed.stop()

        expect(feed.seen.length).toBeGreaterThanOrEqual(1)
        expect(feed.seen[0].todos).toEqual(v1)
        expect(await Todo.get(session.id)).toEqual(v1)
      },
    })
  })
})
