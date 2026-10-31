import { describe, expect, test } from "bun:test"
import path from "path"
import { Config } from "../../src/config/config"
import { Knowledge, Storage } from "../../src/knowledge"
import { Server } from "../../src/server/server"
import { KnowledgeTool, setKnowledgeConfig, hasKnowledge } from "../../src/tool/knowledge"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { features } from "../fixture/features"
import { tmpdir } from "../fixture/fixture"
import { serve } from "../lib/server"

const app = Server.Default()

async function request(url: string, data: unknown) {
  return app.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
}

function config(dir: string) {
  return {
    path: dir,
    name: "feature test",
    embeddingProvider: "openai" as const,
    embeddingModel: "unused-test-model",
    embeddingDimensions: 4,
    apiKey: "unused-test-key",
  }
}

describe("knowledge master switch", () => {
  for (const enabled of [undefined, false]) {
    test(`rejects all new processing when disabled (${enabled})`, async () => {
      await using global = await features({ knowledge: { enabled } })
      await using dir = await tmpdir({ config: { knowledge: { enabled: true } } })
      const base = `/knowledge/${encodeURIComponent(dir.path)}`
      for (const [url, data] of [
        ["/knowledge", config(dir.path)],
        [`${base}/import`, { paths: [path.join(dir.path, "source.txt")] }],
        [`${base}/sync`, {}],
        [`${base}/search`, { query: "test" }],
      ] as const) {
        const response = await request(url, data)
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: "Knowledge base feature is disabled" })
      }
      expect(await Storage.isKnowledgeBase(dir.path)).toBe(false)
      const updated = await app.request(`${base}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeddingModel: "unknown" }),
      })
      expect(updated.status).toBe(403)
      for (const url of ["/knowledge/state", "/knowledge/config", "/knowledge/models"]) {
        const response = await app.request(url)
        expect(response.status).toBe(200)
        if (url === "/knowledge/state") expect(await response.json()).toEqual({ knowledgeBases: [], activeIds: [] })
      }
    })
  }

  test("keeps stored knowledge and management available across disabling", async () => {
    await using global = await features({ knowledge: { enabled: true } })
    await using dir = await tmpdir()
    const created = await request("/knowledge", config(dir.path))
    expect(created.status).toBe(200)
    expect(await Storage.isKnowledgeBase(dir.path)).toBe(true)
    const base = `/knowledge/${encodeURIComponent(dir.path)}`
    expect((await request(`${base}/search`, { query: "empty" })).status).toBe(200)
    await Config.updateGlobal({ knowledge: { enabled: false } })
    expect((await request(`${base}/search`, { query: "empty" })).status).toBe(403)
    expect((await app.request(base)).status).toBe(200)
    expect(await Storage.isKnowledgeBase(dir.path)).toBe(true)
    await Config.updateGlobal({ knowledge: { enabled: true } })
    expect((await request(`${base}/search`, { query: "empty" })).status).toBe(200)
    await Config.updateGlobal({ knowledge: { enabled: false } })
    expect((await app.request(base, { method: "DELETE" })).status).toBe(200)
    expect(await Storage.isKnowledgeBase(dir.path)).toBe(false)
  })

  test("tool execution rechecks the master even for a previously mounted session", async () => {
    await using global = await features({ knowledge: { enabled: true } })
    await using dir = await tmpdir()
    await Knowledge.create(config(dir.path))
    const session = SessionID.descending()
    setKnowledgeConfig({ paths: [dir.path] }, session)
    await Config.updateGlobal({ knowledge: { enabled: false } })
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const tool = await KnowledgeTool.init()
        const result = await tool.execute(
          { query: "test", topK: 5 },
          {
            sessionID: session,
            messageID: MessageID.ascending(),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata() {},
            async ask() {},
          },
        )
        expect(result.title).toBe("Knowledge base disabled")
        expect(result.metadata.configured).toBe(false)
      },
    })
    setKnowledgeConfig(null, session)
  })

  test("an admitted search can finish while new searches are rejected", async () => {
    await using global = await features({ knowledge: { enabled: true } })
    await using dir = await tmpdir()
    const index = await Knowledge.create(config(dir.path))
    const now = Date.now()
    index.documents.push({
      meta: {
        id: "doc",
        filePath: path.join(dir.path, "doc.txt"),
        fileName: "doc.txt",
        fileSize: 4,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      },
      chunks: [{ id: "chunk", documentId: "doc", index: 0, content: "test", embeddingOffset: 0, embeddingLength: 4 }],
    })
    index.stats = { totalDocuments: 1, totalChunks: 1 }
    await Storage.saveIndex(dir.path, index)
    await Storage.appendEmbeddings(dir.path, [new Float32Array([1, 0, 0, 0])])
    const started = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const server = await serve({
      port: 0,
      async fetch() {
        started.resolve()
        await resume.promise
        return Response.json({ data: [{ embedding: [1, 0, 0, 0], index: 0 }] })
      },
    })
    try {
      const url = `/knowledge/${encodeURIComponent(dir.path)}/search`
      const search = request(url, { query: "test", baseURL: server.url.origin })
      await Promise.race([
        started.promise,
        search.then(() => {
          throw new Error("Search ended before reaching the test embedding endpoint")
        }),
      ])
      await Config.updateGlobal({ knowledge: { enabled: false } })
      expect((await request(url, { query: "next", baseURL: server.url.origin })).status).toBe(403)
      resume.resolve()
      const response = await search
      expect(response.status).toBe(200)
      expect(await response.json()).toHaveLength(1)
    } finally {
      resume.resolve()
      server.stop(true)
    }
  })

  test("disabled prompts drop stale knowledge without calling a model", async () => {
    await using global = await features({ knowledge: { enabled: true } })
    await using dir = await tmpdir({ config: { knowledge: { enabled: true } } })
    await Knowledge.create(config(dir.path))
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({})
        const prompt = () =>
          SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: ProviderID.make("unused"), modelID: ModelID.make("unused") },
            agent: "build",
            noReply: true,
            knowledgeBase: { paths: [dir.path] },
            parts: [{ type: "text", text: "test" }],
          })
        await prompt()
        expect(hasKnowledge(session.id)).toBe(true)
        await Config.updateGlobal({ knowledge: { enabled: false } })
        await prompt()
        expect(hasKnowledge(session.id)).toBe(false)
        expect((await Session.messages({ sessionID: session.id })).every((item) => item.info.role === "user")).toBe(
          true,
        )
        await Session.remove(session.id)
      },
    })
  })
})
