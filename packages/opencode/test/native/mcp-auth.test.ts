import { expect, test } from "bun:test"
import path from "node:path"
import { NativeMcpAuth } from "../../src/native/mcp-auth"
import { Codex } from "../../src/native/codex"
import type { Protocol } from "../../src/native/protocol"
import { tmpdir } from "../fixture/fixture"

async function scenario(
  cfg: {
    early?: boolean
    legacy?: boolean
    delay?: number
    initDelay?: number
    url?: string
    auth?: string
    error?: boolean
    duplicate?: boolean
    refresh?: boolean
    timeout?: number
  },
  run: (value: {
    manager: ReturnType<typeof NativeMcpAuth.create>
    clients: Protocol.Client[]
    settings: { key: string; enabled: boolean }
    changes: { directory: string; home: string }[]
    calls: () => Promise<{ method: string; params?: { name?: string } }[]>
  }) => Promise<void>,
) {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "mcp.json"), JSON.stringify(cfg))
  const clients: Protocol.Client[] = []
  const settings = { key: "fixture", enabled: true }
  const changes: { directory: string; home: string }[] = []
  const manager = NativeMcpAuth.create({
    read: async () => ({ ...settings }),
    async open(opts) {
      const opened = await Codex.connect({
        ...opts,
        executable: process.execPath,
        args: [path.join(import.meta.dir, "mcp-auth-fixture.ts")],
        cwd: tmp.path,
      })
      clients.push(opened.client)
      return opened
    },
    changed: async (input) => {
      changes.push(input)
      return cfg.refresh !== false
    },
    timeout: cfg.timeout,
  })
  try {
    await run({
      manager,
      clients,
      settings,
      changes,
      calls: async () =>
        (
          await Bun.file(path.join(tmp.path, "calls.jsonl"))
            .text()
            .catch(() => "")
        )
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
    })
  } finally {
    await manager.dispose()
  }
}

async function terminal(manager: ReturnType<typeof NativeMcpAuth.create>, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await manager.read(id, "project")
    if (status.state !== "starting" && status.state !== "pending") return status
    await Bun.sleep(10)
  }
  throw new Error("MCP sign-in did not settle")
}

test("MCP login deduplicates the same UUID, authenticates the configured service, and refreshes only its project/home", async () => {
  await scenario({}, async ({ manager, clients, changes, calls }) => {
    const input = { id: crypto.randomUUID(), name: "papers" }
    const [first, again] = await Promise.all([manager.start(input, "project"), manager.start(input, "project")])
    expect(first).toEqual(again)
    expect(first.state).toBe("pending")
    expect(first.url).toStartWith("https://example.com/")
    expect(first.expiresAt).toBeGreaterThan(Date.now())
    expect(clients).toHaveLength(1)
    expect((await calls()).map((call) => call.method)).toContain("mcpServerStatus/list")
    expect((await calls()).filter((call) => call.method === "mcpServer/oauth/login")).toEqual([
      expect.objectContaining({ params: { name: "papers", timeoutSecs: 600 } }),
    ])
    await clients[0].request("test/complete", { success: true })
    expect(await terminal(manager, input.id)).toEqual({ ...input, state: "complete" })
    await clients[0].exited
    expect(changes).toEqual([{ directory: "project", home: "fixture-home" }])
    expect((await manager.start(input, "project")).state).toBe("complete")
    expect(clients).toHaveLength(1)
  })
})

test("MCP completion before the response and legacy missing login IDs remain correlated", async () => {
  for (const legacy of [false, true])
    await scenario({ early: true, legacy, delay: 20 }, async ({ manager, clients }) => {
      expect((await manager.start({ id: crypto.randomUUID(), name: "papers" }, "project")).state).toBe("complete")
      await clients[0].exited
    })
})

