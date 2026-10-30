import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { NativeResearch } from "../../src/native/research"
import { NativeModes } from "../../src/native/modes"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { Session } from "../../src/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { PdfAnnotations } from "../../src/pdf-annotations"
import { Storage } from "../../src/knowledge/storage"
import { setKnowledgeConfig } from "../../src/tool/knowledge"
import { OpenAIEmbedder, CustomEmbedder } from "../../src/knowledge/embedding"
import { tmpdir } from "../fixture/fixture"

function request(tool: string, args: unknown) {
  return { threadId: "thread", turnId: "turn", callId: "call", namespace: null, tool, arguments: args }
}

async function call(id: SessionID, tool: string, args: unknown, signal = new AbortController().signal) {
  const result = await NativeResearch.call(id, request(tool, args), signal)
  return { success: result.success, text: result.contentItems[0].text }
}

async function message(id: SessionID, text: string, synthetic = false) {
  const mid = MessageID.ascending()
  await Session.updateMessage({
    id: mid,
    sessionID: id,
    role: "user",
    time: { created: Date.now() },
    agent: "codex",
    model: { providerID: ProviderID.make("codex-native"), modelID: ModelID.make("test") },
  })
  await Session.updatePart({ id: PartID.ascending(), messageID: mid, sessionID: id, type: "text", text, synthetic })
}

test("research sessions stay in the current project and expose only bounded display text", async () => {
  await using dir = await tmpdir()
  await using other = await tmpdir()
  const foreign = await Instance.provide({
    directory: other.path,
    fn: () => Session.create({ title: "Research outside" }),
  })
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const root = await Session.create({ engine: { type: "codex" }, title: "Root" })
        const child = await Session.create({ title: "Research inside" })
        await message(child.id, "Research result")
        await message(child.id, "Hidden synthetic context", true)
        const search = await call(root.id, "aether_session_search", { query: "Research" })
        expect(search.success).toBe(true)
        expect(JSON.parse(search.text).sessions.map((item: { id: string }) => item.id)).toEqual([child.id])
        const read = await call(root.id, "aether_session_read", { session: child.id })
        expect(read.text).toContain("Research result")
        expect(read.text).not.toContain("Hidden synthetic")
        expect((await call(root.id, "aether_session_read", { session: foreign.id })).success).toBe(false)
        expect(
          (await call(root.id, "aether_session_search", { query: "Research", directory: other.path })).success,
        ).toBe(false)
        await message(child.id, "x".repeat(90_000))
        const bounded = await call(root.id, "aether_session_read", { session: child.id })
        expect(bounded.success).toBe(true)
        expect(bounded.text.length).toBeLessThan(64_000)
        expect(JSON.parse(bounded.text).messages.at(-1).truncated).toBe(true)
        const abort = AbortSignal.abort()
        expect((await call(root.id, "aether_session_search", { query: "Research" }, abort)).success).toBe(false)
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
    await Instance.disposeDirectory(other.path)
  }
})

