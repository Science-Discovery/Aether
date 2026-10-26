import { expect, test } from "bun:test"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { Protocol } from "../../src/native/protocol"
import { Codex } from "../../src/native/codex"

const fixture = path.join(import.meta.dir, "fixture.ts")
const options = { executable: process.execPath, args: [fixture] }

test("JSONL transport handles UTF-8 fragments and responses out of order", async () => {
  const client = Protocol.connect(options)
  try {
    const first = client.request<string>("echo", { value: "first", delay: 30 })
    const second = client.request<string>("echo", { value: "second" })
    expect(await second).toBe("second")
    expect(await first).toBe("first")
    expect(await client.request<string>("split")).toBe("中文🙂")
  } finally {
    await client.close()
  }
})

test("interactive server requests do not block responses or notifications", async () => {
  const approval = Promise.withResolvers<unknown>()
  const asked = Promise.withResolvers<void>()
  const received: unknown[] = []
  const client = Protocol.connect({
    ...options,
    onRequest: (method) => {
      expect(method).toBe("item/commandExecution/requestApproval")
      asked.resolve()
      return approval.promise
    },
    onNotification: (_method, params) => {
      received.push(params)
    },
  })
  try {
    const request = client.request<{ decision: string }>("ask")
    await asked.promise
    expect(await client.request<string>("echo", { value: "unblocked" })).toBe("unblocked")
    await client.drain()
    expect(received).toEqual([{ value: "during approval" }])
    approval.resolve({ decision: "accept" })
    expect(await request).toEqual({ decision: "accept" })
  } finally {
    approval.resolve(null)
    await client.close()
  }
})

test("notifications preserve order across asynchronous handlers", async () => {
  const received: unknown[] = []
  const client = Protocol.connect({
    ...options,
    onNotification: async (_method, params) => {
      if (params === 1) await sleep(15)
      received.push(params)
    },
  })
  try {
    await client.request("notifications")
    await client.drain()
    expect(received).toEqual([1, 2])
  } finally {
    await client.close()
  }
})

test("queued notifications retain their original handler when a connection is leased again", async () => {
  const pending = Promise.withResolvers<void>()
  const first: unknown[] = []
  const next: unknown[] = []
  const client = Protocol.connect({
    ...options,
    onNotification: async (_method, value) => {
      await pending.promise
      first.push(value)
    },
  })
  try {
    await client.request("notifications")
    client.listen({
      onNotification: (_method, value) => {
        next.push(value)
      },
    })
    pending.resolve()
    await client.drain()
    expect(first).toEqual([1, 2])
    expect(next).toEqual([])
    await client.request("notifications")
    await client.drain()
    expect(next).toEqual([1, 2])
  } finally {
    pending.resolve()
    await client.close()
  }
})

test("completed turns can remove their process-exit subscriptions", async () => {
  const client = Protocol.connect(options)
  const received: string[] = []
  const off = client.onExit(() => received.push("old turn"))
  off()
  client.onExit(() => received.push("current turn"))
  await client.close()
  client.onExit(() => received.push("already exited"))
  expect(received).toEqual(["current turn", "already exited"])
})

test("timeout and individual cancellation release requests without closing the connection", async () => {
  const client = Protocol.connect(options)
  const controller = new AbortController()
  try {
    await expect(client.request("wait", {}, { timeout: 40 })).rejects.toThrow("timed out")
    const waiting = client.request("wait", {}, { signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toThrow("aborted")
    expect(await client.request<string>("echo", { value: "alive" })).toBe("alive")
  } finally {
    await client.close()
  }
})

test("connection cancellation aborts interactive handlers and pending requests", async () => {
  const controller = new AbortController()
  const asked = Promise.withResolvers<AbortSignal>()
  const client = Protocol.connect({
    ...options,
    signal: controller.signal,
    onRequest: (_method, _params, signal) => {
      asked.resolve(signal)
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }))
    },
  })
  const request = client.request("ask").catch((error: unknown) => error)
  try {
    const signal = await asked.promise
    controller.abort()
    const error = await request
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("aborted")
    expect(signal.aborted).toBe(true)
  } finally {
    await client.close()
  }
})

test("process failure rejects pending requests and reports its exit code", async () => {
  const client = Protocol.connect(options)
  await expect(client.request("exit")).rejects.toThrow("exited (9)")
  expect(await client.exited).toBe(9)
  await client.close()
})

test("server resolution cancels only the withdrawn client request while the connection stays usable", async () => {
  const signals = new Map<string, AbortSignal>()
  const client = Protocol.connect({
    ...options,
    onRequest: (_method, value, signal) => {
      const params = value as { name: string }
      signals.set(params.name, signal)
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }))
    },
  })
  try {
    await client.request("withdraw")
    expect(signals.size).toBe(2)
    await client.request("resolve-first")
    expect(signals.get("withdrawn")?.aborted).toBe(true)
    expect(signals.get("remaining")?.aborted).toBe(false)
    expect(await client.request<string>("echo", { value: "still active" })).toBe("still active")
  } finally {
    await client.close()
  }
  expect(signals.get("remaining")?.aborted).toBe(true)
})

test("notifications already received are drained after the server exits", async () => {
  const received: unknown[] = []
  const client = Protocol.connect({
    ...options,
    onNotification: async (_method, params) => {
      await sleep(20)
      received.push(params)
    },
  })
  await expect(client.request("final")).rejects.toThrow("exited")
  await client.exited
  await client.drain()
  expect(received).toEqual(["final"])
  await client.close()
})

test("unsupported server requests receive an explicit error", async () => {
  const client = Protocol.connect(options)
  try {
    expect(await client.request<{ code: number; message: string }>("ask")).toEqual({
      code: -32601,
      message: "Unsupported client request",
    })
  } finally {
    await client.close()
  }
})

test("invalid and oversized stdout fail safely without echoing private output", async () => {
  for (const method of ["invalid", "oversize"]) {
    const client = Protocol.connect(options)
    await expect(client.request(method)).rejects.toThrow("invalid or oversized protocol message")
    await client.close()
    await expect(client.request("echo")).rejects.not.toThrow("private-token")
  }
})

test("close terminates child processes as well as the app-server wrapper", async () => {
  const client = Protocol.connect(options)
  const pid = await client.request<number>("descendant")
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  try {
    await client.close()
    for (let attempt = 0; attempt < 20 && alive(); attempt++) await sleep(50)
    expect(alive()).toBe(false)
  } finally {
    if (alive()) process.kill(pid, "SIGKILL")
    await client.close()
  }
})

test("Codex handshake precedes initialization notification and model pagination", async () => {
  const opened = await Codex.connect(options)
  try {
    expect(opened.version).toBe("0.164.0-test")
    expect(await Codex.models(opened.client)).toEqual([
      { id: "model-1", name: "First", default: true, efforts: ["high"], effort: "high", images: true },
      { id: "model-2", name: "Second", default: false, efforts: ["high"], effort: "high", images: false },
    ])
  } finally {
    await opened.client.close()
  }
})

test("an invalid explicit executable never falls back to installed Codex", async () => {
  const file = path.join(import.meta.dir, "missing-codex-executable")
  expect(await Codex.discover(file)).toBeUndefined()
  const status = await Codex.status(file)
  expect(status.installed).toBe(false)
  expect(status.connected).toBe(false)
  expect(status.error).toContain("configured")
})
