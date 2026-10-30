import { expect, test } from "bun:test"
import path from "node:path"
import { NativeRuntime } from "../../src/native/runtime"
import { tmpdir } from "../fixture/fixture"

const fixture = path.join(import.meta.dir, "fixture.ts")
const config = { path: process.execPath, limit: 2 }
const options = { directory: import.meta.dir, args: [fixture] }

test("a session retains one initialized process and its thread between leases", async () => {
  const pool = NativeRuntime.create()
  await pool.configure(config)
  try {
    const first = await pool.acquire({ ...options, id: "one" })
    const info = await first.client.request<{ pid: number; initializes: number }>("info")
    first.bind("thread-one")
    await first.release(true)
    const second = await pool.acquire({ ...options, id: "one" })
    expect(second.client).toBe(first.client)
    expect(second.thread).toBe("thread-one")
    expect(await second.client.request<{ pid: number; initializes: number }>("info")).toEqual({
      pid: info.pid,
      initializes: 1,
    })
    await expect(pool.acquire({ ...options, id: "one" })).rejects.toThrow("active turn")
    await second.release(true)
  } finally {
    await pool.dispose()
  }
})

test("LRU evicts only idle processes and uses the most recently released session", async () => {
  const pool = NativeRuntime.create()
  await pool.configure(config)
  try {
    const first = await pool.acquire({ ...options, id: "one" })
    await first.release(true)
    const second = await pool.acquire({ ...options, id: "two" })
    await second.release(true)
    const fresh = await pool.acquire({ ...options, id: "one" })
    await fresh.release(true)
    const active = await pool.acquire({ ...options, id: "active" })
    const third = await pool.acquire({ ...options, id: "three" })
    await third.release(true)
    expect(second.client.closed).toBe(true)
    expect(first.client.closed).toBe(false)
    expect(third.client.closed).toBe(false)
    expect(active.client.closed).toBe(false)
    await pool.configure({ ...config, limit: 0 })
    expect(first.client.closed).toBe(true)
    expect(third.client.closed).toBe(true)
    expect(active.client.closed).toBe(false)
    await active.release(true)
    expect(active.client.closed).toBe(true)
  } finally {
    await pool.dispose()
  }
})

test("idle expiry closes the process without waiting for another request", async () => {
  const pool = NativeRuntime.create({ idle: 40 })
  await pool.configure(config)
  try {
    const lease = await pool.acquire({ ...options, id: "idle" })
    await lease.release(true)
    await lease.client.exited
    expect(lease.client.closed).toBe(true)
    const next = await pool.acquire({ ...options, id: "idle" })
    expect(next.client).not.toBe(lease.client)
    await next.release(false)
  } finally {
    await pool.dispose()
  }
})

test("disabling or aborting while an old process closes prevents a replacement from starting", async () => {
  for (const mode of ["disable", "abort"]) {
    const pool = NativeRuntime.create()
    await pool.configure(config)
    try {
      const previous = await pool.acquire({ ...options, id: "session" })
      await previous.release(true)
      const closing = pool.remove("session")
      const controller = new AbortController()
      const pending = pool.acquire({ ...options, id: "session", signal: controller.signal }).then(
        () => undefined,
        (error: unknown) => error,
      )
      if (mode === "disable") await pool.configure({ ...config, enabled: false })
      if (mode === "abort") controller.abort()
      const error = await pending
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain(mode === "disable" ? "disabled" : "aborted")
      await closing
      expect(previous.client.closed).toBe(true)
    } finally {
      await pool.dispose()
    }
  }
})

test("disable and executable changes retire active leases without interrupting them", async () => {
  const pool = NativeRuntime.create()
  await pool.configure(config)
  try {
    const idle = await pool.acquire({ ...options, id: "idle" })
    await idle.release(true)
    const active = await pool.acquire({ ...options, id: "active" })
    const revision = pool.revision()
    await pool.configure({ ...config, enabled: false })
    await pool.configure(config, revision)
    expect(idle.client.closed).toBe(true)
    expect(await active.client.request<string>("echo", { value: "still running" })).toBe("still running")
    await expect(pool.acquire({ ...options, id: "disabled" })).rejects.toThrow("disabled")
    await pool.configure(config)
    await active.release(true)
    expect(active.client.closed).toBe(true)
    const changed = await pool.acquire({ ...options, id: "changed" })
    await pool.configure({ ...config, path: "different-codex-path" })
    expect(changed.client.closed).toBe(false)
    await changed.release(true)
    expect(changed.client.closed).toBe(true)
  } finally {
    await pool.dispose()
  }
})

