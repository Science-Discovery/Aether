import { afterEach, beforeEach, expect, test } from "bun:test"
import { Aether, type Message } from "../src/aether"
import { Engine } from "../src/engine"
import { NativeCoordinator, type NativeNotice, type NativeRun } from "../src/native"
import { Store, type Input, type Ticket } from "../src/store"

class Backend extends Aether {
  busy = new Set<string>()
  calls: string[] = []
  constructor() { super("http://127.0.0.1:1") }
  override async status(_directory: string, session: string) { return this.busy.has(session) ? "busy" : "idle" }
  override async abort() { return true }
  override async result() { return undefined }
  override async prompt(_directory: string, session: string, message: string): Promise<Message> {
    this.calls.push(message)
    return { info: { id: `assistant_${message}`, role: "assistant", parentID: message, sessionID: session, finish: "stop" }, parts: [{ type: "text", text: "Received." }] }
  }
}
let store: Store, remote: Backend, engine: Engine, native: NativeCoordinator
beforeEach(() => {
  store = new Store(":memory:"); remote = new Backend()
  engine = new Engine(store, remote, { repo: "/fixture/repo", state: "/fixture/state", base: "HEAD", workers: 2 })
  native = new NativeCoordinator(engine)
  store.db.query("INSERT INTO native_master VALUES (?,?)").run("ses_master", JSON.stringify({ session: "ses_master", directory: "/fixture/master", created: 1 }))
})
afterEach(async () => { engine.closed = true; await Promise.all([...native.active.values()]); store.db.close() })
function add(label: string, state: Input["state"] = "uncertain") {
  const ticket: Ticket = { id: `ticket_${label}`, session: `ses_${label}`, directory: `/fixture/${label}`, title: label, state: "attention", result: "" }
  const input: Input = { id: `input_${label}`, key: `key_${label}`, text: label, ticket: ticket.id, mode: "work", message: `msg_${label}`, state, result: "Transport completion uncertain" }
  const run: NativeRun = { id: input.id, ticket: ticket.id, master: "ses_master", sourceMessage: "msg_user", sourceAssistant: "msg_assistant", call: "call_dispatch", state: "attention", created: 1 }
  store.save(ticket); store.put(input)
  store.db.query("INSERT INTO native_run VALUES (?,?)").run(run.id, JSON.stringify(run))
  return { ticket, input, run }
}
function enqueue(value: ReturnType<typeof add>) {
  const notice: NativeNotice = { id: `notice_${value.input.id}`, master: "ses_master", ticket: value.ticket.id, run: value.run.id, report: `report_${value.input.id}`, kind: "answer", message: `notice_message_${value.input.id}`, text: "Reported result", state: "pending", created: 1 }
  store.db.query("INSERT INTO native_outbox VALUES (?,?)").run(notice.id, JSON.stringify(notice))
  return notice
}
async function cycle() { await native.tick(); await Promise.all([...native.active.values()]) }

test("dismissed uncertain report cannot starve another task's completed notification", async () => {
  const first = add("dismissed"), second = add("completed", "done")
  enqueue(first); const next = enqueue(second)
  await engine.dismiss(first.input.id)
  expect(store.input(first.input.id)?.state).toBe("cancelled")
  for (let i = 0; i < 3; i++) await cycle()
  expect(remote.calls).toContain(next.message)
})

test("uninstall preflight rejects a stopped worker whose remote abort is still unconfirmed", async () => {
  const value = add("still_busy")
  remote.busy.add(value.ticket.session)
  await engine.stop(value.ticket.id)
  expect(store.input(value.input.id)?.state).toBe("cancelled")
  expect(store.setting(`stop:${value.ticket.id}`)).toBe("pending")
  native.settings({ enabled: false })
  await expect(native.assertUninstallable()).rejects.toThrow()
})

test("a blocker report does not consume the worker's subsequent successful final answer", async () => {
  const value = add("blocker_then_done", "dispatching")
  store.db.query("INSERT INTO native_report VALUES (?,?,?,?)").run("report_blocker", value.run.id, 1, JSON.stringify({
    id: "report_blocker", ticket: value.ticket.id, run: value.run.id, revision: 1, kind: "blocker", summary: "An input may be needed", created: 1,
  }))
  engine.complete(value.input, { info: { id: "assistant_final", role: "assistant", parentID: value.input.message, finish: "stop" }, parts: [{ type: "text", text: "Actually resolved: the result is 42." }] })
  expect(store.input(value.input.id)?.state).toBe("done")
  expect((await native.state()).outbox.some((notice) => notice.text.includes("the result is 42"))).toBe(true)
})

test("a corrupt task permission journal pauses its lane without throwing or starving other lanes", async () => {
  const first = add("corrupt", "pending"), second = add("healthy", "pending")
  store.setting(`permission:task:${first.ticket.id}`, "{broken json")
  const claimed: string[] = []
  engine.run = async (input) => { claimed.push(input.id) }
  expect(() => engine.tick()).not.toThrow()
  await Promise.all([...engine.active.values()])
  expect(claimed).toEqual([second.input.id])
  expect(store.input(first.input.id)?.state).toBe("pending")
})

test("mismatched identity or unsupported original policy cannot bypass the task's permission hold", async () => {
  const value = add("mismatched", "pending")
  const base = { session: value.ticket.session, directory: value.ticket.directory, phase: "trusted", rules: [] }
  let claims = 0
  engine.run = async () => { claims++ }
  for (const journal of [
    { ...base, session: "ses_other" },
    { ...base, directory: "/fixture/other" },
    { ...base, rules: [{ permission: "*", pattern: "*", action: "allow" }] },
    { ...base, mode: "safe" },
  ]) {
    store.setting(`permission:task:${value.ticket.id}`, JSON.stringify(journal))
    expect(() => engine.tick()).not.toThrow()
    await Promise.all([...engine.active.values()])
    expect(claims).toBe(0)
    expect(store.input(value.input.id)?.state).toBe("pending")
  }
})
