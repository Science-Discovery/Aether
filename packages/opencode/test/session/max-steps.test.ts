import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

Log.init({ print: false })

const pid = ProviderID.make("steps-local")
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

function stream(items: unknown[]) {
  return new Response([line(chunk({})), ...items, line("done")].join(""), {
    headers: { "Content-Type": "text/event-stream" },
  })
}

function text(text: string) {
  return [line(chunk({ text })), line(chunk({ finish: "stop" }))]
}

function toolCall(name: string) {
  return [
    line(
      chunk({
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_test",
              type: "function",
              function: { name, arguments: "" },
            },
          ],
        },
      }),
    ),
    line(chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } })),
    line(chunk({ finish: "tool_calls" })),
  ]
}

async function setup(url: string, cfg: Record<string, unknown>) {
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
              name: "Steps Local",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: {
                [mid]: {
                  name: "Tiny",
                  tool_call: true,
                  temperature: true,
                  limit: { context: 100, output: 20 },
                  modalities: { input: ["text"], output: ["text"] },
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

function advertised(body: Record<string, unknown>) {
  return Array.isArray(body.tools) ? body.tools.length : 0
}

describe("agent step limit", () => {
  test("final step strips tools, forces a text summary, and ends the turn", async () => {
    const hits: Array<Record<string, unknown>> = []
    const server = await serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        if (JSON.stringify(body).includes("Generate a title for this conversation")) return stream(text("Steps Test"))
        hits.push(body)
        if (advertised(body) === 0) return stream(text("step limit summary"))
        return stream(toolCall("glob"))
      },
    })
    servers.push(server)
    await using tmp = await setup(`${server.url.origin}/v1`, { agent: { build: { steps: 2 } } })

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

        expect(result.info.role).toBe("assistant")
        if (result.info.role !== "assistant") throw new Error("expected assistant message")
        expect(result.info.finish).not.toBe("tool-calls")
        expect(hits).toHaveLength(2)
        expect(advertised(hits[0])).toBeGreaterThan(0)
        expect(advertised(hits[1])).toBe(0)
      },
    })
  })

  test("a tool-calls finish on the final step terminates instead of looping", async () => {
    const hits: Array<Record<string, unknown>> = []
    const server = await serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        if (JSON.stringify(body).includes("Generate a title for this conversation")) return stream(text("Steps Test"))
        hits.push(body)
        return stream(toolCall("nonexistent_tool"))
      },
    })
    servers.push(server)
    await using tmp = await setup(`${server.url.origin}/v1`, { agent: { build: { steps: 2 } } })

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

        expect(result.info.role).toBe("assistant")
        expect(advertised(hits[1])).toBe(0)
        expect(hits).toHaveLength(2)
      },
    })
  })
})
