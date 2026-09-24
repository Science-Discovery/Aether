import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Memory } from "../../src/memory"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
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
  error?: string
}

type Hit = {
  body: Record<string, unknown>
}

const pid = ProviderID.make("alibaba-cn")
const mid = ModelID.make("glm-5.2")
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
  const parts: string[] = [
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
    ...(item.error ? [line({ error: { message: item.error } })] : []),
    line(chunk({}, item.finish ?? "stop")),
    line("done"),
  ]
  const body = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      for (let i = 0; i < parts.length; i++) {
        controller.enqueue(enc.encode(parts[i]))
        // spacing lets the consumer take the step snapshot before the tool runs
        if (item.error && i === 0) await new Promise((r) => setTimeout(r, 300))
        if (item.error && i === 1) await new Promise((r) => setTimeout(r, 500))
      }
      controller.close()
    },
  })
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  })
}

async function setup(items: Item[], id: string = mid) {
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
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [pid],
            permission: {
              edit: "allow",
            },
            provider: {
              [pid]: {
                npm: "@ai-sdk/openai-compatible",
                models: {
                  [id]: {
                    name: id === mid ? "GLM-5.2" : "GLM-5.3",
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

async function prompt(dir: string, id: string = mid) {
  return Instance.provide({
    directory: dir,
    fn: async () => {
      const session = await Session.create({ title: "GLM recovery" })
      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: pid, modelID: ModelID.make(id) },
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
    const srv = await setup([
      { reasoning: "first thought", finish: "length" },
      { reasoning: "second thought", finish: "length" },
    ])
    await using tmp = srv.tmp
    const result = await prompt(tmp.path)

    expect(srv.hits).toHaveLength(2)
    expect(parts(result, "reasoning")).toEqual(["first thought", "second thought"])
    expect(parts(result, "text")).toEqual([
      '[Response truncated: the model exhausted its output budget before finishing. Send a follow-up like "continue" to resume from where it stopped.]',
    ])
  })
})

describe("session processor GLM-5.3 output budget", () => {
  const id = "glm-5.3"

  test("does not inject thinking_budget and surfaces truncation for a cut-off answer", async () => {
    const srv = await setup([{ reasoning: "deep thought", text: "partial answer", finish: "length" }], id)
    await using tmp = srv.tmp
    const result = await prompt(tmp.path, id)

    expect(srv.hits).toHaveLength(1)
    expect(srv.hits[0].body.enable_thinking).toBe(true)
    expect(srv.hits[0].body.thinking_budget).toBeUndefined()
    expect(srv.hits[0].body.max_tokens).toBe(131_072)
    expect(parts(result, "text")).toEqual([
      "partial answer",
      '[Response truncated: the model exhausted its output budget before finishing. Send a follow-up like "continue" to resume from where it stopped.]',
    ])
  })

  test("retries a reasoning-only response without the budget and stays quiet on success", async () => {
    const srv = await setup([{ reasoning: "internal work", finish: "length" }, { text: "final answer" }], id)
    await using tmp = srv.tmp
    const result = await prompt(tmp.path, id)

    expect(srv.hits).toHaveLength(2)
    expect(srv.hits[0].body.thinking_budget).toBeUndefined()
    expect(srv.hits[1].body.thinking_budget).toBeUndefined()
    expect(srv.hits[1].body.reasoning_effort).toBe("low")
    expect(parts(result, "text")).toEqual(["final answer"])
  })

  test("persists the failed round's file changes when a retryable error interrupts the step", async () => {
    const name = "retry-patch.txt"
    const srv = await setup([
      { tool: { name: "write", input: { filePath: name, content: "failed round" } }, error: "socket hang up" },
      { text: "recovered" },
    ])
    await using tmp = srv.tmp

    const messages = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "retry patch" })
        await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: pid, modelID: ModelID.make(mid) },
          parts: [{ type: "text", text: "Write the file." }],
        })
        const all = await Session.messages({ sessionID: session.id })
        const user = all.find((msg) => msg.info.role === "user")
        if (!user) throw new Error("missing user message")
        await SessionRevert.revert({ sessionID: session.id, messageID: user.info.id })
        await Instance.dispose()
        return all
      },
    })

    expect(srv.hits).toHaveLength(2)
    const target = path.join(tmp.path, name).replaceAll("\\", "/")
    const patches = messages.flatMap((msg) => msg.parts.filter((part) => part.type === "patch"))
    expect(patches.some((part) => part.files.includes(target))).toBe(true)
    expect(await Bun.file(target).exists()).toBe(false)
  }, 30_000)
})
