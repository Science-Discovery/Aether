import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { controlHandler } from "../src/control"
import { Aether } from "../src/aether"
import { Engine } from "../src/engine"
import { Store } from "../src/store"
import { NativeCoordinator } from "../src/native"

test("headless control requires authentication, validates session identity and filters raw tools", async () => {
  const store = new Store(":memory:")
  let directory = "/fixture/work"
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/message")) return Response.json([
      { info: { id: "msg_user", role: "user" }, parts: [{ type: "text", text: "hello" }] },
      { info: { id: "msg_reply", role: "assistant", parentID: "msg_user" }, parts: [
        { type: "text", text: "done" }, { type: "reasoning", text: "private reasoning" },
        { type: "tool", tool: "bash", state: { status: "completed", input: "secret input", output: "secret output" } },
      ] },
    ])
    return Response.json({ id: "ses_fixture", directory })
  } })
  store.save({ id: "ticket_fixture", title: "fixture", session: "ses_fixture", directory, state: "waiting", result: "done" })
  const engine = new Engine(store, new Aether(backend.url.origin), { repo: "/fixture", state: "/fixture/state", base: "HEAD", workers: 2 })
  const serve = controlHandler(engine, "fixture-token")
  const call = (route: string, headers: Record<string, string> = { Authorization: "Bearer fixture-token" }) => serve(new Request(`http://127.0.0.1:19700${route}`, { headers }))
  try {
    const root = await call("/", {})
    expect(root.headers.get("Content-Type")).toContain("application/json")
    expect(await root.json()).toMatchObject({ service: "aether-superagent" })
    expect((await call("/panel/state", {})).status).toBe(401)
    expect((await call("/panel/state", { Authorization: "Bearer fixture-token", Origin: "https://foreign.invalid" })).status).toBe(403)
    expect((await call("/panel/state", { Cookie: "aether_superagent=fixture-token" })).status).toBe(401)
    const state = await call("/panel/state").then((response) => response.json())
    expect(state.config.aether).toBe(backend.url.origin)
    expect(JSON.stringify(state)).not.toContain("fixture-token")
    expect(state.tokenPath).toBeUndefined()
    expect(await call("/tickets/ticket_fixture/open").then((response) => response.json())).toEqual({ directory, session: "ses_fixture" })
    expect((await call("/tickets/ticket_fixture/open?directory=/elsewhere")).status).toBe(400)
    const response = await call("/tickets/ticket_fixture/conversation")
    const history = await response.text()
    expect(history).toContain("bash · completed")
    expect(history).not.toContain("secret")
    expect(history).not.toContain("private reasoning")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    directory = "/other/backend"
    expect((await call("/tickets/ticket_fixture/open")).status).toBe(409)
    expect((await call("/tickets/ticket_fixture/conversation")).status).toBe(409)
    expect((await call("/tickets/missing/open")).status).toBe(404)
  } finally { backend.stop(true); store.db.close() }
})


test("repo-free control accepts explicit projects and health checks use the coordinator directory", async () => {
  const store = new Store(":memory:")
  let observed = ""
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url)
    observed = url.searchParams.get("directory") ?? ""
    return Response.json({ healthy: true })
  } })
  const engine = new Engine(store, new Aether(backend.url.origin), { state: "/fixture/state", workers: 2 })
  // Keep this HTTP boundary test from scheduling filesystem operations.
  engine.closed = true
  const serve = controlHandler(engine, "fixture-token")
  const call = (route: string, body?: object) => serve(new Request(`http://127.0.0.1:19700${route}`, {
    method: body ? "POST" : "GET", headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }))
  try {
    expect(await call("/panel/connection").then((response) => response.json())).toEqual({ ok: true })
    expect(observed).toBe(engine.directory)
    const accepted = await call("/tickets", { key: "explicit", title: "Monitor", text: "Check progress", project: "/fixture/project" })
    expect(accepted.status).toBe(202)
    const input = await accepted.json()
    const snapshot = await call("/panel/state").then((response) => response.json())
    expect(snapshot.config.repo).toBeUndefined()
    expect(snapshot.tickets[0].project.directory).toBe("/fixture/project")
    expect((await call(`/tickets/${input.ticket}/messages`, { key: "move", text: "Continue", project: "/fixture/other" })).status).toBe(400)
  } finally { backend.stop(true); store.db.close() }
})


