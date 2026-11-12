import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { test, expect } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, access, stat } from "node:fs/promises"
import path from "node:path"
import { git } from "../src/workspace"

test("CLI starts, authenticates, executes, releases lock and restores receipts", async () => {
  const root = process.env.SUPERAGENT_TEST_ROOT ?? path.join(homedir(), "data/aether-superagent-tests")
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(path.join(root, "cli-"))
  const repo = path.join(dir, "repo")
  const state = path.join(dir, "state")
  await mkdir(repo)
  await git(repo, "init")
  await git(repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "fixture")
  const sessions = new Map<string, object>()
  const backend = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/project/open") return Response.json({ id: "fixture" })
      if (url.pathname === "/session/status") return Response.json({})
      if (url.pathname === "/session" && request.method === "POST") {
        const body = await request.json() as { id: string }
        const session = { ...body, directory: url.searchParams.get("directory") }
        sessions.set(body.id, session)
        return Response.json(session)
      }
      const match = url.pathname.match(/^\/session\/([^/]+)(\/message)?$/)
      if (match && !match[2]) return Response.json(sessions.get(match[1]!) ?? {}, { status: sessions.has(match[1]!) ? 200 : 404 })
      if (match && request.method === "POST") {
        const body = await request.json() as { messageID: string }
        return Response.json({ info: { id: "msg_fixture", role: "assistant", parentID: body.messageID, finish: "stop" }, parts: [{ type: "text", text: "CLI fixture result" }] })
      }
      return new Response("Not found", { status: 404 })
    },
  })
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port!
  reservation.stop(true)
  const config = path.join(dir, "config.json")
  await writeFile(config, JSON.stringify({ repo, state, aether: backend.url.origin, port }))
  const launch = (name: string) => Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/main.ts"), config], {
    stdout: Bun.file(path.join(dir, `${name}.log`)), stderr: Bun.file(path.join(dir, `${name}.err`)),
  })
  let child = launch("first")
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`CLI exited: ${await Bun.file(path.join(dir, "first.err")).text()}`)
      if (await fetch(`http://127.0.0.1:${port}/health`).then((x) => x.ok).catch(() => false)) return
      await Bun.sleep(25)
    }
    throw new Error("CLI did not start")
  }
  try {
    await wait()
    const token = await readFile(path.join(state, "token"), "utf8")
    const socket = path.join(state, "control.sock")
    expect((await stat(socket)).mode & 0o777).toBe(0o600)
    expect((await fetch(`http://127.0.0.1:${port}/panel/state`, { unix: socket })).status).toBe(401)
    const snapshot = await fetch(`http://127.0.0.1:${port}/panel/state`, {
      unix: socket, headers: { Authorization: `Bearer ${token}` },
    }).then((response) => response.json())
    expect(snapshot.config.aether).toBe(backend.url.origin + "/")
    const call = (route: string, body?: object) => fetch(`http://127.0.0.1:${port}${route}`, {
      method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })
    expect((await fetch(`http://127.0.0.1:${port}/tickets`)).status).toBe(401)
    const duplicate = launch("duplicate")
    expect(await duplicate.exited).not.toBe(0)
    expect((await access(path.join(state, "owner.json")).then(() => true))).toBe(true)
    const request = { key: "cli-1", title: "CLI task", text: "Do the fixture task." }
    const accepted = await call("/tickets", request).then((x) => x.json()) as { id: string; ticket: string }
    let ticket: { state: string; result: string } | undefined
    for (let i = 0; i < 100; i++) {
      ticket = await call(`/tickets/${accepted.ticket}`).then((x) => x.json()) as typeof ticket
      if (ticket?.state === "waiting") break
      await Bun.sleep(25)
    }
    expect(ticket?.result).toBe("CLI fixture result")
    expect((await call("/tickets", request).then((x) => x.json()) as { id: string }).id).toBe(accepted.id)
    child.kill("SIGTERM")
    await child.exited
    expect(await access(path.join(state, "owner.json")).then(() => true).catch(() => false)).toBe(false)
    // Simulate the older installation identity and missing per-task binding,
    // then restart with repo removed from config: provenance must survive.
    const db = new Database(path.join(state, "superagent.db"))
    const base = await git(repo, "rev-parse", "HEAD")
    db.query("UPDATE setting SET value=? WHERE key='identity'").run(JSON.stringify({ repo, backend: backend.url.origin + "/" }))
    db.query("INSERT INTO setting(key,value) VALUES('base',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(base)
    db.query("DELETE FROM setting WHERE key=?").run(`project:${accepted.ticket}`)
    db.close()
    await writeFile(config, JSON.stringify({ state, aether: backend.url.origin, port }))
    child = launch("second")
    await wait()
    expect((await call(`/inputs/${accepted.id}`).then((x) => x.json()) as { state: string }).state).toBe("done")
    const migrated = await call("/panel/state").then((response) => response.json())
    expect(migrated.tickets.find((item: { id: string }) => item.id === accepted.ticket).project).toEqual({ directory: repo, repo, base })
    expect(sessions.size).toBe(1)
    await writeFile(path.join(dir, "receipt.json"), JSON.stringify({ passed: true, input: accepted.id, ticket: accepted.ticket, directory: dir }, null, 2))
  } finally {
    child.kill("SIGTERM")
    await child.exited
    backend.stop(true)
  }
}, 20_000)

test("setup and CLI start without any Git project, and reject another backend on restart", async () => {
  const root = process.env.SUPERAGENT_TEST_ROOT ?? path.join(homedir(), "data/aether-superagent-tests")
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(path.join(root, "cli-projectless-"))
  const data = path.join(dir, "data")
  const state = path.join(data, "aether", "superagent")
  const config = path.join(dir, "config.json")
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ healthy: true }) })
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port!
  reservation.stop(true)
  const setup = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../scripts/setup.ts"),
    "--file", config, "--port", String(port), "--aether", backend.url.origin], { env: { ...process.env, XDG_DATA_HOME: data }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  expect(await setup.exited).toBe(0)
  const value = JSON.parse(await readFile(config, "utf8"))
  expect(value.state).toBe(state)
  expect(value.repo).toBeUndefined()
  expect(value.base).toBeUndefined()
  const launch = (name: string) => Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/main.ts"), config], {
    stdout: Bun.file(path.join(dir, `${name}.log`)), stderr: Bun.file(path.join(dir, `${name}.err`)),
  })
  let child = launch("projectless")
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(await Bun.file(path.join(dir, "projectless.err")).text())
      if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)) { ready = true; break }
      await Bun.sleep(25)
    }
    expect(ready).toBe(true)
    const token = (await readFile(path.join(state, "token"), "utf8")).trim()
    const request = await fetch(`http://127.0.0.1:${port}/tickets`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ key: "needs-project", title: "inspect", text: "inspect the project" }),
    })
    expect(request.ok).toBe(false)
    expect(await request.text()).toContain("project directory")
    expect(await access(path.join(state, ".git")).then(() => true).catch(() => false)).toBe(false)
    expect(await access(path.join(dir, ".git")).then(() => true).catch(() => false)).toBe(false)
    child.kill("SIGTERM"); await child.exited
    await writeFile(config, JSON.stringify({ ...value, aether: "http://127.0.0.1:1" }))
    child = launch("mismatch")
    expect(await child.exited).not.toBe(0)
    expect(await readFile(path.join(dir, "mismatch.err"), "utf8")).toContain("another Aether server")
  } finally { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; backend.stop(true) }
}, 15_000)
