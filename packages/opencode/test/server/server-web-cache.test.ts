import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

const wait = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(25)
  }
  throw new Error("timeout waiting for server event")
}

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

  test("serves local web assets under runtime base path", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "bin", "web")
    await mkdir(path.join(root, "assets"), { recursive: true })
    await writeFile(path.join(root, "index.html"), "<!doctype html><html><head></head><body></body></html>")
    await writeFile(path.join(root, "assets", "index-ABCDEFGH.js"), "console.log('ok')")

    const old = process.execPath
    const env = process.env.VITE_BASE_PATH
    Object.defineProperty(process, "execPath", { value: path.join(tmp.path, "bin", "aether"), configurable: true })
    process.env.VITE_BASE_PATH = "/aether"

    try {
      const app = Server.createApp({})
      const res = await app.request("/")
      expect(res.status).toBe(302)
      expect(res.headers.get("location")).toBe("/aether/")

      const index = await app.request("/aether/")
      expect(index.status).toBe(200)
      expect(await index.text()).toContain(`globalThis.__AETHER_BASE_PATH__="/aether"`)

      const asset = await app.request("/aether/assets/index-ABCDEFGH.js")
      expect(asset.status).toBe(200)
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")

      const route = await app.request("/aether/session/test")
      expect(route.status).toBe(200)
      expect(await route.text()).toContain(`<base href="/aether/">`)
    } finally {
      Object.defineProperty(process, "execPath", { value: old, configurable: true })
      if (env === undefined) {
        delete process.env.VITE_BASE_PATH
      } else {
        process.env.VITE_BASE_PATH = env
      }
    }
  })

  test("upgrades pty websocket under runtime base path", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir({ git: true })

    const env = process.env.VITE_BASE_PATH
    process.env.VITE_BASE_PATH = "/aether"
    const server = Server.listen({ port: 0, hostname: "127.0.0.1" })
    const root = `http://127.0.0.1:${server.port}/aether`
    const query = `directory=${encodeURIComponent(tmp.path)}`
    let ws: WebSocket | undefined
    let id: string | undefined

    try {
      const res = await fetch(`${root}/pty?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "cat", title: "base" }),
      })
      expect(res.status).toBe(200)

      const data = (await res.json()) as { id?: unknown }
      if (typeof data.id !== "string") throw new Error("missing pty id")
      id = data.id

      let open = false
      let closed = false
      ws = new WebSocket(`ws://127.0.0.1:${server.port}/aether/pty/${id}/connect?${query}&cursor=0`)
      ws.addEventListener("open", () => {
        open = true
      })
      ws.addEventListener("close", () => {
        closed = true
      })
      ws.addEventListener("error", () => {
        closed = true
      })

      await wait(() => open || closed)
      expect(open).toBe(true)
    } finally {
      ws?.close()
      if (id) await fetch(`${root}/pty/${id}?${query}`, { method: "DELETE" }).catch(() => undefined)
      await server.stop(true)
      if (env === undefined) {
        delete process.env.VITE_BASE_PATH
      } else {
        process.env.VITE_BASE_PATH = env
      }
    }
  })
})
