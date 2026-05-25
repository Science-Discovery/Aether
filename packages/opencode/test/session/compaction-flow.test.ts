import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Instance } from "../../src/project/instance"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
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

const pid = ProviderID.make("compaction-local")
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
        return stream({ type: "text", text: "Compaction Test", usage: { input: 4, output: 2 } })
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
              name: "Compaction Local",
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

function texts(msgs: MessageV2.WithParts[]) {
  return msgs.flatMap((msg) => msg.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
}

function main(hits: Hit[]) {
  return hits.filter((hit) => !JSON.stringify(hit.body).includes("Generate a title for this conversation"))
}

describe("session compaction flow", () => {
  test("auto compacts after finish-step usage crosses the model context budget", async () => {
    const srv = await stub([
      { type: "text", text: "first answer", usage: { input: 82, output: 1 } },
      { type: "text", text: "summary answer", usage: { input: 12, output: 2 } },
      { type: "text", text: "continued answer", usage: { input: 12, output: 2 } },
    ])
    await using tmp = await setup(srv.url)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "start" }],
        })
        const msgs = await Session.messages({ sessionID: session.id })
        const compact = msgs.find((msg) => msg.parts.some((part) => part.type === "compaction"))
        const summary = msgs.find((msg) => msg.info.role === "assistant" && msg.info.summary === true)
        const synthetic = msgs.find((msg) =>
          msg.parts.some(
            (part) => part.type === "text" && part.synthetic && part.text.startsWith("Continue if you have next steps"),
          ),
        )

        expect(result.info.role).toBe("assistant")
        expect(texts([result])).toContain("continued answer")
        expect(compact?.parts.some((part) => part.type === "compaction" && part.auto && !part.overflow)).toBe(true)
        expect(summary?.parts.some((part) => part.type === "text" && part.text === "summary answer")).toBe(true)
        expect(synthetic).toBeDefined()
        expect(main(srv.hits).length).toBe(3)
      },
    })
  })

  test("does not auto compact when compaction.auto is disabled", async () => {
    const srv = await stub([{ type: "text", text: "large answer", usage: { input: 82, output: 1 } }])
    await using tmp = await setup(srv.url, { compaction: { auto: false } })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "start" }],
        })
        const msgs = await Session.messages({ sessionID: session.id })

        expect(result.info.role).toBe("assistant")
        expect(texts([result])).toContain("large answer")
        expect(msgs.some((msg) => msg.parts.some((part) => part.type === "compaction"))).toBe(false)
        expect(main(srv.hits).length).toBe(1)
      },
    })
  })

  test("manual compaction writes a summary without creating a continuation turn", async () => {
    const srv = await stub([{ type: "text", text: "manual summary", usage: { input: 12, output: 2 } }])
    await using tmp = await setup(srv.url)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          noReply: true,
          parts: [{ type: "text", text: "start" }],
        })
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model,
          auto: false,
        })
        const result = await SessionPrompt.loop({ sessionID: session.id })
        const msgs = await Session.messages({ sessionID: session.id })
        const summary = msgs.find((msg) => msg.info.role === "assistant" && msg.info.summary === true)
        const after = msgs.filter((msg) => msg.info.role === "user" && msg.info.id > user.info.id)

        expect(result.info.role).toBe("assistant")
        expect(summary?.parts.some((part) => part.type === "text" && part.text === "manual summary")).toBe(true)
        expect(after).toHaveLength(1)
        expect(after[0]?.parts.some((part) => part.type === "compaction" && !part.auto)).toBe(true)
        expect(main(srv.hits).length).toBe(1)
      },
    })
  })

  test("stops when the compaction request also exceeds context", async () => {
    const srv = await stub([
      { type: "text", text: "first answer", usage: { input: 82, output: 1 } },
      {
        type: "error",
        status: 400,
        body: {
          error: {
            message: "This request exceeds the context window.",
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
        },
      },
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
          parts: [{ type: "text", text: "start" }],
        })
        const msgs = await Session.messages({ sessionID: session.id })
        const failed = msgs.find((msg) => msg.info.role === "assistant" && msg.info.summary === true)
        const tasks = msgs.flatMap((msg) => msg.parts.filter((part) => part.type === "compaction"))

        expect(failed?.info.role).toBe("assistant")
        if (failed?.info.role === "assistant") {
          expect(failed.info.finish).toBe("error")
          expect(MessageV2.ContextOverflowError.isInstance(failed.info.error)).toBe(true)
        }
        expect(tasks).toHaveLength(1)
        expect(main(srv.hits).length).toBe(2)
      },
    })
  })

  test("context overflow compaction replays the overflowing user turn with media stripped", async () => {
    const srv = await stub([
      { type: "text", text: "baseline answer", usage: { input: 8, output: 2 } },
      {
        type: "error",
        status: 400,
        body: {
          error: {
            message: "This request exceeds the context window.",
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
        },
      },
      { type: "text", text: "overflow summary", usage: { input: 12, output: 2 } },
      { type: "text", text: "replayed answer", usage: { input: 12, output: 2 } },
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
          parts: [{ type: "text", text: "baseline" }],
        })

        const file = path.join(tmp.path, "pic.png")
        await Bun.write(file, "fake image")
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          parts: [
            { type: "text", text: "describe this image" },
            {
              type: "file",
              mime: "image/png",
              filename: "pic.png",
              url: pathToFileURL(file).href,
            },
          ],
        })
        const msgs = await Session.messages({ sessionID: session.id })
        const compact = msgs.find((msg) => msg.parts.some((part) => part.type === "compaction"))
        const body = JSON.stringify(srv.hits.map((hit) => hit.body))

        expect(result.info.role).toBe("assistant")
        expect(texts([result])).toContain("replayed answer")
        expect(compact?.parts.some((part) => part.type === "compaction" && part.auto && part.overflow)).toBe(true)
        expect(body).toContain("[Attached image/png: pic.png]")
        expect(main(srv.hits).length).toBe(4)
      },
    })
  })

  test("runs tool calls through a second llm step with tool results in context", async () => {
    const srv = await stub([
      {
        type: "tool",
        tool: "todowrite",
        input: {
          todos: [
            {
              id: "todo-1",
              content: "write a test",
              status: "pending",
              priority: "medium",
            },
          ],
        },
        usage: { input: 10, output: 2 },
      },
      { type: "text", text: "tool complete", usage: { input: 12, output: 2 } },
    ])
    await using tmp = await setup(srv.url)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          tools: { todowrite: true },
          parts: [{ type: "text", text: "update todos" }],
        })
        const msgs = await Session.messages({ sessionID: session.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool" && part.tool === "todowrite")
        const bodies = main(srv.hits).map((hit) => JSON.stringify(hit.body))

        expect(result.info.role).toBe("assistant")
        expect(texts([result])).toContain("tool complete")
        expect(part?.type).toBe("tool")
        if (part?.type === "tool") {
          expect(part.state.status).toBe("completed")
        }
        expect(main(srv.hits).length).toBe(2)
        expect(bodies[1]).toContain("tool")
        expect(bodies[1]).toContain("todo-1")
      },
    })
  })

  test("uses the compacted summary instead of old pre-compaction messages on later turns", async () => {
    const srv = await stub([{ type: "text", text: "after compaction", usage: { input: 12, output: 2 } }])
    await using tmp = await setup(srv.url)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          noReply: true,
          parts: [{ type: "text", text: "old prompt that should be trimmed" }],
        })
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model,
          auto: true,
        })
        const msgs = await Session.messages({ sessionID: session.id })
        const compact = msgs.find((msg) => msg.parts.some((part) => part.type === "compaction"))
        if (!compact) throw new Error("missing compaction message")
        const summary = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: session.id,
          parentID: compact.info.id,
          mode: "compaction",
          agent: "compaction",
          summary: true,
          path: {
            cwd: tmp.path,
            root: tmp.path,
          },
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: mid,
          providerID: pid,
          time: {
            created: Date.now(),
            completed: Date.now(),
          },
          finish: "stop",
        })
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: summary.id,
          sessionID: session.id,
          type: "text",
          text: "summary that should remain",
        })

        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model,
          parts: [{ type: "text", text: "new prompt" }],
        })
        const body = JSON.stringify(main(srv.hits).at(0)?.body)

        expect(body).toContain("summary that should remain")
        expect(body).toContain("new prompt")
        expect(body).not.toContain("old prompt that should be trimmed")
      },
    })
  })
})
