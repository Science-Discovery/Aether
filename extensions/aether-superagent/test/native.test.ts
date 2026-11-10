import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { Aether, HttpError, type Message } from "../src/aether"
import { Engine, type Config } from "../src/engine"
import { Store } from "../src/store"
import { NativeCoordinator, type NativeContext, type NativeReportArgs } from "../src/native"
import { git } from "../src/workspace"

type Call = { directory: string; session: string; message: string; text: string; options?: { agent?: string; synthetic?: boolean } }
const answer = (call: Call, text = "A useful answer"): Message => ({ info: { id: `assistant-${call.message}`, role: "assistant", sessionID: call.session, parentID: call.message, finish: "stop" }, parts: [{ type: "text", text }] })
class Fixture extends Aether {
  messages = new Map<string, Message>()
  results = new Map<string, Message>()
  calls: Call[] = []
  preferences: unknown[] = []
  busy = new Set<string>()
  respond: (call: Call) => Promise<Message> = async (call) => answer(call)
  constructor() { super("http://127.0.0.1:1") }
  override async ensure() {}
  override async request<T>(directory: string, route: string, body?: unknown, method?: "PATCH"): Promise<T> {
    if (method === "PATCH") { this.preferences.push(body); return body as T }
    return { id: route.split("/")[2], directory } as T
  }
  override async message(_directory: string, _session: string, message: string) { const value = this.messages.get(message); if (!value) throw new HttpError(404, "missing"); return value }
  override async status(_directory: string, session: string) { return this.busy.has(session) ? "busy" : "idle" }
  override async prompt(directory: string, session: string, message: string, text: string, _model?: unknown, _schema?: object, options?: { agent?: string; synthetic?: boolean }) {
    const call = { directory, session, message, text, options }; this.calls.push(call); return this.respond(call)
  }
  override async result(_directory: string, _session: string, message: string) { return this.results.get(message) }
  override async abort() { return true }
}
let root: string, store: Store, engine: Engine, native: NativeCoordinator, remote: Fixture, config: Config
beforeEach(async () => {
  const base = path.join(homedir(), "data/aether-superagent-tests")
  await mkdir(base, { recursive: true }); root = await mkdtemp(path.join(base, "native-"))
  const repo = path.join(root, "repo"), state = path.join(root, "state")
  await mkdir(repo); await mkdir(state); await git(repo, "init"); await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture")
  config = { repo, state, base: "HEAD", workers: 2 }
  store = new Store(path.join(root, "state.sqlite")); remote = new Fixture(); engine = new Engine(store, remote, config); native = new NativeCoordinator(engine)
})
afterEach(async () => { engine.closed = true; await Promise.allSettled([...engine.active.values(), ...native.active.values()]); store.db.close() })
function context(tool: string, session = "ses_master", directory = "/fixture/master", message = `msg_${crypto.randomUUID()}`, agent = "superagent"): NativeContext {
  const ctx = { sessionID: session, directory, agent, messageID: message, callID: `call_${crypto.randomUUID()}` }
  remote.messages.set(message, { info: { id: message, role: "assistant", sessionID: session, parentID: "msg_original_user", agent }, parts: [{ type: "tool", callID: ctx.callID, tool }] })
  return ctx
}
async function dispatch() { return native.dispatch(context("superagent_dispatch"), { title: "Read-only audit", text: "Inspect the existing STATUS.txt. Do not modify it." }) }
async function running() {
  const value = await dispatch(); store.put({ ...value.input, state: "dispatching" }); store.save({ ...value.ticket, state: "running" }); native.begin(value.ticket, value.input)
  const ctx = context("superagent_report", value.ticket.session, value.ticket.directory, undefined, "superagent-worker")
  const report: NativeReportArgs = { ticket: value.ticket.id, run: value.input.id, revision: 1, kind: "answer", summary: "Inspected existing evidence", answer: "The calculation is awaiting verification." }
  return { ...value, ctx, report }
}
async function drain() { await Promise.all([...native.active.values()]) }
async function cycle(now?: number) { await native.tick(now); await drain() }

 test("native dispatch is idempotent, owns tickets and records original request identity", async () => {
  const ctx = context("superagent_dispatch"), args = { text: "Inspect existing files", title: "audit" }
  const a = await native.dispatch(ctx, args), b = await native.dispatch(ctx, args)
  expect(a.input.id).toBe(b.input.id); expect(a.run.sourceMessage).toBe("msg_original_user"); expect(store.tickets()).toHaveLength(1)
  await expect(native.dispatch(ctx, { ...args, text: "Different objective" })).rejects.toThrow("Idempotency")
  await expect(native.dispatch(context("superagent_dispatch", "ses_other"), { text: "Continue", ticket: a.ticket.id })).rejects.toThrow("owned")
  const follow = await native.dispatch(context("superagent_dispatch"), { text: "Check the next detail", ticket: a.ticket.id })
  expect(follow.ticket.session).toBe(a.ticket.session)
})

