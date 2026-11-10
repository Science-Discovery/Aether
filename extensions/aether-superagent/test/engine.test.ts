import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Aether, type Message } from "../src/aether"
import { Engine, type Config } from "../src/engine"
import { Store, id } from "../src/store"
import { git } from "../src/workspace"
import { handler } from "../src/http"

type Prompt = { session: string; directory: string; body: { messageID: string; parts: { text: string }[]; format?: unknown } }
function result(parentID: string, value = "fixture complete"): Message {
  return { info: { id: `assistant-${parentID}`, role: "assistant", parentID, finish: "stop" }, parts: [{ type: "text", text: value }] }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out awaiting fixture condition")
    await Bun.sleep(5)
  }
}
class FakeAether {
  calls: Prompt[] = []
  registered = new Set<string>()
  events: { method: string; path: string; directory: string }[] = []
  sessions = new Map<string, { id: string; directory: string; permission?: { permission: string; pattern: string; action: string }[] }>()
  histories = new Map<string, Message[]>()
  aborted: string[] = []
  status: () => Promise<Response> = async () => Response.json({})
  prompt: (call: Prompt) => Promise<Response> = async (call) => Response.json(result(call.body.messageID))
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const url = new URL(request.url)
    const directory = url.searchParams.get("directory")!
    this.events.push({ method: request.method, path: url.pathname, directory })
    if (url.pathname === "/project/open" && request.method === "POST") {
      const body = await request.json() as { directory?: unknown }
      if (typeof body.directory !== "string" || !path.isAbsolute(body.directory) ||
        !await stat(body.directory).then((entry) => entry.isDirectory(), () => false))
        return Response.json({ error: "Directory not found" }, { status: 400 })
      this.registered.add(body.directory)
      return Response.json({ id: `fixture:${body.directory}`, worktree: body.directory })
    }
    if (url.pathname.startsWith("/session") && !this.registered.has(directory))
      return Response.json({ error: "Project database not registered for directory" }, { status: 500 })
    if (url.pathname === "/session/status") return this.status()
    if (url.pathname === "/session" && request.method === "POST") {
      const body = await request.json() as { id: string; permission?: { permission: string; pattern: string; action: string }[] }
      const session = { id: body.id, directory, permission: body.permission }
      this.sessions.set(body.id, session)
      return Response.json(session)
    }
    const matched = url.pathname.match(/^\/session\/([^/]+)(?:\/(message|abort))?$/)
    if (!matched) return new Response("unknown fixture route", { status: 404 })
    const session = matched[1]!
    if (!matched[2]) return this.sessions.has(session) ? Response.json(this.sessions.get(session)) : new Response("not found", { status: 404 })
    if (matched[2] === "abort") { this.aborted.push(session); return Response.json(true) }
    if (request.method === "GET") return Response.json(this.histories.get(session) ?? [])
    const call = { session, directory, body: await request.json() as Prompt["body"] }
    this.calls.push(call)
    return this.prompt(call)
  } })
  client() { return new Aether(this.server.url.toString(), undefined, 10_000) }
}
let dir: string, file: string, config: Config, store: Store, engine: Engine, fake: FakeAether
let releaseAll: (() => void)[] = []
beforeEach(async () => {
  const root = path.join(process.env.HOME!, "data", "aether-superagent-tests")
  await mkdir(root, { recursive: true })
  dir = await mkdtemp(path.join(root, "verification-"))
  const repo = path.join(dir, "repository")
  await mkdir(repo)
  await git(repo, "init", "-b", "main")
  await writeFile(path.join(repo, "fixture.txt"), "independent verification fixture\n")
  await git(repo, "add", "fixture.txt")
  await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture")
  const state = path.join(dir, "state")
  await mkdir(state)
  config = { repo, state, base: "HEAD", workers: 2 }
  file = path.join(state, "state.sqlite")
  store = new Store(file)
  fake = new FakeAether()
  engine = new Engine(store, fake.client(), config)
  releaseAll = []
})
afterEach(async () => {
  engine.closed = true
  for (const release of releaseAll) release()
  await Promise.allSettled([...engine.active.values()])
  fake.server.stop(true)
  store.db.close()
})
async function registerPreviousProject(directory: string) {
  await mkdir(directory, { recursive: true })
  await fake.client().request(directory, "/project/open", { directory })
}
async function drain() { await Promise.all([...engine.active.values()]) }
function hold() { const gate = deferred(); releaseAll.push(gate.resolve); return gate }