test("PDF annotation reads are project-contained and do not migrate renamed annotations", async () => {
  await using dir = await tmpdir()
  await using other = await tmpdir()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const root = await Session.create({ engine: { type: "codex" } })
        const file = path.join(dir.path, "paper.pdf")
        await Bun.write(file, "%PDF test annotation bytes")
        await Bun.write(path.join(other.path, "outside.pdf"), "%PDF outside")
        await PdfAnnotations.write(file, {
          version: "1.2",
          source: { path: "paper.pdf", fingerprint: "" },
          annotations: [
            {
              id: "note",
              type: "note",
              color: "yellow",
              pages: [{ page: 2, quads: [[0, 0, 1, 0, 0, 1, 1, 1]] }],
              selectedText: "Formula",
              note: "Check this derivation",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        })
        const result = await call(root.id, "aether_pdf_annotations_read", { path: "paper.pdf" })
        expect(result.success).toBe(true)
        expect(JSON.parse(result.text).annotations[0]).toMatchObject({ note: "Check this derivation", pages: [2] })
        expect(
          (
            await call(root.id, "aether_pdf_annotations_read", {
              path: path.relative(dir.path, path.join(other.path, "outside.pdf")),
            })
          ).success,
        ).toBe(false)
        await fs.rename(file, path.join(dir.path, "renamed.pdf"))
        const stored = path.join(Global.Path.data, "pdf-annotations", Instance.project.id)
        const snapshot = async () =>
          Promise.all(
            (await fs.readdir(stored))
              .sort()
              .map(async (file) => [file, await Bun.file(path.join(stored, file)).text()]),
          )
        const before = await snapshot()
        const read = await call(root.id, "aether_pdf_annotations_read", { path: "renamed.pdf" })
        expect(JSON.parse(read.text).annotations[0].note).toBe("Check this derivation")
        expect(await snapshot()).toEqual(before)
        // The ordinary UI read can still migrate the original record: research did not delete or rewrite it.
        expect((await PdfAnnotations.read("renamed.pdf")).data.annotations[0].note).toBe("Check this derivation")
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
  }
})

test("knowledge tools use only session-selected bases and never expose embedding credentials", async () => {
  await using dir = await tmpdir()
  await using kb = await tmpdir()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ data: [{ index: 0, embedding: [1, 0] }] }),
  })
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const root = await Session.create({ engine: { type: "codex" } })
        const index = await Storage.init(kb.path, {
          id: "kb",
          name: "Selected",
          embeddingProvider: "custom",
          embeddingModel: "fixture",
          embeddingDimensions: 2,
          chunkSize: 512,
          chunkOverlap: 0,
          apiKey: "private-token",
          baseURL: server.url.toString(),
        })
        index.documents.push({
          meta: {
            id: "document",
            fileName: "paper.pdf",
            filePath: path.join(kb.path, "paper.pdf"),
            fileSize: 1,
            status: "ready",
            createdAt: 1,
            updatedAt: 1,
          },
          chunks: [
            {
              id: "chunk",
              documentId: "document",
              index: 0,
              content: "An indexed research finding",
              pageNumber: 3,
              embeddingOffset: 0,
              embeddingLength: 2,
            },
          ],
        })
        index.stats = { totalDocuments: 1, totalChunks: 1 }
        await Storage.saveIndex(kb.path, index)
        await Storage.appendEmbeddings(kb.path, [new Float32Array([1, 0])])
        setKnowledgeConfig({ paths: [kb.path] })
        expect(
          JSON.parse((await call(root.id, "aether_knowledge_search", { query: "research" })).text).configured,
        ).toBe(false)
        setKnowledgeConfig({ paths: [kb.path] }, root.id)
        try {
          const result = await call(root.id, "aether_knowledge_search", { query: "research" })
          expect(result.success).toBe(true)
          expect(JSON.parse(result.text).results[0]).toMatchObject({ text: "An indexed research finding", page: 3 })
          expect(result.text).not.toContain("private-token")
          expect(result.text).not.toContain(server.url.toString())
        } finally {
          setKnowledgeConfig(null, root.id)
        }
      },
    })
  } finally {
    await server.stop(true)
    setKnowledgeConfig(null)
    await Instance.disposeDirectory(dir.path)
  }
})

test("embedding cancellation does not fall back or retry the aborted request", async () => {
  const arrivals = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push(request.url)
      await request.text()
      arrivals.resolve()
      await release.promise
      return Response.json({ data: [{ index: 0, embedding: [1, 0] }] })
    },
  })
  try {
    const opts = { apiKey: "test", model: "fixture", dimensions: 2, baseURL: server.url.toString() }
    const controller = new AbortController()
    const pending = new OpenAIEmbedder(opts).embed(["query"], controller.signal)
    await arrivals.promise
    controller.abort(new Error("test cancelled"))
    await expect(pending).rejects.toThrow("test cancelled")
    expect(requests).toHaveLength(1)
    await expect(new CustomEmbedder(opts).embed(["query"], controller.signal)).rejects.toThrow("test cancelled")
    expect(requests).toHaveLength(1)
  } finally {
    release.resolve()
    await server.stop(true)
  }
})

test("research registration requires actual thread/start fields and dynamic call parameters", () => {
  const docs = {
    steer: {},
    start: {},
    list: {},
    requests: {},
    thread: {
      properties: {
        dynamicTools: {
          type: ["array", "null"],
          items: {
            properties: {
              type: { enum: ["function"] },
              name: { type: "string" },
              description: { type: "string" },
              inputSchema: true,
            },
          },
        },
      },
    },
    callbacks: {
      oneOf: [
        {
          properties: {
            method: { enum: ["item/tool/call"] },
            params: {
              properties: {
                threadId: { type: "string" },
                turnId: { type: "string" },
                callId: { type: "string" },
                tool: { type: "string" },
                arguments: true,
              },
            },
          },
        },
      ],
    },
  }
  expect(NativeModes.supports(docs).research).toBe(true)
  expect(NativeModes.supports({ ...docs, thread: { definitions: docs.thread.properties } }).research).toBeUndefined()
  expect(NativeModes.supports({ ...docs, callbacks: {} }).research).toBeUndefined()
  expect(
    NativeResearch.tools.every((item) => item.type === "function" && item.inputSchema.additionalProperties === false),
  ).toBe(true)
})