test("wrong MCP login, server, or thread notifications cannot finish an attempt; errors do not leak provider text", async () => {
  await scenario({}, async ({ manager, clients, changes }) => {
    const input = { id: crypto.randomUUID(), name: "papers" }
    await manager.start(input, "project")
    for (const value of [{ login: "wrong" }, { name: "other" }, { thread: "other-thread" }]) {
      await clients[0].request("test/complete", { success: true, ...value })
      await clients[0].drain()
      expect((await manager.read(input.id, "project")).state).toBe("pending")
    }
    await clients[0].request("test/complete", { success: false })
    const status = await terminal(manager, input.id)
    expect(status.state).toBe("failed")
    expect(status.url).toBeUndefined()
    expect(JSON.stringify(status)).not.toContain("fixture-private-secret")
    expect(changes).toEqual([])
  })
})

test("MCP unknown servers, unsupported auth and bearer token services cannot start OAuth", async () => {
  for (const auth of ["unsupported", "bearerToken", "unknown"])
    await scenario({ auth }, async ({ manager, calls }) => {
      expect((await manager.start({ id: crypto.randomUUID(), name: "papers" }, "project")).state).toBe("failed")
      expect((await calls()).some((call) => call.method === "mcpServer/oauth/login")).toBe(false)
    })
  await scenario({}, async ({ manager, calls }) => {
    expect((await manager.start({ id: crypto.randomUUID(), name: "unknown" }, "project")).state).toBe("failed")
    expect((await calls()).some((call) => call.method === "mcpServer/oauth/login")).toBe(false)
  })
})

test("MCP active sign-in cannot be replaced or read/cancelled by another project", async () => {
  await scenario({}, async ({ manager, clients }) => {
    const input = { id: crypto.randomUUID(), name: "papers" }
    await manager.start(input, "project")
    await expect(manager.start({ ...input, id: crypto.randomUUID() }, "project")).rejects.toThrow("already in progress")
    await expect(manager.start({ ...input, id: crypto.randomUUID() }, "other-project")).rejects.toThrow(
      "already in progress",
    )
    await expect(manager.start({ ...input, name: "other" }, "project")).rejects.toThrow("another service")
    await expect(manager.read(input.id, "other-project")).rejects.toThrow("another project")
    await expect(manager.cancel(input.id, "other-project")).rejects.toThrow("another project")
    await manager.cancel(crypto.randomUUID(), "project")
    expect((await manager.read(input.id, "project")).state).toBe("pending")
    expect((await manager.cancel(input.id, "project")).state).toBe("cancelled")
    expect(clients[0].closed).toBe(true)
  })
})

test("MCP duplicate completion notifications refresh conversation connections only once", async () => {
  await scenario({ duplicate: true }, async ({ manager, clients, changes }) => {
    const input = { id: crypto.randomUUID(), name: "papers" }
    await manager.start(input, "project")
    await clients[0].request("test/complete", { success: true })
    expect((await terminal(manager, input.id)).state).toBe("complete")
    await clients[0].exited
    expect(changes).toEqual([{ directory: "project", home: "fixture-home" }])
  })
})

test("MCP cancellation before start and during initialization prevents late authorization", async () => {
  await scenario({}, async ({ manager, clients }) => {
    const input = { id: crypto.randomUUID(), name: "papers" }
    await manager.cancel(input.id, "project")
    expect((await manager.start(input, "project")).state).toBe("cancelled")
    expect(clients).toHaveLength(0)
  })
  await scenario({ initDelay: 100 }, async ({ manager, calls }) => {
    const input = { id: crypto.randomUUID(), name: "papers" }
    const pending = manager.start(input, "project")
    await Bun.sleep(20)
    expect((await manager.cancel(input.id, "project")).state).toBe("cancelled")
    expect((await pending).state).toBe("cancelled")
    expect((await calls()).some((call) => call.method === "mcpServer/oauth/login")).toBe(false)
  })
})