test("deletion retires its session and disposal closes only the selected directory", async () => {
  await using dir = await tmpdir()
  const pool = NativeRuntime.create()
  await pool.configure(config)
  try {
    const removed = await pool.acquire({ ...options, id: "removed" })
    await removed.release(true)
    const active = await pool.acquire({ ...options, id: "active" })
    const other = await pool.acquire({ ...options, directory: dir.path, id: "other" })
    await pool.remove("removed")
    expect(removed.client.closed).toBe(true)
    await pool.remove("active")
    expect(active.client.closed).toBe(false)
    await active.release(true)
    expect(active.client.closed).toBe(true)
    const local = await pool.acquire({ ...options, id: "local" })
    await pool.dispose(options.directory)
    expect(local.client.closed).toBe(true)
    expect(other.client.closed).toBe(false)
    await other.release(true)
  } finally {
    await pool.dispose()
  }
})

test("aborted and crashed processes cannot be reused", async () => {
  const pool = NativeRuntime.create()
  await pool.configure(config)
  try {
    const controller = new AbortController()
    const first = await pool.acquire({ ...options, id: "session", signal: controller.signal })
    controller.abort()
    await first.release(true)
    expect(first.client.closed).toBe(true)
    const second = await pool.acquire({ ...options, id: "session" })
    await expect(second.client.request("exit")).rejects.toThrow("exited")
    await second.release(false)
    const third = await pool.acquire({ ...options, id: "session" })
    expect(third.client).not.toBe(second.client)
    expect(await third.client.request<string>("echo", { value: "recovered" })).toBe("recovered")
    await third.release(true)
  } finally {
    await pool.dispose()
  }
})

test("session handlers are isolated and retired root and child turns cannot enter the next lease", async () => {
  const pool = NativeRuntime.create()
  await pool.configure(config)
  const first: unknown[] = []
  const next: unknown[] = []
  try {
    const previous = await pool.acquire({
      ...options,
      id: "one",
      onNotification: (_method, value) => {
        first.push(value)
      },
    })
    for (const thread of ["root", "child"]) {
      await previous.client.request("notify", {
        method: "turn/completed",
        params: { threadId: thread, turn: { id: "old" } },
      })
    }
    await previous.release(true)
    const current = await pool.acquire({
      ...options,
      id: "one",
      onNotification: (_method, value) => {
        next.push(value)
      },
    })
    const other = await pool.acquire({ ...options, id: "two", onRequest: () => ({ decision: "other" }) })
    for (const thread of ["root", "child"]) {
      await current.client.request("notify", {
        method: "turn/started",
        params: { threadId: thread, turn: { id: "old" } },
      })
    }
    await current.client.request("notify", {
      method: "turn/started",
      params: { threadId: "root", turn: { id: "new" } },
    })
    expect(await other.client.request<{ decision: string }>("ask")).toEqual({ decision: "other" })
    await current.client.drain()
    expect(first).toHaveLength(2)
    expect(next).toEqual([{ threadId: "root", turn: { id: "new" } }])
    await current.release(true)
    await other.release(true)
  } finally {
    await pool.dispose()
  }
})

test("read-only inspection uses only the matching live thread and preserves turn handlers", async () => {
  const pool = NativeRuntime.create()
  await pool.configure(config)
  try {
    const lease = await pool.acquire({ ...options, id: "one", onRequest: () => ({ decision: "original" }) })
    lease.bind("thread-one")
    const scope = { id: "one", directory: options.directory, thread: "thread-one", home: lease.home! }
    const read = (client: typeof lease.client) => client.request<string>("echo", { value: "tools" }, { timeout: 1000 })
    expect(await pool.inspect(scope, read)).toBe("tools")
    expect(await lease.client.request<{ decision: string }>("ask", undefined, { timeout: 1000 })).toEqual({
      decision: "original",
    })
    for (const key of ["id", "directory", "thread", "home"] as const) {
      expect(await pool.inspect({ ...scope, [key]: "different" }, read)).toBeUndefined()
    }
    await expect(pool.inspect(scope, (client) => client.request("wait", undefined, { timeout: 40 }))).rejects.toThrow(
      "timed out",
    )
    await lease.release(true)
    expect(await pool.inspect(scope, read)).toBe("tools")
    expect(await pool.handoff("one")).toBe(true)
    expect(await pool.inspect(scope, read)).toBeUndefined()
  } finally {
    await pool.dispose()
  }
})

