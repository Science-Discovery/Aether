import { expect, test } from "bun:test"
import path from "node:path"
import { NativeAuth } from "../../src/native/auth"
import { Codex } from "../../src/native/codex"
import type { Protocol } from "../../src/native/protocol"
import { tmpdir } from "../fixture/fixture"

async function scenario(
  cfg: { early?: boolean; delay?: number; initDelay?: number; url?: string; error?: boolean; timeout?: number },
  run: (value: {
    manager: ReturnType<typeof NativeAuth.create>
    clients: Protocol.Client[]
    settings: { key: string; enabled: boolean }
    changed: () => number
    calls: () => Promise<{ method: string; params?: { type?: string } }[]>
  }) => Promise<void>,
) {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "auth.json"), JSON.stringify(cfg))
  const clients: Protocol.Client[] = []
  const settings = { key: "fixture", enabled: true }
  const changes: number[] = []
  const manager = NativeAuth.create({
    read: async () => ({ ...settings }),
    async open(opts) {
      const opened = await Codex.connect({
        ...opts,
        executable: process.execPath,
        args: [path.join(import.meta.dir, "auth-fixture.ts")],
        cwd: tmp.path,
      })
      clients.push(opened.client)
      return opened.client
    },
    changed: () => changes.push(1),
    timeout: cfg.timeout,
  })
  try {
    await run({
      manager,
      clients,
      settings,
      changed: () => changes.length,
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

async function terminal(manager: ReturnType<typeof NativeAuth.create>, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await manager.read(id)
    if (status.state !== "starting" && status.state !== "pending") return status
    await Bun.sleep(10)
  }
  throw new Error("Sign-in did not settle")
}

test("browser and device login retain one process, deduplicate starts and clear secrets on success", async () => {
  for (const method of ["browser", "device"] as const) {
    await scenario({}, async ({ manager, clients, changed, calls }) => {
      const input = { id: crypto.randomUUID(), method }
      const [first, again] = await Promise.all([manager.start(input), manager.start(input)])
      expect(first).toEqual(again)
      expect(first.state).toBe("pending")
      expect(first.expiresAt).toBeGreaterThan(Date.now())
      expect(first.url).toStartWith("https://auth.openai.com/")
      expect(first.code).toBe(method === "device" ? "FIXT-URE" : undefined)
      expect(clients).toHaveLength(1)
      expect((await calls()).filter((call) => call.method === "account/login/start")).toEqual([
        expect.objectContaining({ params: { type: method === "browser" ? "chatgpt" : "chatgptDeviceCode" } }),
      ])
      await clients[0].request("test/complete", { success: true, login: "login" })
      expect(await terminal(manager, input.id)).toEqual({ ...input, state: "complete" })
      await clients[0].exited
      expect(changed()).toBe(1)
      expect((await calls()).some((call) => call.method === "account/login/cancel")).toBe(false)
      expect((await manager.start(input)).state).toBe("complete")
      expect(clients).toHaveLength(1)
    })
  }
})

test("early completion is correlated to the login response instead of being lost", async () => {
  await scenario({ early: true, delay: 20 }, async ({ manager, clients, changed }) => {
    const status = await manager.start({ id: crypto.randomUUID(), method: "browser" })
    expect(status.state).toBe("complete")
    expect(status.url).toBeUndefined()
    expect(changed()).toBe(1)
    await clients[0].exited
  })
})

test("unrelated notifications do not finish login and provider errors are not exposed", async () => {
  await scenario({}, async ({ manager, clients, changed }) => {
    const input = { id: crypto.randomUUID(), method: "browser" as const }
    await manager.start(input)
    await clients[0].request("test/complete", { success: true, login: "unrelated" })
    await clients[0].drain()
    expect((await manager.read(input.id)).state).toBe("pending")
    await clients[0].request("test/complete", { success: false, login: "login" })
    const status = await terminal(manager, input.id)
    expect(status.state).toBe("failed")
    expect(JSON.stringify(status)).not.toContain("fixture-private-secret")
    expect(status.url).toBeUndefined()
    expect(changed()).toBe(0)
    await clients[0].exited
  })
})

test("concurrent attempts cannot replace login, while cancellation closes only its own attempt", async () => {
  await scenario({}, async ({ manager, clients, calls }) => {
    const input = { id: crypto.randomUUID(), method: "browser" as const }
    await manager.start(input)
    await expect(manager.start({ id: crypto.randomUUID(), method: "device" })).rejects.toThrow("already in progress")
    await expect(manager.start({ ...input, method: "device" })).rejects.toThrow("changing its method")
    await manager.cancel(crypto.randomUUID())
    expect((await manager.read(input.id)).state).toBe("pending")
    expect((await manager.cancel(input.id)).state).toBe("cancelled")
    expect(clients[0].closed).toBe(true)
    expect((await calls()).filter((call) => call.method === "account/login/cancel")).toHaveLength(1)
    expect((await manager.start(input)).state).toBe("cancelled")
    expect(clients).toHaveLength(1)
  })
})

test("a cancellation preceding start prevents a delayed POST from opening Codex", async () => {
  await scenario({}, async ({ manager, clients }) => {
    const input = { id: crypto.randomUUID(), method: "device" as const }
    expect((await manager.cancel(input.id)).state).toBe("cancelled")
    expect((await manager.start(input)).state).toBe("cancelled")
    expect(clients).toHaveLength(0)
  })
})

test("cancellation during initialization stops the pending process and cannot be undone by a late response", async () => {
  await scenario({ initDelay: 100 }, async ({ manager, clients, calls }) => {
    const input = { id: crypto.randomUUID(), method: "browser" as const }
    const pending = manager.start(input)
    await Bun.sleep(20)
    expect((await manager.cancel(input.id)).state).toBe("cancelled")
    expect((await pending).state).toBe("cancelled")
    expect(clients.every((client) => client.closed)).toBe(true)
    expect((await calls()).some((call) => call.method === "account/login/start")).toBe(false)
  })
})

test("cancellation during login/start cannot publish a late authorization URL", async () => {
  await scenario({ delay: 200 }, async ({ manager, clients, calls }) => {
    const input = { id: crypto.randomUUID(), method: "browser" as const }
    const pending = manager.start(input)
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await calls()).some((call) => call.method === "account/login/start")) break
      await Bun.sleep(10)
    }
    expect((await calls()).some((call) => call.method === "account/login/start")).toBe(true)
    await manager.cancel(input.id)
    const status = await pending
    expect(status.state).toBe("cancelled")
    expect(status.url).toBeUndefined()
    expect(clients[0].closed).toBe(true)
  })
})

