import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { WorkspaceServer } from "../../src/control-plane/workspace-server/server"

const app = Server.createApp({})

const log = (headers: Record<string, string>) =>
  app.request("/log", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ service: "test", level: "info", message: "hi" }),
  })

describe("cross-site request guard", () => {
  test("simple text/plain POST from a random webpage is rejected", async () => {
    const res = await app.request("/log", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.com" },
      body: JSON.stringify({ service: "test", level: "info", message: "hi" }),
    })
    expect(res.status).toBe(403)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("non-browser clients without Origin keep working", async () => {
    const res = await log({})
    expect(res.status).toBe(200)
  })

  test("localhost origins keep working", async () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:4096", "tauri://localhost"]) {
      const res = await log({ origin })
      expect(res.status).toBe(200)
    }
  })

  test("null origin is rejected without a server password", async () => {
    const res = await log({ origin: "null" })
    expect(res.status).toBe(403)
  })

  test("same-host origin keeps working for non-loopback binds", async () => {
    const res = await log({ origin: "http://192.168.1.7:19527", host: "192.168.1.7:19527" })
    expect(res.status).toBe(200)
  })

  test("same-host comparison rejects lookalike origins", async () => {
    for (const [origin, host] of [
      ["http://192.168.1.7:19527:80", "192.168.1.7:19527"],
      ["http://192.168.1.7:19528", "192.168.1.7:19527"],
      ["http://evil.com", "192.168.1.7:19527"],
    ]) {
      const res = await log({ origin, host })
      expect(res.status).toBe(403)
    }
  })

  test("malformed origin is rejected", async () => {
    const res = await log({ origin: "htt:p//evil" })
    expect(res.status).toBe(403)
  })

  test("all state-changing methods are guarded", async () => {
    for (const [method, path] of [
      ["PUT", "/auth/openai"],
      ["DELETE", "/auth/openai"],
      ["PATCH", "/config"],
    ] as const) {
      const res = await app.request(path, { method, headers: { origin: "https://evil.com" } })
      expect(res.status).toBe(403)
    }
  })

  test("reads stay reachable cross-site", async () => {
    const res = await app.request("/global/health", { headers: { origin: "https://evil.com" } })
    expect(res.status).toBe(200)
  })

  test("websocket upgrade from a random webpage is rejected", async () => {
    const res = await app.request("/pty/00000000-0000-0000-0000-000000000000/connect", {
      headers: {
        origin: "https://evil.com",
        upgrade: "WebSocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    })
    expect(res.status).toBe(403)
  })

  test("websocket upgrade from a trusted origin passes the guard", async () => {
    const res = await app.request("/pty/00000000-0000-0000-0000-000000000000/connect", {
      headers: {
        origin: "http://localhost:19527",
        host: "127.0.0.1:19527",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    })
    expect(res.status).not.toBe(403)
  })

  test("non-loopback binds refuse to start without a password", () => {
    for (const hostname of ["0.0.0.0", "192.168.1.7", "::"]) {
      expect(() => Server.listen({ port: 0, hostname })).toThrow(/OPENCODE_SERVER_PASSWORD/)
    }
  })
})

describe("workspace server guard", () => {
  const app = WorkspaceServer.App()

  test("simple text/plain POST from a random webpage is rejected", async () => {
    const res = await app.request("/session", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.com" },
      body: "{}",
    })
    expect(res.status).toBe(403)
  })

  test("websocket upgrade from a random webpage is rejected", async () => {
    const res = await app.request("/session/00000000-0000-0000-0000-000000000000/connect", {
      headers: {
        origin: "https://evil.com",
        upgrade: "WebSocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    })
    expect(res.status).toBe(403)
  })

  test("non-browser clients without Origin pass the guard", async () => {
    const res = await app.request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).not.toBe(403)
  })

  test("Listen refuses non-loopback bind without a password", () => {
    for (const hostname of ["0.0.0.0", "192.168.1.7"]) {
      expect(() => WorkspaceServer.Listen({ hostname, port: 0 })).toThrow(/OPENCODE_SERVER_PASSWORD/)
    }
  })
})