test("plugin report is run-bound, monotone, durable and duplicate blockers notify once", async () => {
  const { ticket, input, ctx, report } = await running()
  const blocker = { ...report, kind: "blocker" as const, summary: "Need the missing coefficient file", answer: undefined }
  const first = await native.report(ctx, blocker), second = await native.report(ctx, blocker)
  expect(first.id).toBe(second.id); expect(native.reports()).toHaveLength(1)
  await native.report(context("superagent_report", ticket.session, ticket.directory, undefined, "superagent-worker"), { ...blocker, revision: 2 })
  expect((await native.state()).outbox).toHaveLength(1)
  expect(store.research(ticket.id)?.stage).toBe("blocked")
  await expect(native.report(context("superagent_report", ticket.session, ticket.directory, undefined, "superagent-worker"), { ...report, revision: 1 })).rejects.toThrow("revision")
  await engine.stop(ticket.id)
  await expect(native.report(ctx, { ...report, revision: 3 })).rejects.toThrow("active worker")
  expect((await native.state()).outbox[0]?.state).toBe("cancelled")
  expect(store.input(input.id)?.state).toBe("cancelled")
})

test("unknown notification is read back after restart and never replayed", async () => {
  const { input, ctx, report } = await running(); await native.report(ctx, report)
  engine.complete(input, answer({ directory: "", session: "", message: input.message, text: "" }))
  remote.respond = async () => { throw new Error("response lost") }
  await cycle(); const notice = (await native.state()).outbox[0]!
  expect(notice.state).toBe("unknown"); expect(remote.calls).toHaveLength(1)
  engine = new Engine(store, remote, config); native = new NativeCoordinator(engine)
  await cycle(); expect(remote.calls).toHaveLength(1)
  remote.results.set(notice.message, answer({ directory: "", session: "ses_master", message: notice.message, text: "" }))
  await cycle(); expect((await native.state()).outbox[0]?.state).toBe("delivered"); expect(remote.calls).toHaveLength(1)
})

test("busy rejection keeps one queued notice and retries the same message ID", async () => {
  const { input, ctx, report } = await running(); await native.report(ctx, report)
  engine.complete(input, answer({ directory: "", session: "", message: input.message, text: "" }))
  remote.respond = async () => { throw new HttpError(409, "busy") }; await cycle()
  expect((await native.state()).outbox[0]?.state).toBe("pending")
  remote.respond = async (call) => answer(call); await cycle()
  expect(remote.calls).toHaveLength(2); expect(remote.calls[0]?.message).toBe(remote.calls[1]?.message)
  expect((await native.state()).outbox[0]?.state).toBe("delivered")
})

test("disabled settings gate legacy and native work while preserving active reports", async () => {
  const value = await running(); native.settings({ enabled: false })
  expect(() => engine.submit("legacy", "hello")).toThrow("disabled")
  await expect(dispatch()).rejects.toThrow("disabled")
  await native.report(value.ctx, value.report)
  await cycle(); engine.tick(); expect(remote.calls).toHaveLength(0)
  expect(native.reports()).toHaveLength(1)
  native.settings({ enabled: true }); engine.complete(value.input, answer({ directory: "", session: "", message: value.input.message, text: "" }))
  await cycle(); expect(remote.calls).toHaveLength(1)
})

