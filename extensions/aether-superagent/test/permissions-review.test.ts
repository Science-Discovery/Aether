import { afterEach, beforeEach, expect, test } from "bun:test"
import { Aether } from "../src/aether"
import { Engine } from "../src/engine"
import { Store, type Ticket } from "../src/store"
import { NativeCoordinator } from "../src/native"
import { TaskPermissions } from "../src/permissions"
import { controlHandler } from "../src/control"

type Rule = { permission: string; pattern: string; action: string }
type Remote = { id: string; directory: string; permission: Rule[]; mode?: string; busy: boolean }
const full = (): Rule[] => [{ permission: "*", pattern: "*", action: "allow" }]
let server: ReturnType<typeof Bun.serve>, store: Store, engine: Engine, permissions: TaskPermissions
let tickets: Ticket[], sessions: Map<string, Remote>
let pending: { id: string; sessionID: string; permission: string; patterns: string[] }[]
let calls: { method: string; path: string; directory: string | null; body: any }[]
let onAbort: ((value: Remote) => void) | undefined, onStatus: (() => void) | undefined
let onPatch: (() => Promise<void>) | undefined
let losePatch: boolean

beforeEach(() => {
  calls = []; pending = []; sessions = new Map(); onAbort = undefined; onStatus = undefined; onPatch = undefined; losePatch = false
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "GET" ? undefined : await request.json()
    calls.push({ method: request.method, path: url.pathname, directory: url.searchParams.get("directory"), body })
    const session = sessions.get(url.pathname.split("/")[2]!)
    if (url.pathname === "/session/status") {
      onStatus?.(); onStatus = undefined
      return Response.json(Object.fromEntries([...sessions].map(([id, value]) => [id, { type: value.busy ? "busy" : "idle" }])))
    }
    if (url.pathname === "/permission") return Response.json(pending)
    if (url.pathname.startsWith("/permission/") && request.method === "POST") {
      const id = decodeURIComponent(url.pathname.split("/")[2]!)
      pending = pending.filter((item) => item.id !== id)
      return Response.json(true)
    }
    if (!session) return Response.json({ error: "missing" }, { status: 404 })
    if (url.pathname.endsWith("/abort")) {
      session.busy = false; onAbort?.(session); return Response.json(true)
    }
    if (url.pathname.endsWith("/preference")) {
      if (request.method === "PATCH") {
        await onPatch?.()
        // Match Aether: unchanged mode does not write permissions again.
        if (body.mode !== session.mode) session.permission = body.mode === "full" ? full() : []
        session.mode = body.mode
        if (losePatch) { losePatch = false; return Response.json({ error: "Response lost after persistence" }, { status: 500 }) }
      }
      return Response.json(session.mode ? { sessionID: session.id, mode: session.mode, autoAccept: session.mode === "full" } : null)
    }
    return Response.json({ id: session.id, directory: session.directory, permission: session.permission })
  } })
  store = new Store(":memory:")
  engine = new Engine(store, new Aether(server.url.origin), { repo: "/fixture/repo", state: "/fixture/state", base: "HEAD", workers: 2 })
  tickets = [engine.ticket("Task A"), engine.ticket("Task B")]
  for (const ticket of tickets) {
    store.save({ ...ticket, state: "running" })
    sessions.set(ticket.session, { id: ticket.session, directory: ticket.directory, permission: [], busy: false })
  }
  permissions = new TaskPermissions(engine)
})
afterEach(() => { engine.closed = true; server.stop(true); store.db.close() })
const remote = (index = 0) => sessions.get(tickets[index]!.session)!
const ask = (id: string, index = 0) => pending.push({ id, sessionID: tickets[index]!.session, permission: "external_read", patterns: ["/fixture/evidence/*"] })
const patches = () => calls.filter((call) => call.method === "PATCH")

