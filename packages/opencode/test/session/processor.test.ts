import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Memory } from "../../src/memory"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

type Item = {
  reasoning?: string
  text?: string
  finish?: "stop" | "length"
  tool?: {
    name: string
    input: Record<string, unknown>
  }
}

type Hit = {
  body: Record<string, unknown>
}

const pid = ProviderID.make("alibaba-cn")
const mid = ModelID.make("glm-5.2")
const model = { providerID: pid, modelID: mid }
const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(async () => {
  await Memory.stop()
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

function line(input: unknown) {
  if (input === "done") return "data: [DONE]\n\n"
  return `data: ${JSON.stringify(input)}\n\n`
}

function chunk(delta: Record<string, unknown>, finish?: Item["finish"]) {
  return {
    id: "chatcmpl-glm-52",
    object: "chat.completion.chunk",
    choices: [
      {
        delta,
        ...(finish ? { finish_reason: finish } : {}),
      },
    ],
    ...(finish
      ? {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            completion_tokens_details: { reasoning_tokens: 4 },
          },
        }
      : {}),
  }
}

function stream(item: Item) {
  const body = [
    line(chunk({ role: "assistant" })),
    ...(item.reasoning ? [line(chunk({ reasoning_content: item.reasoning }))] : []),
    ...(item.text ? [line(chunk({ content: item.text }))] : []),
    ...(item.tool
      ? [
          line(
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: "call_glm_52",
                  type: "function",
                  function: { name: item.tool.name, arguments: JSON.stringify(item.tool.input) },
                },
              ],
            }),
          ),
        ]
      : []),
    line(chunk({}, item.finish ?? "stop")),
    line("done"),
  ].join("")
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  })
}

async function setup(items: Item[]) {
  const hits: Hit[] = []
  const queue = [...items]
  const server = await serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>
      hits.push({ body })
      const item = queue.shift()
      if (!item) return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 })
      return stream(item)
    },
  })
  servers.push(server)
  return {
    hits,
    tmp: await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [pid],
            provider: {
              [pid]: {
                npm: "@ai-sdk/openai-compatible",
                models: {
                  [mid]: {
                    name: "GLM-5.2",
                    reasoning: true,
                    tool_call: true,
                    temperature: true,
                    interleaved: { field: "reasoning_content" },
                    limit: { context: 1_000_000, output: 131_072 },
                    modalities: { input: ["text"], output: ["text"] },
                  },
                },
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    }),
  }
}

async function prompt(dir: string) {
  return Instance.provide({
    directory: dir,
    fn: async () => {
      const session = await Session.create({ title: "GLM recovery" })
      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        agent: "build",
        model,
        parts: [{ type: "text", text: "Answer briefly." }],
      })
      await Instance.dispose()
      return result
    },
  })
}

function parts(msg: MessageV2.WithParts, type: "text" | "reasoning") {
  return msg.parts.flatMap((part) => (part.type === type ? [part.text] : []))
}

describe("session processor GLM-5.2 recovery", () => {
  test("retries a reasoning-only response once with replayed reasoning and low effort", async () => {
    const srv = await setup([{ reasoning: "internal work", finish: "length" }, { text: "final answer" }])
    await using tmp = srv.tmp
    const result = await prompt(tmp.path)

    expect(srv.hits).toHaveLength(2)
    expect(srv.hits[0].body.enable_thinking).toBe(true)
    expect(srv.hits[0].body.thinking_budget).toBe(32_000)
    expect(srv.hits[1].body.enable_thinking).toBe(true)
    expect(srv.hits[1].body.thinking_budget).toBeUndefined()
    expect(srv.hits[1].body.reasoning_effort).toBe("low")
    const retry = srv.hits[1].body.messages as Array<{ role: string; content: unknown }>
    const replay = retry.at(-2)
    expect(replay?.role).toBe("assistant")
    expect(String(replay?.content)).toContain("internal work")
    const nudge = retry.at(-1)
    expect(nudge?.role).toBe("user")
    expect(String(nudge?.content)).toContain("Continue from where your previous reasoning was cut off")
    expect(parts(result, "reasoning")).toContain("internal work")
    expect(parts(result, "text")).toContain("final answer")
  })

  test("does not retry a normal text response", async () => {
    const srv = await setup([{ reasoning: "short thought", text: "visible answer" }])
    await using tmp = srv.tmp
    const result = await prompt(tmp.path)

    expect(srv.hits).toHaveLength(1)
    expect(parts(result, "text")).toContain("visible answer")
  })

  test("does not treat a tool step as a reasoning-only failure", async () => {
    const srv = await setup([
      { reasoning: "need the file", tool: { name: "read", input: { filePath: "opencode.json" } } },
      { text: "tool finished" },
    ])
    await using tmp = srv.tmp
    const result = await prompt(tmp.path)

    expect(srv.hits).toHaveLength(2)
    expect(srv.hits[1].body.enable_thinking).toBe(true)
    expect(srv.hits[1].body.thinking_budget).toBe(32_000)
    expect(parts(result, "text")).toContain("tool finished")
  })

  test("stops after one recovery attempt when visible text is still missing", async () => {
    const srv = await setup([{ reasoning: "first thought" }, { reasoning: "second thought" }])
    await using tmp = srv.tmp
    const result = await prompt(tmp.path)

    expect(srv.hits).toHaveLength(2)
    expect(parts(result, "reasoning")).toEqual(["first thought", "second thought"])
    expect(parts(result, "text")).toEqual([])
  })
})
