import path from "path"
import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { hasKnowledge, getKnowledgeConfig } from "../../src/tool/knowledge"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

Log.init({ print: false })

namespace harness {
  export const pid = ProviderID.make("busy-local")
  export const mid = ModelID.make("tiny")
  export const model = { providerID: pid, modelID: mid }

  function line(input: unknown) {
    if (input === "done") return "data: [DONE]\n\n"
    return `data: ${JSON.stringify(input)}\n\n`
  }

  function chunk(input: { text?: string; finish?: string }) {
    return {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [
        {
          delta: input.text ? { content: input.text } : {},
          ...(input.finish ? { finish_reason: input.finish } : {}),
        },
      ],
    }
  }

  function sse(text: string) {
    return new Response([line(chunk({ text })), line(chunk({ finish: "stop" })), line("done")].join(""), {
      headers: { "Content-Type": "text/event-stream" },
    })
  }

  export function llm(delay: number) {
    return serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.endsWith("/embeddings")) {
          await sleep(delay)
          return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] })
        }
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        if (JSON.stringify(body).includes("Generate a title for this conversation")) return sse("Busy Test")
        await sleep(delay)
        return sse("ok")
      },
    })
  }

  export async function seedKnowledgeBase(dir: string) {
    const kbDir = path.join(dir, ".aether-kb")
    await mkdir(kbDir, { recursive: true })
    const now = Date.now()
    await Bun.write(
      path.join(kbDir, "index.json"),
      JSON.stringify({
        version: 1,
        config: {
          id: "kb-busy-test",
          name: "busy-test",
          path: dir,
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-test",
          embeddingDimensions: 4,
          chunkSize: 512,
          chunkOverlap: 50,
          createdAt: now,
          updatedAt: now,
        },
        documents: [
          {
            meta: {
              id: "doc1",
              filePath: path.join(dir, "doc.md"),
              fileName: "doc.md",
              fileSize: 5,
              status: "ready",
              createdAt: now,
              updatedAt: now,
            },
            chunks: [
              { id: "c1", documentId: "doc1", index: 0, content: "hello", embeddingOffset: 0, embeddingLength: 4 },
            ],
          },
        ],
        stats: { totalDocuments: 1, totalChunks: 1 },
      }),
    )
    await Bun.write(path.join(kbDir, "embedding.bin"), new Uint8Array(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer))
  }

  export function providerConfig(origin: string) {
    return {
      $schema: "https://opencode.ai/config.json",
      provider: {
        [pid]: {
          name: "Busy Local",
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
            baseURL: `${origin}/v1`,
          },
        },
      },
    }
  }
}

describe("session.prompt busy claim", () => {
  test("concurrent prompt fails with BusyError without persisting an orphan message", async () => {
    const server = await harness.llm(800)
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify(harness.providerConfig(server.url.origin)))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const first = SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          parts: [{ type: "text", text: "first" }],
        })
        const second = SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          parts: [{ type: "text", text: "second" }],
        })

        const settled = await Promise.allSettled([first, second])
        const fulfilled = settled.filter((r) => r.status === "fulfilled")
        const rejected = settled.filter((r) => r.status === "rejected")
        expect(fulfilled.length).toBe(1)
        expect(rejected.length).toBe(1)
        if (fulfilled[0].status === "fulfilled") {
          expect(fulfilled[0].value.info.role).toBe("assistant")
        }
        if (rejected[0].status === "rejected") {
          expect(rejected[0].reason).toBeInstanceOf(Session.BusyError)
        }

        const msgs = await Session.messages({ sessionID: session.id })
        const users = msgs.filter((m) => m.info.role === "user")
        expect(users.length).toBe(1)

        const again = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          parts: [{ type: "text", text: "after" }],
        })
        expect(again.info.role).toBe("assistant")

        await Session.remove(session.id)
      },
    })
    server.stop(true)
  }, 30000)

  test("rejected concurrent prompt does not clobber knowledge config", async () => {
    const server = await harness.llm(800)
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify(harness.providerConfig(server.url.origin)))
        await harness.seedKnowledgeBase(dir)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const winner = SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          knowledgeBase: { paths: [tmp.path], apiKey: "test-key", baseURL: server.url.origin },
          parts: [{ type: "text", text: "kb winner" }],
        })

        for (let i = 0; i < 100 && !hasKnowledge(session.id); i++) await sleep(20)
        expect(hasKnowledge(session.id)).toBe(true)

        const loser = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          parts: [{ type: "text", text: "no kb loser" }],
        }).then(
          () => undefined,
          (e) => e,
        )
        expect(loser).toBeInstanceOf(Session.BusyError)

        await winner
        expect(hasKnowledge(session.id)).toBe(true)
        expect(getKnowledgeConfig(session.id)?.paths).toEqual([tmp.path])

        await Session.remove(session.id)
      },
    })
    server.stop(true)
  }, 30000)

  test("cancel during prep does not let the stale prompt adopt a newer prompt's claim", async () => {
    const server = await harness.llm(1500)
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify(harness.providerConfig(server.url.origin)))
        await harness.seedKnowledgeBase(dir)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const stale = SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          knowledgeBase: { paths: [tmp.path], apiKey: "test-key", baseURL: server.url.origin },
          parts: [{ type: "text", text: "stale prompt" }],
        }).then(
          () => undefined,
          (e) => e,
        )

        for (let i = 0; i < 100 && !hasKnowledge(session.id); i++) await sleep(20)
        expect(hasKnowledge(session.id)).toBe(true)
        await sleep(100)

        await SessionPrompt.cancel(session.id)

        const newer = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          parts: [{ type: "text", text: "newer prompt" }],
        })
        expect(newer.info.role).toBe("assistant")

        const outcome = await stale
        expect(outcome).toBeInstanceOf(Session.BusyError)

        const msgs = await Session.messages({ sessionID: session.id })
        expect(msgs.filter((m) => m.info.role === "user").length).toBe(2)
        // the single active loop also answers the stale persisted message, so
        // every user message gets exactly one reply (the adoption bug would
        // have two loops replying, producing an extra assistant message)
        expect(msgs.filter((m) => m.info.role === "assistant").length).toBe(2)

        const again = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          parts: [{ type: "text", text: "after" }],
        })
        expect(again.info.role).toBe("assistant")

        await Session.remove(session.id)
      },
    })
    server.stop(true)
  }, 30000)

  test("noReply prompt releases the busy claim", async () => {
    const server = await harness.llm(0)
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify(harness.providerConfig(server.url.origin)))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          noReply: true,
          parts: [{ type: "text", text: "no reply" }],
        })
        expect(msg.info.role).toBe("user")

        const next = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: harness.model,
          parts: [{ type: "text", text: "follow up" }],
        })
        expect(next.info.role).toBe("assistant")

        await Session.remove(session.id)
      },
    })
    server.stop(true)
  }, 30000)
})