test("task trust only approves exact-session pending requests once, including later cached-turn asks", async () => {
  ask("per_a"); ask("per_b", 1)
  await permissions.trust(tickets[0]!.id, true, true)
  expect(remote().permission).toEqual(full()); expect(remote(1).permission).toEqual([])
  expect(pending.map((item) => item.id)).toEqual(["per_b"])
  ask("per_later")
  await permissions.tick()
  expect(pending.map((item) => item.id)).toEqual(["per_b"])
  expect(calls.filter((call) => call.path.endsWith("/reply")).map((call) => call.body.reply)).toEqual(["once", "once"])
  expect(patches()).toHaveLength(1)
  remote().busy = true
  await permissions.trust(tickets[0]!.id, false, true)
  const stop = calls.findIndex((call) => call.path.endsWith("/abort"))
  const restore = calls.findIndex((call) => call.body?.mode === "off")
  expect(restore).toBeGreaterThanOrEqual(0); expect(stop).toBeGreaterThan(restore)
  expect(remote().mode).toBe("off"); expect(remote().permission).toEqual([])
  expect(() => permissions.assertUninstallable()).not.toThrow()
})

test("lost grant response and backend preference reset recover from journal without replaying PATCH", async () => {
  losePatch = true
  await expect(permissions.trust(tickets[0]!.id, true, true)).rejects.toThrow("500")
  expect(remote().permission).toEqual(full())
  expect(() => permissions.assertUninstallable()).toThrow()
  permissions = new TaskPermissions(engine)
  remote().mode = undefined // Aether process restarted; persisted session rules remain.
  await permissions.trust(tickets[0]!.id, true, true)
  expect(patches()).toHaveLength(1)
  await permissions.trust(tickets[0]!.id, false, true)
  expect(remote().permission).toEqual([]); expect(remote().mode).toBe("off")
})

test("custom policy is not overwritten and externally imposed full mode is never adopted", async () => {
  remote().permission = [{ permission: "bash", pattern: "*", action: "deny" }]
  await expect(permissions.trust(tickets[0]!.id, true, true)).rejects.toThrow("策略")
  remote().permission = []; remote().mode = "safe"
  await expect(permissions.trust(tickets[0]!.id, true, true)).rejects.toThrow("策略")
  remote().permission = full(); remote().mode = "full"
  await expect(permissions.trust(tickets[0]!.id, true, true)).rejects.toThrow("策略")
  const item = (await permissions.list()).tickets.find((item) => item.ticket === tickets[0]!.id)!
  expect(item).toMatchObject({ externalFull: true, managed: false, trusted: false })
  expect(patches()).toHaveLength(0)
})

test("revoke preserves a safe-mode change made while the current turn aborts", async () => {
  await permissions.trust(tickets[0]!.id, true, true)
  remote().busy = true
  onAbort = (value) => { value.mode = "safe"; value.permission = [] }
  await expect(permissions.trust(tickets[0]!.id, false, true)).rejects.toThrow()
  expect(remote().mode).toBe("safe")
  expect(patches().filter((call) => call.body.mode === "off")).toHaveLength(1)
  const abort = calls.findIndex((call) => call.path.endsWith("/abort"))
  expect(abort).toBeGreaterThanOrEqual(0)
  expect(calls.slice(abort + 1).filter((call) => call.method === "PATCH")).toHaveLength(0)
  expect(() => permissions.assertUninstallable()).toThrow()
})

test("revoke cannot declare success if permissions become full after its original-state check", async () => {
  await permissions.trust(tickets[0]!.id, true, true)
  remote().mode = "off"; remote().permission = []
  onStatus = () => { remote().mode = "full"; remote().permission = full() }
  const result = await permissions.trust(tickets[0]!.id, false, true).then(() => "restored", () => "conflict")
  if (result === "restored") {
    expect(remote().permission).toEqual([]); expect(remote().mode).toBe("off")
  } else expect(() => permissions.assertUninstallable()).toThrow()
})