test("project disposal leaves another project's login alive and closes the owner's pending login", async () => {
  await scenario({}, async ({ manager, clients }) => {
    const input = { id: crypto.randomUUID(), method: "browser" as const }
    await manager.start(input, "owner")
    await manager.dispose("other")
    expect((await manager.read(input.id)).state).toBe("pending")
    expect(clients[0].closed).toBe(false)
    await manager.dispose("owner")
    expect(clients[0].closed).toBe(true)
    await expect(manager.read(input.id)).rejects.toThrow("no longer available")
  })
})

test("expiry releases the process and removes authorization instructions", async () => {
  await scenario({ timeout: 300 }, async ({ manager, clients }) => {
    const input = { id: crypto.randomUUID(), method: "device" as const }
    await manager.start(input)
    const status = await terminal(manager, input.id)
    expect(status).toEqual({ ...input, state: "expired" })
    await clients[0].exited
    expect(clients[0].closed).toBe(true)
  })
})

test("settings changes and disabling Codex cancel an existing login", async () => {
  for (const mode of ["path", "disabled"]) {
    await scenario({}, async ({ manager, clients, settings, changed }) => {
      const input = { id: crypto.randomUUID(), method: "browser" as const }
      await manager.start(input)
      if (mode === "path") settings.key = "other"
      if (mode === "disabled") settings.enabled = false
      expect((await manager.read(input.id)).state).toBe("cancelled")
      expect(clients[0].closed).toBe(true)
      expect(changed()).toBe(0)
    })
  }
})

test("invalid login URLs and unsupported methods fail without leaking protocol errors", async () => {
  for (const cfg of [
    { error: true },
    { url: "https://auth.openai.com.attacker.test/login" },
    { url: "https://user:password@auth.openai.com/login" },
    { url: "http://auth.openai.com/login" },
    { url: "file:///private" },
  ]) {
    await scenario(cfg, async ({ manager, clients }) => {
      const status = await manager.start({ id: crypto.randomUUID(), method: "browser" })
      expect(status.state).toBe("failed")
      expect(JSON.stringify(status)).not.toContain("fixture-private-secret")
      expect(status.url).toBeUndefined()
      expect(clients[0].closed).toBe(true)
    })
  }
})

test("Codex exit before authorization finishes produces a terminal failure", async () => {
  await scenario({}, async ({ manager, clients }) => {
    const input = { id: crypto.randomUUID(), method: "browser" as const }
    await manager.start(input)
    await clients[0].request("test/exit").catch(() => undefined)
    expect((await terminal(manager, input.id)).state).toBe("failed")
  })
})

test("disabled integration never launches a login process", async () => {
  await scenario({}, async ({ manager, clients, settings }) => {
    settings.enabled = false
    expect((await manager.start({ id: crypto.randomUUID(), method: "browser" })).state).toBe("failed")
    expect(clients).toHaveLength(0)
    await expect(manager.read(crypto.randomUUID())).rejects.toThrow("no longer available")
  })
})
