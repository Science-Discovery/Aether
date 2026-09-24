import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Flag } from "../../src/flag/flag"
import { allowOrigin } from "../../src/server/origin"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

const acao = (res: Response) => res.headers.get("access-control-allow-origin")

describe("origin policy", () => {
  test("rejects opaque null origin without a server password", () => {
    expect(allowOrigin("null", undefined)).toBeUndefined()
    expect(allowOrigin("Null", undefined)).toBeUndefined()
    expect(allowOrigin("null ", undefined)).toBeUndefined()
  })

  test("allows opaque null origin only with a server password", () => {
    expect(allowOrigin("null", "secret")).toBe("null")
    expect(allowOrigin("null", "secret", ["https://extra.example.com"])).toBe("null")
  })

  test("explicit cors list overrides defaults including null", () => {
    expect(allowOrigin("null", undefined, ["null"])).toBe("null")
    expect(allowOrigin("https://extra.example.com", undefined, ["https://extra.example.com"])).toBe(
      "https://extra.example.com",
    )
  })

  test("keeps builtin trusted origins", () => {
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:4096",
      "tauri://localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
      "https://app.opencode.ai",
      "https://a.b.opencode.ai",
    ]) {
      expect(allowOrigin(origin, undefined)).toBe(origin)
      expect(allowOrigin(origin, "secret")).toBe(origin)
    }
  })

  test("rejects untrusted origins and malformed input", () => {
    for (const origin of [
      undefined,
      "",
      "https://opencode.ai.evil.com",
      "https://evil.com",
      "http://localhost.evil.com",
      "null\0",
    ]) {
      expect(allowOrigin(origin, undefined)).toBeUndefined()
      expect(allowOrigin(origin, "secret")).toBeUndefined()
    }
  })
})

describe("cors wiring without server password", () => {
  test("test process has no server password", () => {
    expect(Flag.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  })

  test("null origin gets no cors grant on plain requests", async () => {
    const app = Server.createApp({})
    const res = await app.request("/global/health", { headers: { origin: "null" } })
    expect(res.status).toBe(200)
    expect(acao(res)).toBeNull()
  })

  test("null origin preflight is denied", async () => {
    const app = Server.createApp({})
    const res = await app.request("/global/health", {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization, range",
      },
    })
    expect(res.status).toBe(204)
    expect(acao(res)).toBeNull()
  })

  test("localhost origin keeps working", async () => {
    const app = Server.createApp({})
    const res = await app.request("/global/health", { headers: { origin: "http://localhost:5173" } })
    expect(res.status).toBe(200)
    expect(acao(res)).toBe("http://localhost:5173")
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
  })

  test("raw endpoint denies null origin on GET and preflight", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "file.txt"), "hello")
      },
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.createApp({})
    const query = `path=${encodeURIComponent("file.txt")}`

    const get = await app.request(`/file/raw?${query}`, {
      headers: { origin: "null", "x-opencode-directory": tmp.path },
    })
    expect(get.status).toBe(200)
    expect(acao(get)).toBeNull()
    expect(await get.text()).toBe("hello")

    const preflight = await app.request(`/file/raw?${query}`, {
      method: "OPTIONS",
      headers: { origin: "null", "x-opencode-directory": tmp.path },
    })
    expect(preflight.status).toBe(204)
    expect(acao(preflight)).toBeNull()
    expect(preflight.headers.get("access-control-allow-headers")).toBeNull()
  })

  test("raw endpoint still grants trusted origins", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "file.txt"), "hello")
      },
    })
    await Instance.provide({ directory: tmp.path, fn: () => {} })
    const app = Server.createApp({})
    const query = `path=${encodeURIComponent("file.txt")}`

    const preflight = await app.request(`/file/raw?${query}`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173", "x-opencode-directory": tmp.path },
    })
    expect(preflight.status).toBe(204)
    expect(acao(preflight)).toBe("http://localhost:5173")
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Range")
  })
})

describe("cors wiring with server password (desktop flow)", () => {
  test("password-protected server grants preflight and authenticated reads to null origin", async () => {
    const pkgRoot = path.resolve(import.meta.dir, "../..")
    const outPath = path.join(os.tmpdir(), `aether-cors-probe-${Math.random().toString(36).slice(2)}.json`)
    const proc = Bun.spawn([process.execPath, "test/server/cors-origin.probe.ts"], {
      cwd: pkgRoot,
      env: { ...process.env, AETHER_PROBE_PASSWORD: "probe-secret", AETHER_PROBE_OUT: outPath },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    })
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited

    let results: Record<string, { status: number; acao: string | null }>
    let file: string | undefined
    try {
      file = await Bun.file(outPath).text()
      results = JSON.parse(file)
    } catch (error) {
      throw new Error(`probe did not produce results (exit=${code})\n${stderr}`, { cause: error })
    } finally {
      await fs.rm(outPath, { force: true }).catch(() => undefined)
    }

    const expectProbe = (name: string, status: number, acao: string | null) => {
      const got = results[name]
      if (!got) throw new Error(`probe missing "${name}" (exit=${code})\n${stderr}\n${file}`)
      expect([name, got.status, got.acao]).toEqual([name, status, acao])
    }

    expectProbe("preflight.null", 204, "null")
    expectProbe("health.null.auth", 200, "null")
    expectProbe("health.null.noauth", 401, null)
    expectProbe("health.null.badauth", 401, null)
    expectProbe("raw.null.auth", 200, "null")
    expectProbe("raw.null.noauth", 401, null)
  })
})