test("revoking a still-busy session leaves a recovery record and stops automatic approval", async () => {
  await permissions.trust(tickets[0]!.id, true, true)
  remote().busy = true
  onAbort = (value) => { value.busy = true }
  await expect(permissions.trust(tickets[0]!.id, false, true)).rejects.toThrow("尚未停止")
  ask("per_after_failed_abort")
  await permissions.tick()
  expect(pending.map((item) => item.id)).toContain("per_after_failed_abort")
  expect(() => permissions.assertUninstallable()).toThrow()
  remote().busy = false; onAbort = undefined
  await permissions.trust(tickets[0]!.id, false, true)
  expect(remote().permission).toEqual([])
})

test("a lost revoke response retains its journal and resumes without another permissions PATCH", async () => {
  await permissions.trust(tickets[0]!.id, true, true)
  remote().busy = true; losePatch = true
  await expect(permissions.trust(tickets[0]!.id, false, true)).rejects.toThrow("500")
  expect(remote().permission).toEqual([])
  expect(remote().busy).toBe(true)
  expect(() => permissions.assertUninstallable()).toThrow()
  ask("per_during_recovery")
  permissions = new TaskPermissions(engine)
  await permissions.tick()
  expect(pending.map((item) => item.id)).toContain("per_during_recovery")
  await permissions.trust(tickets[0]!.id, false, true)
  expect(patches()).toHaveLength(2)
  expect(remote().busy).toBe(false)
  expect(() => permissions.assertUninstallable()).not.toThrow()
})

test("control rejects unauthorized trust and permission IDs belonging to another ticket", async () => {
  const native = new NativeCoordinator(engine)
  const serve = controlHandler(engine, "fixture-token", native, permissions)
  const send = (body: unknown, auth = true) => serve(new Request("http://127.0.0.1:19700/requests", {
    method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer fixture-token" } : {}) }, body: JSON.stringify(body),
  }))
  expect((await send({ native: { path: "/native/trust", body: { ticket: tickets[0]!.id, trusted: true, confirm: true } } }, false)).status).toBe(401)
  expect((await send({ native: { path: "/native/trust", body: { ticket: "../../other", trusted: true, confirm: true } } })).status).toBe(409)
  ask("per_b", 1)
  expect((await send({ native: { path: "/native/permission", body: { ticket: tickets[0]!.id, request: "per_b", reply: "once" } } })).status).toBe(409)
  expect((await send({ native: { path: "/native/permission", body: { ticket: tickets[1]!.id, request: "per_b", reply: "always" } } })).status).toBe(409)
  expect((await send({ native: { path: "/native/tool", body: { name: "trust", args: { ticket: tickets[0]!.id, trusted: true, confirm: true }, context: {} } } })).status).toBe(400)
  expect(patches()).toHaveLength(0)
  expect(pending).toHaveLength(1)
})

test("uninstall refuses an in-flight grant, preserving its recovery record and allowing revoke while disabled", async () => {
  const native = new NativeCoordinator(engine)
  const serve = controlHandler(engine, "fixture-token", native, permissions)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const barrier = new Promise<void>((resolve) => { release = resolve })
  onPatch = async () => { entered(); await barrier }
  const grant = permissions.trust(tickets[0]!.id, true, true)
  await started
  try {
    const response = await serve(new Request("http://127.0.0.1:19700/requests", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-token" },
      body: JSON.stringify({ native: { path: "/native/uninstall", body: { confirm: true } } }),
    }))
    expect(response.status).toBe(409)
    expect(await response.text()).toContain("权限操作正在进行")
    expect(store.setting("native:uninstalled")).not.toBe("true")
  } finally { release(); onPatch = undefined }
  await grant
  expect(native.settings().enabled).toBe(false)
  expect(() => permissions.assertUninstallable()).toThrow()
  await permissions.trust(tickets[0]!.id, false, true)
  expect(remote().permission).toEqual([])
  expect(() => permissions.assertUninstallable()).not.toThrow()
})
