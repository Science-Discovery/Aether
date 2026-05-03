import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { tool, type ModelMessage } from "ai"
import z from "zod"
import { LLM } from "../../src/session/llm"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { ModelsDev } from "../../src/provider/models"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { serve } from "../lib/server"
import { ToolRegistry } from "../../src/tool/registry"
import { Tool } from "../../src/tool/tool"

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{ path: string; response: Response; resolve: (value: Capture) => void }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

beforeAll(() => {
  return serve({
    port: 0,
    async fetch(req: Request) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return next.response
    },
  }).then((server) => {
    state.server = server
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  state.server?.stop()
})

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createToolCallStream(input: { id: string; name: string; args: Record<string, unknown>; finish: string }) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-tool",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-tool",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: input.id,
                  type: "function",
                  function: {
                    name: input.name,
                    arguments: JSON.stringify(input.args),
                  },
                },
              ],
            },
            finish_reason: input.finish,
          },
        ],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
  const data = await Filesystem.readJson<Record<string, ModelsDev.Provider>>(fixturePath)
  const provider = data[providerID]
  if (!provider) {
    throw new Error(`Missing provider in fixture: ${providerID}`)
  }
  const model = provider.models[modelID]
  if (!model) {
    throw new Error(`Missing model in fixture: ${modelID}`)
  }
  return { provider, model }
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session.llm.stream", () => {
  test("continues loop when provider returns stop with tool calls", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "loopcheck"
    const modelID = "loop-model"
    const calls: string[] = []
    const first = waitRequest(
      "/chat/completions",
      new Response(
        createToolCallStream({
          id: "call_loopcheck",
          name: "loopcheck",
          args: { value: "first" },
          finish: "stop",
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    )
    const second = waitRequest(
      "/chat/completions",
      new Response(createChatStream("done"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      git: true,
      config: {
        enabled_providers: [providerID],
        provider: {
          [providerID]: {
            name: "Loop Check",
            npm: "@ai-sdk/openai-compatible",
            api: `${server.url.origin}/v1`,
            models: {
              [modelID]: {
                name: "Loop Model",
                tool_call: true,
                temperature: false,
                release_date: "2026-01-01",
                modalities: { input: ["text"], output: ["text"] },
                limit: { context: 100_000, output: 4_096 },
              },
            },
            options: {
              apiKey: "test-loop-key",
              baseURL: `${server.url.origin}/v1`,
            },
          },
        },
        agent: {
          build: {
            model: `${providerID}/${modelID}`,
            permission: {
              loopcheck: "allow",
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.register(
          Tool.define("loopcheck", {
            description: "Record a loop check.",
            parameters: z.object({
              value: z.string(),
            }),
            async execute(params) {
              calls.push(params.value)
              return {
                title: "Loop checked",
                output: `checked ${params.value}`,
                metadata: {},
              }
            },
          }),
        )

        const session = await Session.create({ title: "Loop check" })
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "call loopcheck then finish" }],
        })

        const one = await first
        const two = await second
        const messages = await Session.messages({ sessionID: session.id })
        const assistants = messages.filter(
          (msg): msg is MessageV2.WithParts & { info: MessageV2.Assistant } => msg.info.role === "assistant",
        )
        const final = result.info

        expect(one.body.tools).toBeArray()
        expect(two.body.messages).toBeArray()
        expect(JSON.stringify(two.body.messages)).toContain("checked first")
        expect(calls).toEqual(["first"])
        expect(assistants).toHaveLength(2)
        expect(assistants[0].info.finish).toBe("tool-calls")
        if (final.role !== "assistant") throw new Error("expected assistant response")
        expect(final.finish).toBe("stop")

        await Session.remove(session.id)
      },
    })
  })

  test("sends temperature, tokens, and reasoning options for openai-compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const provider = fixture.provider
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          variant: "high",
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      },
    })
  })

  test("strips reasoning summary options from chat completions requests", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-chat-reasoning")
        const agent = {
          name: "test",
          mode: "primary",
          options: {
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-chat-reasoning"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          variant: "high",
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(body.reasoningSummary).toBeUndefined()
        expect(body.reasoning_summary).toBeUndefined()
        expect(body.include).toBeUndefined()

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      },
    })
  })

  test("keeps tools enabled by prompt permissions", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          tools: { question: true },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          permission: [{ permission: "question", pattern: "*", action: "allow" }],
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            question: tool({
              description: "Ask a question",
              inputSchema: z.object({}),
              execute: async () => ({ output: "" }),
            }),
          },
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.some((item) => item.function?.name === "question")).toBe(true)
      },
    })
  })

  test("sends responses API payload for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model

    const responseChunks = [
      {
        type: "response.created",
        response: {
          id: "resp-1",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-1",
        delta: "Hello",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(responseChunks, true))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.openai, ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id },
          variant: "high",
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")

        const maxTokens = body.max_output_tokens as number | undefined
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)
      },
    })
  })

  test("routes GPT-5.5 tool calls with reasoning effort to responses", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "maas"
    const modelID = "gpt-5.5"
    const chunks = [
      {
        type: "response.created",
        response: {
          id: "resp-gpt-55-tools",
          created_at: Math.floor(Date.now() / 1000),
          model: modelID,
          service_tier: null,
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "item-gpt-55-tools" },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-gpt-55-tools",
        delta: "ok",
        logprobs: null,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "item-gpt-55-tools" },
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(chunks, true))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                name: "OpenAI-compatible proxy",
                npm: "@ai-sdk/openai-compatible",
                api: `${server.url.origin}/v1`,
                models: {
                  [modelID]: {
                    id: modelID,
                    name: "GPT-5.5",
                    reasoning: true,
                    tool_call: true,
                    temperature: false,
                    release_date: "2026-04-01",
                    modalities: { input: ["text"], output: ["text"] },
                    limit: { context: 400_000, output: 128_000 },
                  },
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(modelID))
        const sessionID = SessionID.make("session-test-maas-gpt-55-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-maas-gpt-55-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          variant: "high",
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Use the lookup tool." }],
          tools: {
            lookup: tool({
              description: "Look up a short value by key.",
              inputSchema: z.object({
                key: z.string(),
              }),
              execute: async () => ({ output: "ok" }),
            }),
          },
          toolChoice: "required",
        })

        for await (const part of stream.fullStream) {
          if (part.type === "error") throw part.error
        }

        const capture = await request

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(capture.body.model).toBe(modelID)
        const tools = capture.body.tools as Array<{ function?: { name?: string }; name?: string }> | undefined
        expect(tools?.some((item) => (item.function?.name ?? item.name) === "lookup")).toBe(true)
        expect((capture.body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")
      },
    })
  })

  test("routes custom GPT-5.5 tool calls to responses", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "custom"
    const modelID = "gpt-5.5"
    const chunks = [
      {
        type: "response.created",
        response: {
          id: "resp-custom-gpt-55-tools",
          created_at: Math.floor(Date.now() / 1000),
          model: modelID,
          service_tier: null,
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "item-custom-gpt-55-tools" },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-custom-gpt-55-tools",
        delta: "ok",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(chunks, true))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                name: "Custom",
                npm: "@ai-sdk/openai-compatible",
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
                models: {
                  [modelID]: {
                    name: "GPT-5.5",
                  },
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(modelID))
        expect(resolved.api.npm).toBe("@ai-sdk/openai")

        const sessionID = SessionID.make("session-test-custom-gpt-55-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-custom-gpt-55-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          variant: "high",
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Use the lookup tool." }],
          tools: {
            lookup: tool({
              description: "Look up a short value by key.",
              inputSchema: z.object({
                key: z.string(),
              }),
              execute: async () => ({ output: "ok" }),
            }),
          },
          toolChoice: "required",
        })

        for await (const part of stream.fullStream) {
          if (part.type === "error") throw part.error
        }

        const capture = await request

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(capture.body.model).toBe(modelID)
        const tools = capture.body.tools as Array<{ function?: { name?: string }; name?: string }> | undefined
        expect(tools?.some((item) => (item.function?.name ?? item.name) === "lookup")).toBe(true)
        expect((capture.body.reasoning as { effort?: string } | undefined)?.effort).toBe("medium")
      },
    })
  })

  test("sends messages API payload for Anthropic models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "anthropic"
    const modelID = "claude-3-5-sonnet-20241022"
    const fixture = await loadFixture(providerID, modelID)
    const provider = fixture.provider
    const model = fixture.model

    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-1",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBeUndefined()
      },
    })
  })

  test("sends Google API payload for Gemini models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "google"
    const modelID = "gemini-2.5-flash"
    const fixture = await loadFixture(providerID, modelID)
    const provider = fixture.provider
    const model = fixture.model
    const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      },
    ]
    const request = waitRequest(pathSuffix, createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-google-key",
                  baseURL: `${server.url.origin}/v1beta`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      },
    })
  })
})