test("cron thinks in a separate session and NO_UPDATE never adds a master turn", async () => {
  const value = await dispatch()
  native.settings({ checkinEnabled: true, checkinSeconds: 60 })
  remote.respond = async (call) => answer(call, "NO_UPDATE")
  await cycle(Date.now() + 61000)
  expect(remote.calls).toHaveLength(1); expect(remote.calls[0]?.session).not.toBe(value.run.master)
  expect(remote.calls[0]?.options?.agent).toBe("superagent")
  expect((await native.state()).outbox.filter((notice) => notice.kind === "update")).toHaveLength(0)
  await cycle(Date.now() + 62000); expect(remote.calls).toHaveLength(1)
  const checker = remote.calls[0]!
  const ctx = context("superagent_status", checker.session, checker.directory)
  expect((await native.state(ctx)).tickets.map((ticket) => ticket.id)).toEqual([value.ticket.id])
  await expect(native.dispatch(context("superagent_dispatch", checker.session, checker.directory), { text: "New unrelated objective" })).rejects.toThrow("cannot create")
})

test("important checker finding queues one separate master update and stopped tasks never reawaken", async () => {
  const value = await dispatch(); native.settings({ checkinEnabled: true, checkinSeconds: 60 })
  remote.respond = async (call) => answer(call, call.directory.includes("checkin") ? "The run needs a missing input." : "Please provide the missing input.")
  await cycle(Date.now() + 61000); await cycle(Date.now() + 62000)
  expect(remote.calls).toHaveLength(2); expect(remote.calls[1]?.session).toBe(value.run.master)
  await engine.stop(value.ticket.id); await cycle(Date.now() + 130000)
  expect(remote.calls).toHaveLength(2)
})

test("source validation rejects invented tool context and open sets native agent preference", async () => {
  const bad = context("superagent_status"); bad.callID = "invented"
  await expect(native.state(bad)).rejects.toThrow("tool call")
  const opened = await native.open(); expect(opened.directory).toBe(path.join(config.state, "native-master", "v05"))
  expect(remote.preferences.at(-1)).toEqual({ agent: "superagent" })
  const again = await native.open(); expect(again.session).toBe(opened.session)
  native.settings({ enabled: false }); remote.busy.add(opened.session)
  await expect(native.assertUninstallable()).rejects.toThrow("still active")
  remote.busy.clear(); await native.assertUninstallable()
})

test("actual Engine path uses worker preset and structured reports instead of progress files", async () => {
  const value = await dispatch()
  remote.respond = async (call) => {
    if (call.options?.agent === "superagent-worker") {
      expect(call.text).toContain("SUPERAGENT_RUN")
      const ctx = context("superagent_report", call.session, call.directory, undefined, "superagent-worker")
      await native.report(ctx, { ticket: value.ticket.id, run: value.input.id, revision: 1, kind: "answer", summary: "Audit complete", answer: "Checked existing files." })
    }
    return answer(call)
  }
  engine.tick(); await Promise.all([...engine.active.values()])
  expect(store.input(value.input.id)?.state).toBe("done")
  expect(native.reports()).toHaveLength(1)
  await cycle(); expect(remote.calls).toHaveLength(2)
  expect(remote.calls[1]?.options?.synthetic).toBe(true)
})

test("a missing structured report preserves the real answer and requests review", async () => {
  const value = await dispatch(); store.put({ ...value.input, state: "dispatching" }); native.begin(value.ticket, value.input)
  engine.complete(value.input, answer({ directory: "", session: value.ticket.session, message: value.input.message, text: "" }, "Actual final result"))
  expect(store.ticket(value.ticket.id)?.state).toBe("attention")
  const notices = (await native.state()).outbox
  expect(notices[0]?.kind).toBe("missing"); expect(notices[0]?.text).toContain("Actual final result")
  await cycle(); expect(remote.calls).toHaveLength(1)
})

test("confirmed worker errors notify once without replay or clearing uncertainty", async () => {
  const value = await running(); store.put({ ...value.input, state: "uncertain" })
  remote.results.set(value.input.message, { info: { id: "error", role: "assistant", parentID: value.input.message, error: { message: "Tool failure" } }, parts: [] })
  await cycle(); await cycle(); await cycle()
  expect((await native.state()).outbox.filter((notice) => notice.kind === "failure")).toHaveLength(1)
  expect(remote.calls).toHaveLength(1)
  expect(store.input(value.input.id)?.state).toBe("uncertain")
})

