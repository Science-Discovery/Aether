import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile, stat, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Store } from "../src/store"
import { Engine } from "../src/engine"
import { Aether, HttpError } from "../src/aether"
import { NativeCoordinator } from "../src/native"
import { controlHandler } from "../src/control"
import { install } from "../src/integration"
import { refreshInstallation } from "../src/lifecycle"
import { git } from "../src/workspace"

// Independent lifecycle fixtures: real installer, SQLite, coordinator and control
// handler; only remote Aether idle status is substituted. Never use live services.
let dir: string, root: string, state: string, bridge: string, token: string
let store: Store, engine: Engine, native: NativeCoordinator
let serve: ReturnType<typeof controlHandler>
const originals: Record<string, string> = {
  "packages/app/src/pages/layout/sidebar-shell.tsx": 'import { Icon } from "@opencode-ai/ui/icon"\n        <div class="shrink-0 w-full pt-3 pb-6 flex flex-col items-center gap-2">\n',
  "packages/opencode/src/server/server.ts": 'import { Hono } from "hono"\n      .route("/global", GlobalRoutes())\n',
  "packages/app/src/app.tsx": 'const HomeRoute = lazy(() => import("@/pages/home"))\n                  <Route path="/" component={HomeRoute} />\n',
  "packages/app/src/pages/layout.tsx": 'import { useNavigate, useParams } from "@solidjs/router"\n  const editor = createInlineEditorController()\n  async function navigateToProject(directory: string | undefined) {\n',
  "packages/app/src/components/dialog-settings.tsx": 'import { SettingsNative } from "./settings-native"\n                    <Tabs.Trigger value="cron">\n        <Tabs.Content value="cron" class="no-scrollbar">\n',
}
const options = () => ({ root, bridge, token, url: "http://127.0.0.1:19700" })
const exists = (file: string) => stat(file).then(() => true, () => false)
function call(route: string, body?: unknown, authorized = true) {
  return serve(new Request(`http://127.0.0.1:19700${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: "Bearer fixture-secret" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
}
const tunnel = (route: string, body: unknown) => call("/requests", { native: { path: route, body } })
async function panel() { return (await call("/panel/state")).json() }

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aether-lifecycle-review-"))
  root = path.join(dir, "Aether"); state = path.join(dir, "state")
  bridge = path.join(dir, "config", "superagent.json"); token = path.join(state, "token")
  await mkdir(root); await mkdir(state); await git(root, "init")
  for (const [name, content] of Object.entries(originals)) {
    const target = path.join(root, name)
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content)
  }
  await writeFile(token, "fixture-secret", { mode: 0o600 })
  store = new Store(path.join(state, "superagent.db"))
  engine = new Engine(store, new Aether("http://127.0.0.1:1"), { repo: root, state, base: "HEAD", workers: 1 })
  engine.aether.status = async () => "idle"
  // Prevent a regression from starting external execution while still observing
  // whether the endpoint admits new work into the real persistent input queue.
  engine.tick = () => {}
  native = new NativeCoordinator(engine)
  serve = controlHandler(engine, "fixture-secret", native)
  await install(options())
  await refreshInstallation(engine)
})
afterEach(() => { engine.closed = true; store.db.close() })

test("settings tunnel authenticates and cannot impersonate plugin tool context", async () => {
  expect((await call("/requests", { native: { path: "/native/settings", body: { enabled: false } } }, false)).status).toBe(401)
  expect(native.settings().enabled).toBe(true)
  expect((await tunnel("/native/settings", { schedule: { enabled: true, minutes: 17 } })).status).toBe(200)
  expect(native.settings()).toMatchObject({ checkinEnabled: true, checkinSeconds: 1020 })
  expect((await tunnel("/native/tool", { name: "dispatch", context: {}, args: { text: "must not dispatch" } })).status).toBe(400)
  expect(store.inputs()).toHaveLength(0)
  expect((await tunnel("/native/settings", { schedule: { enabled: true, minutes: 1441 } })).status).toBe(400)
  expect((await tunnel("/native/settings", { enabled: "false" })).status).toBe(400)
  expect((await tunnel("/native/settings", { root: "/other" })).status).toBe(400)
})

test("disabled setting blocks all legacy submissions but leaves records readable", async () => {
  const ticket = engine.ticket("Existing research")
  store.save(ticket)
  expect((await tunnel("/native/settings", { enabled: false })).status).toBe(200)
  for (const [route, body] of [
    ["/requests", { key: "legacy-route", text: "inspect" }],
    ["/tickets", { key: "legacy-new", text: "inspect", title: "New" }],
    [`/tickets/${ticket.id}/messages`, { key: "legacy-followup", text: "continue" }],
  ] as const) expect((await call(route, body)).status).toBeGreaterThanOrEqual(400)
  expect(store.inputs()).toHaveLength(0)
  expect((await call("/tickets")).status).toBe(200)
  expect((await panel()).native.enabled).toBe(false)
})

test("uninstall requires explicit confirmation and rejects busy secondary master", async () => {
  expect((await tunnel("/native/uninstall", { confirm: false })).status).toBe(400)
  expect(native.settings().enabled).toBe(true)
  for (const session of ["ses_busy", "ses_recent"]) store.db.query("INSERT INTO native_master VALUES (?,?)").run(session,
    JSON.stringify({ session, directory: path.join(state, session), created: Date.now() }))
  store.setting("native:master", "ses_recent")
  engine.aether.status = async (_directory, session) => session === "ses_busy" ? "busy" : "idle"
  const response = await tunnel("/native/uninstall", { confirm: true })
  expect(response.status).toBe(409)
  expect(native.settings().enabled).toBe(false)
  expect(native.installed()).toBe(true)
  expect(await exists(bridge)).toBe(true)
  expect(await exists(path.join(root, ".git/aether-superagent-install.json"))).toBe(true)
})

test("uninstall refuses unresolved inputs and preserves all managed files", async () => {
  const ticket = engine.ticket("Research")
  store.save(ticket)
  const input = engine.input("fixture", "Inspect", ticket.id)
  store.put({ ...input, state: "uncertain" })
  expect((await tunnel("/native/uninstall", { confirm: true })).status).toBe(409)
  expect(await exists(bridge)).toBe(true)
  expect(store.input(input.id)?.state).toBe("uncertain")
})

test("uninstall removes only managed files; reinstall retains research and stays disabled", async () => {
  const ticket = engine.ticket("Retained research")
  store.save({ ...ticket, state: "waiting", result: "Verified result" })
  await mkdir(ticket.directory, { recursive: true })
  const artifact = path.join(ticket.directory, "research.txt")
  await writeFile(artifact, "precious output")
  const userFile = path.join(path.dirname(bridge), "agents", "user-agent.md")
  await writeFile(userFile, "user-owned configuration")
  const editTarget = path.join(root, "packages/app/src/app.tsx")
  await writeFile(editTarget, "// user edit\n" + await readFile(editTarget, "utf8"))
  const oldGeneration = store.setting("native:installation")
  native.settings({ checkinEnabled: true, checkinSeconds: 1020 })
  const result = await tunnel("/native/uninstall", { confirm: true })
  expect(result.status).toBe(200)
  expect((await result.json()).retained).toContain("research records")
  expect(native.installed()).toBe(false)
  expect(await readFile(token, "utf8")).toBe("fixture-secret")
  expect(await readFile(artifact, "utf8")).toBe("precious output")
  expect(await readFile(userFile, "utf8")).toBe("user-owned configuration")
  expect(store.ticket(ticket.id)?.result).toBe("Verified result")
  expect(await exists(bridge)).toBe(false)
  expect(await exists(path.join(state, "integration.json"))).toBe(false)
  for (const [name, content] of Object.entries(originals))
    expect(await readFile(path.join(root, name), "utf8")).toBe((name.endsWith("/app.tsx") ? "// user edit\n" : "") + content)
  expect((await tunnel("/native/settings", { enabled: true })).status).toBe(400)
  await install(options())
  const next = await panel()
  expect(next.native.installed).toBe(true)
  expect(next.native.enabled).toBe(false)
  expect(next.native.schedule).toEqual({ enabled: true, minutes: 17 })
  expect(store.setting("native:installation")).not.toBe(oldGeneration)
  expect(store.ticket(ticket.id)?.result).toBe("Verified result")
  expect((await tunnel("/native/settings", { enabled: true })).status).toBe(200)
})

test("changed managed files block uninstall before any file removal", async () => {
  const file = path.join(root, "packages/app/src/addons/superagent/panel.tsx")
  const changed = await readFile(file, "utf8") + "\n// local customization\n"
  await writeFile(file, changed)
  const response = await tunnel("/native/uninstall", { confirm: true })
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(await readFile(file, "utf8")).toBe(changed)
  expect(await exists(bridge)).toBe(true)
  expect(await exists(path.join(state, "integration.json"))).toBe(true)
  expect(native.installed()).toBe(true)
  expect(native.settings().enabled).toBe(false)
})

test("first native open sets superagent preference before handing back navigation", async () => {
  const calls: { directory: string; route: string; body: unknown; method: unknown }[] = []
  engine.aether.ensure = async () => {}
  engine.aether.request = async (directory, route, body, method) => {
    calls.push({ directory, route, body, method }); return {} as any
  }
  const response = await tunnel("/native/open", {})
  expect(response.status).toBe(200)
  const target = await response.json()
  expect(calls).toContainEqual({ directory: target.directory, route: `/session/${target.session}/preference`, body: { agent: "superagent" }, method: "PATCH" })
})

test("unchanged task still receives periodic checks without adding no-change messages to main chat", async () => {
  const master = { session: "ses_main", directory: path.join(state, "main"), created: 1 }
  store.db.query("INSERT INTO native_master VALUES (?,?)").run(master.session, JSON.stringify(master))
  const ticket = engine.ticket("Still computing")
  store.save({ ...ticket, state: "waiting" })
  const input = { ...engine.input("old-run", "Inspect", ticket.id), state: "done" as const }
  store.put(input)
  store.db.query("INSERT INTO native_run VALUES (?,?)").run(input.id, JSON.stringify({ id: input.id, ticket: ticket.id, master: master.session,
    sourceMessage: "msg_human", sourceAssistant: "msg_main", call: "call_main", state: "done", created: 1 }))
  const calls: { directory: string; session: string; message: string }[] = []
  engine.aether.ensure = async () => {}
  engine.aether.prompt = async (directory, session, message) => {
    calls.push({ directory, session, message })
    return { info: { id: "msg_check_result", role: "assistant", parentID: message, finish: "stop" }, parts: [{ type: "text", text: "NO_UPDATE" }] }
  }
  native.settings({ checkinEnabled: true, checkinSeconds: 60 })
  const now = Date.now()
  await native.tick(now + 61000); await Promise.all(native.active.values())
  await native.tick(now + 122000); await Promise.all(native.active.values())
  expect(calls).toHaveLength(2)
  expect(calls.every((call) => call.session !== master.session)).toBe(true)
  expect(calls[0]?.session).toBe(calls[1]?.session)
  expect((await native.state()).outbox.filter((notice) => notice.kind === "update")).toHaveLength(0)
})

test("uncertain earlier notification does not silently block later worker reports forever", async () => {
  const master = { session: "ses_main", directory: path.join(state, "main"), created: 1 }
  store.db.query("INSERT INTO native_master VALUES (?,?)").run(master.session, JSON.stringify(master))
  for (const [key, stateValue] of [["lost", "unknown"], ["ready", "pending"]] as const)
    store.db.query("INSERT INTO native_outbox VALUES (?,?)").run(key, JSON.stringify({ id: key, master: master.session,
      kind: "update", message: `msg_${key}`, text: key, state: stateValue, created: 1 }))
  const messages: string[] = []
  engine.aether.result = async () => undefined
  engine.aether.prompt = async (_directory, _session, message) => {
    messages.push(message)
    return { info: { id: "msg_report_result", role: "assistant", parentID: message, finish: "stop" }, parts: [{ type: "text", text: "Here is the useful report" }] }
  }
  for (let i = 0; i < 3; i++) { await native.tick(); await Promise.all(native.active.values()) }
  expect(messages).toEqual(["msg_ready"])
  expect((await native.state()).outbox.find((notice) => notice.id === "lost")?.state).toBe("unknown")
})

test("incomplete new installation is not registered as installed from bridge alone", async () => {
  expect((await tunnel("/native/uninstall", { confirm: true })).status).toBe(200)
  const oldGeneration = store.setting("native:installation")
  await install(options())
  // A process interrupted after writing bridge but before mount installation
  // leaves this same valid receipt + bridge + absent mount situation.
  await writeFile(path.join(root, "packages/app/src/app.tsx"), originals["packages/app/src/app.tsx"]!)
  await unlink(path.join(path.dirname(bridge), "plugins/aether-superagent-v05.ts"))
  await refreshInstallation(engine)
  expect(native.installed()).toBe(false)
  expect(store.setting("native:installation")).toBe(oldGeneration)
})

test("unfinished earlier worker report does not block another task's urgent blocker", async () => {
  const master = { session: "ses_main", directory: path.join(state, "main"), created: 1 }
  store.db.query("INSERT INTO native_master VALUES (?,?)").run(master.session, JSON.stringify(master))
  const ticket = engine.ticket("Long running task")
  store.save({ ...ticket, state: "running" })
  const input = { ...engine.input("long-run", "Inspect", ticket.id), state: "dispatching" as const }
  store.put(input)
  store.db.query("INSERT INTO native_outbox VALUES (?,?)").run("waiting-worker", JSON.stringify({ id: "waiting-worker", master: master.session,
    kind: "answer", ticket: ticket.id, run: input.id, message: "msg_not_ready", text: "partial answer", state: "pending", created: 1 }))
  store.db.query("INSERT INTO native_outbox VALUES (?,?)").run("urgent", JSON.stringify({ id: "urgent", master: master.session,
    kind: "blocker", message: "msg_urgent", text: "Need a user decision", state: "pending", created: 2 }))
  const messages: string[] = []
  engine.aether.prompt = async (_directory, _session, message) => {
    messages.push(message)
    return { info: { id: "msg_blocker_result", role: "assistant", parentID: message, finish: "stop" }, parts: [{ type: "text", text: "Please decide" }] }
  }
  for (let i = 0; i < 3; i++) { await native.tick(); await Promise.all(native.active.values()) }
  expect(messages).toEqual(["msg_urgent"])
  expect((await native.state()).outbox.find((notice) => notice.id === "waiting-worker")?.state).toBe("pending")
})

test("confirmed worker error is reported without requiring a successful business report", async () => {
  const master = { session: "ses_main", directory: path.join(state, "main"), created: 1 }
  store.db.query("INSERT INTO native_master VALUES (?,?)").run(master.session, JSON.stringify(master))
  const ticket = engine.ticket("Failed work")
  store.save({ ...ticket, state: "attention" })
  const input = { ...engine.input("failed-run", "Inspect", ticket.id), state: "uncertain" as const }
  store.put(input)
  store.db.query("INSERT INTO native_run VALUES (?,?)").run(input.id, JSON.stringify({ id: input.id, ticket: ticket.id, master: master.session,
    sourceMessage: "msg_human", sourceAssistant: "msg_main", call: "call_main", state: "attention", created: 1 }))
  engine.aether.result = async () => ({ info: { id: "msg_error", role: "assistant", parentID: input.message,
    error: { name: "APIError", data: { message: "Provider error" } } }, parts: [] })
  const sessions: string[] = []
  engine.aether.prompt = async (_directory, session, message) => {
    sessions.push(session)
    return { info: { id: "msg_failure_notified", role: "assistant", parentID: message, finish: "stop" }, parts: [{ type: "text", text: "Worker failed; awaiting your decision" }] }
  }
  for (let i = 0; i < 3; i++) { await native.tick(); await Promise.all(native.active.values()) }
  expect(sessions).toEqual([master.session])
  expect(store.input(input.id)?.state).toBe("uncertain")
  expect((await native.state()).outbox.find((notice) => notice.kind === "failure")?.state).toBe("delivered")
})

test("concurrent settings request cannot re-enable scheduling during uninstall", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const preflight = native.assertUninstallable.bind(native)
  native.assertUninstallable = async () => {
    await preflight()
    entered.resolve()
    await release.promise
  }
  const removal = tunnel("/native/uninstall", { confirm: true })
  await entered.promise
  let enabling: Response
  try { enabling = await tunnel("/native/settings", { enabled: true }) }
  finally { release.resolve() }
  const removed = await removal
  expect(enabling!.status).toBeGreaterThanOrEqual(400)
  expect(removed.status).toBe(200)
  expect(native.installed()).toBe(false)
  expect(native.settings().enabled).toBe(false)
})

test("worker report survives a compaction parent and delayed exact tool persistence while retaining run ownership", async () => {
  const ticket = engine.ticket("Research after compaction")
  store.save({ ...ticket, state: "running" })
  const input = { ...engine.input("compacted-run", "Inspect", ticket.id), state: "dispatching" as const }
  store.put(input)
  store.db.query("INSERT INTO native_run VALUES (?,?)").run(input.id, JSON.stringify({ id: input.id, ticket: ticket.id, master: "ses_main",
    sourceMessage: "msg_human", sourceAssistant: "msg_main", call: "call_main", state: "running", created: 1 }))
  native.begin(ticket, input)
  engine.aether.request = async () => ({ id: ticket.session, directory: ticket.directory }) as any
  let reads = 0
  engine.aether.message = async () => {
    reads++
    if (reads === 1) throw new HttpError(404, "Tool assistant is not persisted yet")
    return { info: { id: "msg_worker", sessionID: ticket.session, role: "assistant", agent: "superagent-worker", parentID: "msg_compaction_continue" },
      parts: [{ type: "tool", callID: reads === 2 ? "call_other" : "call_report", tool: "superagent_report" }] }
  }
  const ctx = { sessionID: ticket.session, directory: ticket.directory, agent: "superagent-worker", messageID: "msg_worker", callID: "call_report" }
  const args = { ticket: ticket.id, run: input.id, revision: 1, kind: "answer" as const, summary: "Verified file", answer: "Observed result" }
  const report = await native.report(ctx, args)
  expect(reads).toBe(3)
  expect(report.sourceMessage).toBe("msg_worker")
  expect(report.run).toBe(input.id)
  expect((await native.report(ctx, args)).id).toBe(report.id)
  expect(native.reports()).toHaveLength(1)
  expect((await native.state()).outbox).toHaveLength(1)
  await expect(native.report(ctx, { ...args, run: "evt_wrong_run", revision: 2 })).rejects.toThrow("active worker run")
  expect(native.reports()).toHaveLength(1)
})