test("MCP cancellation during an OAuth response cannot be reopened by the late POST", async () => {
  await scenario({ delay: 100 }, async ({ manager, calls, clients }) => {
    const input = { id: crypto.randomUUID(), name: "papers" }
    const pending = manager.start(input, "project")
    for (
      let index = 0;
      index < 100 && !(await calls()).some((call) => call.method === "mcpServer/oauth/login");
      index++
    )
      await Bun.sleep(10)
    await manager.cancel(input.id, "project")
    expect((await pending).state).toBe("cancelled")
    expect((await manager.start(input, "project")).state).toBe("cancelled")
    expect(clients).toHaveLength(1)
    expect(clients[0].closed).toBe(true)
  })
})

test("MCP settings changes, disabled backend and expiry invalidate authorization and close its process", async () => {
  for (const disabled of [false, true])
    await scenario({}, async ({ manager, clients, settings, changes }) => {
      const input = { id: crypto.randomUUID(), name: "papers" }
      await manager.start(input, "project")
      if (disabled) settings.enabled = false
      if (!disabled) settings.key = "changed"
      expect((await manager.read(input.id, "project")).state).toBe("cancelled")
      expect(clients[0].closed).toBe(true)
      expect(changes).toEqual([])
    })
  await scenario({ timeout: 150 }, async ({ manager, clients }) => {
    const input = { id: crypto.randomUUID(), name: "papers" }
    await manager.start(input, "project")
    expect((await terminal(manager, input.id)).state).toBe("expired")
    expect(clients.every((client) => client.closed)).toBe(true)
  })
})

test("MCP completion revalidates settings before refreshing any chat connection", async () => {
  await scenario({}, async ({ manager, clients, settings, changes }) => {
    const input = { id: crypto.randomUUID(), name: "papers" }
    await manager.start(input, "project")
    settings.key = "changed"
    await clients[0].request("test/complete", { success: true })
    expect((await terminal(manager, input.id)).state).toBe("cancelled")
    expect(changes).toEqual([])
  })
})

test("MCP OAuth completion remains successful when live conversation reload is unavailable", async () => {
  await scenario({ refresh: false }, async ({ manager, clients }) => {
    const input = { id: crypto.randomUUID(), name: "papers" }
    await manager.start(input, "project")
    await clients[0].request("test/complete", { success: true })
    const result = await terminal(manager, input.id)
    expect(result.state).toBe("complete")
    expect(result.error).toContain("/release")
    expect(result.url).toBeUndefined()
  })
})

test("MCP unsafe URLs and RPC failures are sanitized and terminate the owned process", async () => {
  for (const url of [
    "file:///secret",
    "javascript:alert(1)",
    "https://user:secret@example.com",
    "https://example.com/\nsecret",
  ]) {
    await scenario({ url }, async ({ manager, clients }) => {
      const status = await manager.start({ id: crypto.randomUUID(), name: "papers" }, "project")
      expect(status.state).toBe("failed")
      expect(status.url).toBeUndefined()
      expect(clients[0].closed).toBe(true)
    })
  }
  await scenario({ error: true }, async ({ manager }) => {
    const status = await manager.start({ id: crypto.randomUUID(), name: "papers" }, "project")
    expect(status.state).toBe("failed")
    expect(JSON.stringify(status)).not.toContain("fixture-private-secret")
  })
})

test("MCP process exit and project disposal terminate pending login without touching other projects", async () => {
  await scenario({}, async ({ manager, clients }) => {
    const input = { id: crypto.randomUUID(), name: "papers" }
    await manager.start(input, "project")
    await manager.dispose("other-project")
    expect((await manager.read(input.id, "project")).state).toBe("pending")
    await clients[0].request("test/exit").catch(() => undefined)
    expect((await terminal(manager, input.id)).state).toBe("failed")
    await manager.dispose("project")
    await expect(manager.read(input.id, "project")).rejects.toThrow("no longer available")
  })
})