test("business answer survives compaction/readback uncertainty while execution stays unconfirmed", async () => {
  const value = await running(); await native.report(value.ctx, value.report)
  store.put({ ...value.input, state: "uncertain", result: "Unrecognized continuation" })
  await cycle()
  expect(remote.calls).toHaveLength(1); expect(remote.calls[0]?.text).toContain("completion is UNCONFIRMED")
  expect(store.input(value.input.id)?.state).toBe("uncertain")
})

test("stopping all tasks cancels a queued checker finding before master delivery", async () => {
  const value = await dispatch(); native.settings({ checkinEnabled: true, checkinSeconds: 60 })
  remote.respond = async (call) => answer(call, "A blocker needs review")
  await cycle(Date.now() + 61000)
  await engine.stop(value.ticket.id); await cycle(Date.now() + 62000)
  expect(remote.calls).toHaveLength(1)
  expect((await native.state()).outbox.find((notice) => notice.kind === "update")?.state).toBe("cancelled")
})

test("confirmed check-in error exits unknown without replay and permits the next scheduled check", async () => {
  await dispatch(); native.settings({ checkinEnabled: true, checkinSeconds: 60 })
  const now = Date.now()
  remote.respond = async () => { throw new Error("lost response") }
  await cycle(now + 61000)
  const notice = (await native.state()).outbox.find((entry) => entry.kind === "checkin")!
  expect(notice.state).toBe("unknown")
  await cycle(now + 122000); expect(remote.calls).toHaveLength(1)
  remote.results.set(notice.message, { info: { id: "msg_error", role: "assistant", parentID: notice.message, error: { name: "APIError", message: "provider failed" } }, parts: [] })
  await cycle(now + 123000)
  expect((await native.state()).outbox.find((entry) => entry.id === notice.id)?.state).toBe("failed")
  remote.respond = async (call) => answer(call, "NO_UPDATE")
  await cycle(now + 184000)
  expect(remote.calls).toHaveLength(2); expect(remote.calls[1]?.message).not.toBe(notice.message)
  expect((await native.state()).outbox.filter((entry) => entry.kind === "update")).toHaveLength(0)
})

test("master notice terminal error is failed rather than unknown or automatically replayed", async () => {
  const value = await running(); await native.report(value.ctx, value.report)
  engine.complete(value.input, answer({ directory: "", session: value.ticket.session, message: value.input.message, text: "" }))
  remote.respond = async (call) => ({ info: { id: "msg_error", role: "assistant", parentID: call.message, error: { message: "provider failed" } }, parts: [] })
  await cycle(); await cycle()
  expect((await native.state()).outbox[0]?.state).toBe("failed"); expect(remote.calls).toHaveLength(1)
})

test("tool context waits for persistence of the exact part without accepting an impostor", async () => {
  const ctx = context("superagent_dispatch")
  const original = remote.messages.get(ctx.messageID)!
  let reads = 0
  remote.message = async () => { reads++; return reads < 3 ? { ...original, parts: [] } : original }
  const value = await native.dispatch(ctx, { text: "Read the specified file", title: "audit" })
  expect(reads).toBe(3); expect(value.run.sourceAssistant).toBe(ctx.messageID)
  const state = await native.state(); expect(state.workspace.repo).toBe(config.repo); expect(state.workspace.base).toBe("HEAD")
  const other = context("superagent_dispatch")
  remote.message = async () => ({ ...original, info: { ...original.info, id: other.messageID, agent: "build" } })
  await expect(native.dispatch(other, { text: "Not an authorized agent" })).rejects.toThrow("caller")
})

