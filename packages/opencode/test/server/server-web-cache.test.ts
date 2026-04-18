import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

describe("web cache headers", () => {
  test("serves hashed assets as immutable", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "bin", "web")
    await mkdir(path.join(root, "assets"), { recursive: true })
    await writeFile(path.join(root, "index.html"), "<!doctype html>")
    await writeFile(path.join(root, "assets", "index-ABCDEFGH.js"), "console.log('ok')")

    const old = process.execPath
    Object.defineProperty(process, "execPath", { value: path.join(tmp.path, "bin", "aether"), configurable: true })

    try {
      const app = Server.createApp({})
      const res = await app.request("/assets/index-ABCDEFGH.js")
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      expect(res.headers.get("etag")).toBeTruthy()
      expect(res.headers.get("last-modified")).toBeTruthy()
    } finally {
      Object.defineProperty(process, "execPath", { value: old, configurable: true })
    }
  })

  test("revalidates index.html with etag", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "bin", "web")
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, "index.html"), "<!doctype html>")

    const old = process.execPath
    Object.defineProperty(process, "execPath", { value: path.join(tmp.path, "bin", "aether"), configurable: true })

    try {
      const app = Server.createApp({})
      const first = await app.request("/")
      const tag = first.headers.get("etag")
      expect(first.status).toBe(200)
      expect(first.headers.get("cache-control")).toBe("no-cache")
      expect(tag).toBeTruthy()

      const next = await app.request("/", {
        headers: { "if-none-match": tag! },
      })
      expect(next.status).toBe(304)
      expect(next.headers.get("cache-control")).toBe("no-cache")
      expect(next.headers.get("etag")).toBe(tag)
    } finally {
      Object.defineProperty(process, "execPath", { value: old, configurable: true })
    }
  })
})