describe("independent durable coordinator verification (local fake Aether only)", () => {
  test("same durable request key produces one input and ticket across database reopen", async () => {
    const original = engine.submit("same", "implement fixture", undefined, "Fixture")
    expect(engine.submit("same", "implement fixture", undefined, "Fixture")).toEqual(original)
    const router = engine.router
    store.db.close()
    store = new Store(file)
    engine = new Engine(store, fake.client(), config)
    expect(engine.router).toBe(router)
    expect(engine.submit("same", "implement fixture", undefined, "Fixture")).toEqual(original)
    expect(store.inputs()).toHaveLength(1)
    expect(store.tickets()).toHaveLength(1)
    engine.tick(); await drain(); engine.tick(); await drain()
    expect(fake.calls).toHaveLength(1)
    expect(store.input(original.id)?.state).toBe("done")
  })

  test("conflicting content, title, or target under the same key is rejected atomically", () => {
    const original = engine.submit("conflict", "do A", undefined, "A")
    expect(() => engine.submit("conflict", "do B", undefined, "A")).toThrow("different request")
    expect(() => engine.submit("conflict", "do A", undefined, "B")).toThrow("different request")
    expect(() => engine.submit("conflict", "do A", original.ticket!)).toThrow("different request")
    expect(store.inputs()).toHaveLength(1)
    expect(store.tickets()).toHaveLength(1)
  })

  test("same ticket serializes turns; separate tickets overlap; maxWorkers caps occupied lanes", async () => {
    const gates = [hold(), hold(), hold(), hold()]
    let concurrent = 0, peak = 0
    fake.prompt = async (call) => {
      concurrent++; peak = Math.max(peak, concurrent)
      const index = fake.calls.indexOf(call)
      await gates[index]!.promise
      concurrent--
      return Response.json(result(call.body.messageID))
    }
    const first = engine.submit("a1", "A first", undefined, "A")
    const second = engine.submit("a2", "A second", first.ticket!)
    const other = engine.submit("b1", "B first", undefined, "B")
    const third = engine.submit("c1", "C first", undefined, "C")
    engine.tick()
    await until(() => fake.calls.length === 2)
    expect(fake.calls.map((c) => c.body.messageID).sort()).toEqual([first.message, other.message].sort())
    engine.tick(); await Bun.sleep(20)
    expect(fake.calls).toHaveLength(2)
    expect(store.input(second.id)?.state).toBe("pending")
    expect(store.input(third.id)?.state).toBe("pending")
    gates[0]!.resolve(); gates[1]!.resolve(); await drain()
    engine.tick(); await until(() => fake.calls.length === 4)
    expect(fake.calls[2]!.session).not.toBe(fake.calls[3]!.session)
    expect(peak).toBe(2)
    gates[2]!.resolve(); gates[3]!.resolve(); await drain()
    expect(store.inputs().every((x) => x.state === "done")).toBe(true)
  })

  test("HTTP 409 returns to pending and retries with the same message ID", async () => {
    fake.prompt = async (call) => fake.calls.length === 1 ? new Response("busy", { status: 409 }) : Response.json(result(call.body.messageID))
    const input = engine.submit("busy", "work", undefined, "Busy")
    engine.tick(); await drain()
    expect(store.input(input.id)?.state).toBe("pending")
    expect(store.ticket(input.ticket!)?.state).toBe("queued")
    engine.tick(); await drain()
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls.map((c) => c.body.messageID)).toEqual([input.message, input.message])
    expect(store.input(input.id)?.state).toBe("done")
  })

  test("HTTP 200 carrying info.error becomes uncertain, never successful", async () => {
    fake.prompt = async (call) => Response.json({ ...result(call.body.messageID), info: { ...result(call.body.messageID).info, error: { name: "FixtureModelError" } } })
    const input = engine.submit("error", "work", undefined, "Error")
    engine.tick(); await drain()
    expect(store.input(input.id)?.state).toBe("uncertain")
    expect(store.ticket(input.ticket!)?.state).toBe("attention")
    engine.tick(); await drain()
    expect(fake.calls).toHaveLength(1)
  })

  test("restart turns dispatching into uncertain and never automatically resends", async () => {
    const input = engine.submit("crash", "work", undefined, "Crash")
    store.put({ ...input, state: "dispatching" })
    store.save({ ...store.ticket(input.ticket!)!, state: "running" })
    store.db.close(); store = new Store(file); engine = new Engine(store, fake.client(), config)
    expect(store.input(input.id)?.state).toBe("uncertain")
    expect(store.ticket(input.ticket!)?.state).toBe("attention")
    engine.tick(); await drain()
    expect(fake.calls).toHaveLength(0)
    expect(store.inputs()).toHaveLength(1)
  })

  test("readback requires matching parentID and completed assistant; reconciliation only reads", async () => {
    const input = engine.submit("readback", "work", undefined, "Readback")
    store.put({ ...input, state: "uncertain" })
    const ticket = store.ticket(input.ticket!)!
    await registerPreviousProject(ticket.directory)
    fake.histories.set(ticket.session, [result("different-parent"), { ...result(input.message), info: { role: "user", id: "u", parentID: input.message, finish: "stop" } }])
    expect((await engine.reconcile(input.id))?.state).toBe("uncertain")
    fake.histories.set(ticket.session, [result(input.message, "verified output"), result("newer-unrelated", "wrong output")])
    expect((await engine.reconcile(input.id))?.state).toBe("done")
    expect(store.ticket(ticket.id)?.result).toBe("verified output")
    expect(fake.calls).toHaveLength(0)
  })

  test("immediate response with wrong parentID is not accepted", async () => {
    fake.prompt = async () => Response.json(result("wrong-parent"))
    const input = engine.submit("parent", "work", undefined, "Parent")
    engine.tick(); await drain()
    expect(store.input(input.id)?.state).toBe("uncertain")
  })

  test("router creates exactly one ticket and durable child input even if completion repeats", async () => {
    const route = engine.submit("route", "please implement fixture")
    let answer!: Message
    fake.prompt = async (call) => {
      answer = { ...result(call.body.messageID), info: { ...result(call.body.messageID).info, structured: { action: "create", ticket: "", title: "Routed fixture", text: "new work" } } }
      return Response.json(answer)
    }
    engine.tick(); await drain()
    expect(store.input(route.id)?.state).toBe("done")
    expect(fake.calls[0]!.body.format).toBeDefined()
    expect(store.tickets()).toHaveLength(1)
    expect(store.inputs()).toHaveLength(2)
    engine.complete(route, answer)
    engine.submit("route", "please implement fixture")
    expect(store.tickets()).toHaveLength(1)
    expect(store.inputs()).toHaveLength(2)
    expect(store.byKey(`route:${route.id}`)?.text).toBe("please implement fixture")
  })

  test("stop during an in-flight reply cancels inputs and cannot be revived by late completion", async () => {
    const gate = hold()
    fake.prompt = async (call) => { await gate.promise; return Response.json(result(call.body.messageID)) }
    const input = engine.submit("stop", "work", undefined, "Stop")
    const queued = engine.submit("stop-followup", "more work", input.ticket!)
    engine.tick(); await until(() => fake.calls.length === 1)
    await engine.stop(input.ticket!)
    expect(store.ticket(input.ticket!)?.state).toBe("stopped")
    expect(store.input(input.id)?.state).toBe("cancelled")
    expect(store.input(queued.id)?.state).toBe("cancelled")
    gate.resolve(); await drain(); engine.tick(); await drain()
    expect(store.ticket(input.ticket!)?.state).toBe("stopped")
    expect(fake.calls).toHaveLength(1)
    expect(fake.aborted).toEqual([store.ticket(input.ticket!)!.session])
    expect(() => engine.submit("revive", "again", input.ticket!)).toThrow("cannot be resumed")
    store.db.close(); store = new Store(file); engine = new Engine(store, fake.client(), config)
    expect(store.ticket(input.ticket!)?.state).toBe("stopped")
    engine.tick(); await drain(); expect(fake.calls).toHaveLength(1)
  })

  test("HTTP control surface requires token and exposes a persisted completed request", async () => {
    const serve = handler(engine, "test-secret")
    expect((await serve(new Request("http://fixture/inputs"))).status).toBe(401)
    const response = await serve(new Request("http://fixture/tickets", { method: "POST", headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" }, body: JSON.stringify({ key: "http", title: "HTTP fixture", text: "work" }) }))
    expect(response.status).toBe(202)
    const input = await response.json() as { id: string }
    await drain()
    const read = await serve(new Request(`http://fixture/inputs/${input.id}`, { headers: { Authorization: "Bearer test-secret" } }))
    expect((await read.json()).state).toBe("done")
  })

  test("IDs use Aether's six-byte timestamp encoding and expected cross-millisecond order", () => {
    const stamp = 1_794_182_400_000
    const clock = spyOn(Date, "now").mockReturnValue(stamp)
    try {
      const first = id("msg"), firstSession = id("ses")
      clock.mockReturnValue(stamp + 1)
      const next = id("msg"), nextSession = id("ses")
      for (const [value, time, descending] of [[first, stamp, false], [firstSession, stamp, true], [next, stamp + 1, false], [nextSession, stamp + 1, true]] as const) {
        expect(value).toHaveLength(30)
        expect(value.slice(4, 16)).toMatch(/^[0-9a-f]{12}$/)
        const encoded = BigInt(`0x${value.slice(4, 16)}`)
        const raw = descending ? (~encoded & ((1n << 48n) - 1n)) : encoded
        // Same six-byte extraction as Aether/packages/opencode/src/id/id.ts.
        // Low 12 bits are the implementation's sequence counter, not wall time.
        const input = (BigInt(time) << 12n) + (raw & 4095n)
        const bytes = Buffer.alloc(6)
        const ordered = descending ? ~input : input
        for (let i = 0; i < 6; i++) bytes[i] = Number((ordered >> BigInt(40 - 8 * i)) & 255n)
        expect(value.slice(4, 16)).toBe(bytes.toString("hex"))
        expect(raw >> 12n).toBe(BigInt(time) & ((1n << 36n) - 1n))
      }
      expect(first < next).toBe(true)
      expect(firstSession > nextSession).toBe(true)
    } finally { clock.mockRestore() }
  })

  test("an existing router with drifted permissions is rejected before any prompt", async () => {
    fake.sessions.set(engine.router, { id: engine.router, directory: engine.directory,
      permission: [{ permission: "*", pattern: "*", action: "allow" }] })
    const input = engine.submit("router-drift", "route fixture work")
    engine.tick(); await drain()
    expect(fake.calls).toHaveLength(0)
    expect(store.input(input.id)?.state).toBe("uncertain")
    expect(store.input(input.id)?.result).toContain("Router permissions changed")
    expect(store.tickets()).toHaveLength(0)
  })

  test("dismiss awaiting backend status cannot revive a concurrently stopped ticket", async () => {
    const input = engine.submit("dismiss-race", "work", undefined, "Dismiss race")
    store.put({ ...input, state: "uncertain" })
    store.save({ ...store.ticket(input.ticket!)!, state: "attention" })
    await registerPreviousProject(store.ticket(input.ticket!)!.directory)
    const gate = hold()
    let statuses = 0
    fake.status = async () => {
      statuses++
      if (statuses === 1) await gate.promise
      return Response.json({})
    }
    const dismissal = engine.dismiss(input.id)
    await until(() => statuses === 1)
    await engine.stop(input.ticket!)
    expect(store.ticket(input.ticket!)?.state).toBe("stopped")
    gate.resolve(); await dismissal
    expect(store.ticket(input.ticket!)?.state).toBe("stopped")
    expect(store.input(input.id)?.state).toBe("cancelled")
    expect(fake.calls).toHaveLength(0)
  })

  test("abort HTTP 200 while backend remains busy holds pending stop and worker capacity", async () => {
    config.workers = 1
    const input = engine.submit("busy-stop", "work", undefined, "Busy stop")
    const ticket = store.ticket(input.ticket!)!
    await registerPreviousProject(ticket.directory)
    // Model the disconnected coordinator's remote operation: no local active Promise,
    // but the backend still reports a running turn after accepting abort.
    store.put({ ...input, state: "uncertain" })
    fake.sessions.set(ticket.session, { id: ticket.session, directory: ticket.directory })
    fake.status = async () => Response.json({ [ticket.session]: { type: "busy" } })
    const waiting = engine.submit("next-worker", "new work", undefined, "Next worker")
    await engine.stop(ticket.id)
    expect(fake.aborted).toEqual([ticket.session])
    expect(store.setting(`stop:${ticket.id}`)).toBe("pending")
    expect(store.ticket(ticket.id)?.result).toContain("not yet confirmed")
    engine.tick(); await drain()
    expect(store.input(waiting.id)?.state).toBe("pending")
    expect(fake.calls).toHaveLength(0)
    fake.status = async () => Response.json({})
    await engine.stop(ticket.id)
    expect(store.setting(`stop:${ticket.id}`)).toBe("done")
    engine.tick(); await drain()
    expect(store.input(waiting.id)?.state).toBe("done")
    expect(fake.calls).toHaveLength(1)
  })


  test("session access requires explicit project registration and ensure opens the directory first", async () => {
    await mkdir(engine.directory, { recursive: true })
    await expect(fake.client().request(engine.directory, `/session/${engine.router}`)).rejects.toThrow("HTTP 500")
    expect(fake.registered.has(engine.directory)).toBe(false)
    await expect(fake.client().request(engine.directory, "/project/open", { directory: path.join(dir, "absent") })).rejects.toThrow("HTTP 400")
    const start = fake.events.length
    await fake.client().ensure(engine.directory, engine.router, "Router", true)
    expect(fake.registered.has(engine.directory)).toBe(true)
    expect(fake.events.slice(start).map((event) => `${event.method} ${event.path}`)).toEqual([
      "POST /project/open", `GET /session/${engine.router}`, "POST /session",
    ])
    await fake.client().ensure(engine.directory, engine.router, "Router", true)
    expect(fake.sessions.size).toBe(1)
    expect(fake.calls).toHaveLength(0)
  })

})