test("explicit legacy follow-up atomically adopts its existing session and isolates other masters", async () => {
  const legacy = engine.submit("legacy-old", "Inspect the old calculation", undefined, "Existing audit")
  const ticket = store.ticket(legacy.ticket!)!
  store.put({ ...legacy, state: "done", result: "Preserved old result" }); store.save({ ...ticket, state: "waiting", result: "Preserved old result" })
  const before = await native.state(context("superagent_status"))
  expect(before.tickets.find((item) => item.id === ticket.id)?.unowned).toBe(true)
  const first = context("superagent_dispatch", "ses_master")
  const second = context("superagent_dispatch", "ses_second")
  const claims = await Promise.allSettled([
    native.dispatch(first, { ticket: ticket.id, text: "Verify the next detail" }),
    native.dispatch(second, { ticket: ticket.id, text: "Another claim" }),
  ])
  expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1)
  const success = claims.find((claim) => claim.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof native.dispatch>>>
  expect(success.value.ticket.session).toBe(ticket.session)
  expect(store.input(legacy.id)?.result).toBe("Preserved old result")
  expect(native.run(legacy.id)).toBeUndefined()
  const winner = success.value.run.master
  const loser = winner === "ses_master" ? "ses_second" : "ses_master"
  expect((await native.state(context("superagent_status", winner))).tickets.find((item) => item.id === ticket.id)?.unowned).toBe(false)
  expect((await native.state(context("superagent_status", loser))).tickets.some((item) => item.id === ticket.id)).toBe(false)
})

test("legacy adoption never replays uncertain work or resumes a stopped ticket", async () => {
  const old = engine.submit("legacy-unknown", "Old in-flight request", undefined, "Unknown audit")
  store.put({ ...old, state: "uncertain", result: "Lost previous response" })
  const queued = await native.dispatch(context("superagent_dispatch"), { ticket: old.ticket!, text: "Follow up after recovery" })
  engine.tick(); await Promise.all(engine.active.values())
  expect(remote.calls).toHaveLength(0)
  expect(store.input(old.id)?.state).toBe("uncertain")
  expect(store.input(queued.input.id)?.state).toBe("pending")
  const stopped = engine.submit("legacy-stopped", "Previous request", undefined, "Stopped audit")
  await engine.stop(stopped.ticket!)
  await expect(native.dispatch(context("superagent_dispatch"), { ticket: stopped.ticket!, text: "Continue" })).rejects.toThrow("Stopped")
  expect(store.inputs().filter((input) => input.ticket === stopped.ticket)).toHaveLength(1)
  expect((await native.state()).tickets.find((item) => item.id === stopped.ticket)?.unowned).toBe(true)
})

test("adopted legacy worker keeps its default agent and file reports then answers its native master", async () => {
  const old = engine.submit("legacy-completed", "Original objective", undefined, "Existing audit")
  const ticket = store.ticket(old.ticket!)!
  store.put({ ...old, state: "done" }); store.save({ ...ticket, state: "waiting" })
  const current = await native.dispatch(context("superagent_dispatch"), { ticket: ticket.id, text: "Inspect the latest evidence" })
  expect(current.run.legacy).toBe(true)
  remote.respond = async (call) => {
    if (call.session === ticket.session) {
      expect(call.options?.agent).toBeUndefined()
      expect(call.text).not.toContain("SUPERAGENT_RUN:")
      const line = call.text.split("\n").find((line) => line.startsWith("SUPERAGENT_PROGRESS: "))!
      const protocol = JSON.parse(line.slice("SUPERAGENT_PROGRESS: ".length))
      await writeFile(protocol.path, JSON.stringify({ ...protocol.snapshot, summary: "File evidence collected", next: "Await review" }))
      return answer(call, "Actual compatibility answer")
    }
    return answer(call, "Main conversation received the result")
  }
  engine.tick(); await Promise.all(engine.active.values())
  expect(store.input(current.input.id)?.state).toBe("done")
  expect(store.ticket(ticket.id)?.state).toBe("waiting")
  expect(store.research(ticket.id)?.summary).toBe("File evidence collected")
  expect((await native.state()).outbox.map((notice) => notice.kind)).toEqual(["answer"])
  await cycle()
  expect(remote.calls.at(-1)?.session).toBe(current.run.master)
  expect(remote.calls.at(-1)?.text).toContain("Actual compatibility answer")
  expect(remote.calls.at(-1)?.text).toContain("File evidence collected")
  const next = await native.dispatch(context("superagent_dispatch"), { ticket: ticket.id, text: "Continue this audit" })
  expect(next.run.legacy).toBe(true); expect(next.ticket.session).toBe(ticket.session)
})