test("panel distinguishes native master activity, missing sessions and backend failures without inventing research tasks", async () => {
  const store = new Store(":memory:")
  let mode = "busy"
  const master = { session: "ses_master", directory: "/fixture/master", created: Date.now() }
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url)
    if (mode === "failure") return new Response("offline", { status: 503 })
    if (url.pathname === "/session/ses_master") return Response.json({ id: master.session,
      directory: mode === "wrong" ? "/other" : master.directory }, { status: mode === "missing" ? 404 : 200 })
    if (url.pathname === "/session/status") return Response.json(mode === "idle" ? {} : { [master.session]: { type: mode } })
    return new Response("not found", { status: 404 })
  } })
  const engine = new Engine(store, new Aether(backend.url.origin), { state: "/fixture/state", workers: 2 })
  const native = new NativeCoordinator(engine)
  const serve = controlHandler(engine, "fixture-token", native)
  const read = () => serve(new Request("http://127.0.0.1:19700/panel/state", { headers: { Authorization: "Bearer fixture-token" } })).then((r) => r.json())
  try {
    expect((await read()).native.activity).toBe("not_started")
    store.db.query("INSERT INTO native_master VALUES (?,?)").run(master.session, JSON.stringify(master))
    store.setting("native:master", master.session)
    for (const status of ["busy", "retry", "idle", "missing", "wrong", "failure"]) {
      mode = status
      const state = await read()
      expect(state.native.activity).toBe(["busy", "retry", "idle"].includes(status) ? status : "unavailable")
      expect(state.tickets).toHaveLength(0)
    }
  } finally { backend.stop(true); store.db.close() }
})

test("workspace changes persist without rebinding existing tickets and reject unsafe paths", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "superagent-workdir-")))
  const cfg = { state: path.join(root, "state"), workers: 2 }
  const project = path.join(root, "research")
  const workspace = path.join(root, "custom")
  const store = new Store(path.join(root, "state.db"))
  const backend = new Aether("http://127.0.0.1:1")
  const engine = new Engine(store, backend, cfg)
  const serve = controlHandler(engine, "token", new NativeCoordinator(engine))
  const save = (workdir: string) => serve(new Request("http://localhost/native/settings", {
    method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ workdir }),
  }))
  try {
    const previous = engine.submit("old", "inspect", undefined, "Old", undefined, project)
    const original = store.ticket(previous.ticket!)!
    expect(original.directory).toBe(path.join(cfg.state, "work", original.id))
    expect((await save(workspace)).ok).toBe(true)
    const next = engine.submit("new", "inspect", undefined, "New", undefined, project)
    const ticket = store.ticket(next.ticket!)!
    expect(ticket.directory).toBe(path.join(workspace, "work", ticket.id))
    expect((await save(ticket.directory)).status).toBe(400)
    expect((await save(project)).status).toBe(400)
    expect((await save("relative")).status).toBe(400)
    const file = path.join(root, "file")
    await writeFile(file, "preserve")
    expect((await save(file)).status).toBe(400)
    expect(new Engine(store, backend, cfg).workspace()).toBe(workspace)
    expect(store.ticket(original.id)).toEqual(original)
    const reset = await save("")
    expect(reset.ok).toBe(true)
    expect((await reset.json()).workspace.directory).toBe(cfg.state)
    expect(store.ticket(ticket.id)).toEqual(ticket)
  } finally {
    store.db.close()
    await rm(root, { recursive: true, force: true })
  }
})