test("inspection discards results invalidated by configuration changes", async () => {
  const pool = NativeRuntime.create()
  await pool.configure(config)
  try {
    const lease = await pool.acquire({ ...options, id: "one" })
    lease.bind("thread-one")
    const scope = { id: "one", directory: options.directory, thread: "thread-one", home: lease.home! }
    const pending = pool.inspect(scope, (client) => client.request<string>("echo", { value: "old", delay: 50 }))
    await pool.configure({ ...config, enabled: false })
    expect(await pending).toBeUndefined()
    expect(lease.client.closed).toBe(false)
    await lease.release(true)
  } finally {
    await pool.dispose()
  }
})

test("handoff refuses an active lease without retiring it and closes only the idle owner", async () => {
  const pool = NativeRuntime.create()
  await pool.configure(config)
  try {
    const lease = await pool.acquire({ ...options, id: "one" })
    const other = await pool.acquire({ ...options, id: "two" })
    await expect(pool.handoff("one")).rejects.toThrow("finish")
    await lease.release(true)
    expect(lease.client.closed).toBe(false)
    expect(await pool.handoff("one")).toBe(true)
    expect(lease.client.closed).toBe(true)
    expect(other.client.closed).toBe(false)
    expect(await pool.handoff("one")).toBe(false)
    await other.release(true)
  } finally {
    await pool.dispose()
  }
})

test("credential refresh requests native reload without closing active or retained connections", async () => {
  await using dir = await tmpdir()
  const pool = NativeRuntime.create()
  await pool.configure({ ...config, limit: 4 })
  try {
    const active = await pool.acquire({ ...options, id: "one" })
    const idle = await pool.acquire({ ...options, id: "two" })
    await idle.release(true)
    const other = await pool.acquire({ ...options, directory: dir.path, id: "other" })
    await other.release(true)
    expect(await pool.refresh({ directory: options.directory, home: "different-home" })).toBe(true)
    expect(idle.client.closed).toBe(false)
    expect(await idle.client.request<number>("reloads")).toBe(0)
    expect(await pool.refresh({ directory: options.directory, home: active.home! })).toBe(true)
    expect(idle.client.closed).toBe(false)
    expect(active.client.closed).toBe(false)
    expect(other.client.closed).toBe(false)
    expect(await idle.client.request<number>("reloads")).toBe(1)
    expect(await active.client.request<number>("reloads")).toBe(1)
    expect(await other.client.request<number>("reloads")).toBe(0)
    expect(await active.client.request<string>("echo", { value: "still running" })).toBe("still running")
    await active.release(true)
    expect(active.client.closed).toBe(false)
  } finally {
    await pool.dispose()
  }
})

test("unsupported credential refresh leaves the existing connection usable and retained", async () => {
  const pool = NativeRuntime.create()
  await pool.configure(config)
  try {
    const lease = await pool.acquire({ ...options, id: "one", args: [...options.args, "--reject-reload"] })
    await lease.release(true)
    expect(await pool.refresh({ directory: options.directory, home: lease.home! })).toBe(false)
    expect(lease.client.closed).toBe(false)
    const next = await pool.acquire({ ...options, id: "one" })
    expect(next.client).toBe(lease.client)
    expect(await next.client.request<string>("echo", { value: "still usable" })).toBe("still usable")
    await next.release(true)
    expect(next.client.closed).toBe(false)
  } finally {
    await pool.dispose()
  }
})

test("handoff checks cannot close a lease that became active while checking native state", async () => {
  const pool = NativeRuntime.create()
  await pool.configure(config)
  try {
    const lease = await pool.acquire({ ...options, id: "one" })
    lease.bind("thread-one")
    await lease.release(true)
    await expect(
      pool.handoff("one", async () => {
        throw new Error("Native task is running")
      }),
    ).rejects.toThrow("running")
    expect(lease.client.closed).toBe(false)
    const gate = Promise.withResolvers<void>()
    const pending = pool
      .handoff("one", async (entry) => {
        expect(entry.thread).toBe("thread-one")
        await gate.promise
      })
      .catch((error: unknown) => error)
    const active = await pool.acquire({ ...options, id: "one" })
    gate.resolve()
    expect(String(await pending)).toContain("changed")
    expect(active.client.closed).toBe(false)
    await active.release(true)
  } finally {
    await pool.dispose()
  }
})
