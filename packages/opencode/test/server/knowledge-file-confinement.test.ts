import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { existsSync } from "fs"
import { Server } from "../../src/server/server"
import { Storage } from "../../src/knowledge/storage"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const app = Server.Default()

const fileUrl = (p: string) => `/knowledge/file?path=${encodeURIComponent(p)}`

async function makeKB(dir: string) {
  await Storage.init(dir, {
    id: Storage.genKBId(),
    name: "kb",
    embeddingProvider: "local",
    embeddingModel: "test-model",
    embeddingDimensions: 4,
    chunkSize: 512,
    chunkOverlap: 50,
  })
}

describe("knowledge file route confinement", () => {
  test("serves documents inside a knowledge base directory", async () => {
    await using root = await tmpdir()
    await makeKB(root.path)
    const doc = path.join(root.path, "notes.md")
    await Bun.write(doc, "# hello")

    const res = await app.request(fileUrl(doc))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("# hello")
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
  })

  test("serves documents nested under a knowledge base directory", async () => {
    await using root = await tmpdir()
    await makeKB(root.path)
    const doc = path.join(root.path, "sub", "deep", "notes.txt")
    await fs.mkdir(path.dirname(doc), { recursive: true })
    await Bun.write(doc, "deep")

    const res = await app.request(fileUrl(doc))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("deep")
  })

  test("accepts legacy .opencode-kb knowledge bases", async () => {
    await using root = await tmpdir()
    await fs.mkdir(path.join(root.path, ".opencode-kb"), { recursive: true })
    await Bun.write(path.join(root.path, ".opencode-kb", "index.json"), "{}")
    const doc = path.join(root.path, "legacy.md")
    await Bun.write(doc, "legacy")

    const res = await app.request(fileUrl(doc))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("legacy")
  })

  test("rejects absolute paths outside knowledge bases without leaking content", async () => {
    await using root = await tmpdir()
    await using outside = await tmpdir()
    await makeKB(root.path)
    const secret = path.join(outside.path, "id_rsa")
    await Bun.write(secret, "PRIVATE KEY MATERIAL")

    const res = await app.request(fileUrl(secret))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain("PRIVATE KEY")
  })

  test("rejects traversal out of a knowledge base", async () => {
    await using root = await tmpdir()
    await using outside = await tmpdir()
    await makeKB(root.path)
    const secret = path.join(outside.path, "auth.json")
    await Bun.write(secret, '{"api":"sk-secret"}')

    const res = await app.request(fileUrl(`${root.path}/../${path.basename(outside.path)}/auth.json`))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain("sk-secret")
  })

  test("rejects relative paths", async () => {
    const res = await app.request(fileUrl("relative/notes.md"))
    expect(res.status).toBe(403)
  })

  test("keeps 404 for missing files inside a knowledge base", async () => {
    await using root = await tmpdir()
    await makeKB(root.path)

    const res = await app.request(fileUrl(path.join(root.path, "ghost.md")))
    expect(res.status).toBe(404)
  })

  test("returns 400 when the path parameter is missing", async () => {
    const res = await app.request("/knowledge/file")
    expect(res.status).toBe(400)
  })

  test.skipIf(process.platform === "win32")("blocks symlink escape from a knowledge base", async () => {
    await using root = await tmpdir()
    await using outside = await tmpdir()
    await makeKB(root.path)
    const secret = path.join(outside.path, "id_rsa")
    await Bun.write(secret, "SYMLINK SECRET")
    const link = path.join(root.path, "link.txt")
    await fs.symlink(secret, link)

    const res = await app.request(fileUrl(link))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain("SYMLINK SECRET")
  })
})

describe("knowledge import confinement", () => {
  const importReq = (dir: string, paths: string[]) =>
    app.request(`/knowledge/${encodeURIComponent(dir)}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths }),
    })

  test("copies sources from knowledge base directories", async () => {
    await using src = await tmpdir()
    await using dst = await tmpdir()
    await makeKB(src.path)
    await makeKB(dst.path)
    const doc = path.join(src.path, "paper.md")
    await Bun.write(doc, "content")

    const res = await importReq(dst.path, [doc])
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.added).toBe(1)
    expect(await Bun.file(path.join(dst.path, "paper.md")).text()).toBe("content")
  })

  test("rejects sources outside knowledge base directories", async () => {
    await using dst = await tmpdir()
    await using outside = await tmpdir()
    await makeKB(dst.path)
    const secret = path.join(outside.path, "auth.json")
    await Bun.write(secret, '{"apiKey":"sk-123"}')

    const res = await importReq(dst.path, [secret])
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.added).toBe(0)
    expect(out.skipped).toBe(1)
    expect(out.errors[0]).toContain("outside knowledge base directories")
    expect(existsSync(path.join(dst.path, "auth.json"))).toBe(false)
  })

  test("still reports unknown knowledge base targets", async () => {
    await using outside = await tmpdir()
    const doc = path.join(outside.path, "paper.md")
    await Bun.write(doc, "content")

    const res = await importReq(outside.path, [doc])
    expect(res.status).toBe(404)
  })
})

describe("knowledge delete confinement", () => {
  test("removes a real knowledge base marker", async () => {
    await using root = await tmpdir()
    await makeKB(root.path)
    const doc = path.join(root.path, "notes.md")
    await Bun.write(doc, "keep me")

    const res = await app.request(`/knowledge/${encodeURIComponent(root.path)}`, { method: "DELETE" })
    expect(res.status).toBe(200)
    expect(existsSync(path.join(root.path, ".aether-kb"))).toBe(false)
    expect(existsSync(doc)).toBe(true)
  })

  test("refuses directories that are not knowledge bases", async () => {
    await using root = await tmpdir()
    await using outside = await tmpdir()
    await makeKB(root.path)
    const half = path.join(outside.path, ".aether-kb")
    await fs.mkdir(half)

    const res = await app.request(`/knowledge/${encodeURIComponent(outside.path)}`, { method: "DELETE" })
    expect(res.status).toBe(404)
    expect(existsSync(half)).toBe(true)

    const relative = await app.request("/knowledge/relative/dir", { method: "DELETE" })
    expect(relative.status).toBe(404)
  })
})
