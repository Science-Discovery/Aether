import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { Aether, type Message } from "../src/aether"
import { Engine, type Config } from "../src/engine"
import { Store } from "../src/store"
import { git } from "../src/workspace"
import { reportPath } from "../src/research"

type Call = { directory: string; session: string; message: string; text: string; schema?: object }
function result(call: Call, structured?: object): Message {
  return { info: { id: `answer-${call.message}`, parentID: call.message, role: "assistant", finish: "stop", ...(structured ? { structured } : {}) }, parts: [{ type: "text", text: "A worker turn ended; this does not prove research acceptance." }] }
}
class FixtureAether extends Aether {
  calls: Call[] = []
  respond: (call: Call) => Promise<Message> = async (call) => result(call)
  constructor() { super("http://127.0.0.1:1") }
  override async ensure() {}
  override async prompt(directory: string, session: string, message: string, text: string, _model?: unknown, schema?: object) {
    const call = { directory, session, message, text, schema }; this.calls.push(call); return this.respond(call)
  }
  override async status() { return "idle" }
  override async abort() { return true }
}
let directory: string, config: Config, store: Store, engine: Engine, aether: FixtureAether
let releases: (() => void)[]
beforeEach(async () => {
  const root = path.join(homedir(), "data/aether-superagent-tests")
  await mkdir(root, { recursive: true }); directory = await mkdtemp(path.join(root, "research-"))
  const repo = path.join(directory, "repo"), state = path.join(directory, "state")
  await mkdir(repo); await mkdir(state); await git(repo, "init")
  await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture")
  config = { repo, state, base: "HEAD", workers: 2 }
  store = new Store(path.join(state, "state.sqlite")); aether = new FixtureAether(); engine = new Engine(store, aether, config); releases = []
})
afterEach(async () => { engine.closed = true; releases.forEach((release) => release()); await Promise.allSettled([...engine.active.values()]); store.db.close() })
async function until(check: () => boolean) {
  const end = Date.now() + 5000
  while (!check()) { if (Date.now() > end) throw new Error("Fixture timed out"); await Bun.sleep(5) }
}
async function drain() { await Promise.all([...engine.active.values()]) }
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve }); releases.push(release); return { promise, release } }
async function running() {
  const hold = gate(); aether.respond = async (call) => { await hold.promise; return result(call) }
  const input = engine.submit("first", "研究边界与证据", undefined, "科研验证")
  engine.tick(); await until(() => aether.calls.length === 1)
  return { input, ticket: store.ticket(input.ticket!)!, hold }
}
function report(ticket: string, input: string, revision: number, changes: Record<string, unknown> = {}) {
  return { ticket, input, revision, objective: "验证固定边界", stage: "computing", summary: "已完成一个可复现检查", next: "验证剩余边界", blockers: [],
    milestones: [{ id: "m1", title: "边界计算", state: "active" }], evidence: [], ...changes }
}

describe("independent research state and file protocol", () => {
  test("old database migrates without changing task identity or claiming scientific completion", async () => {
    store.db.close()
    const oldFile = path.join(directory, "old.sqlite"), old = new Database(oldFile)
    old.exec(`CREATE TABLE ticket(id TEXT PRIMARY KEY,title TEXT NOT NULL,session TEXT NOT NULL UNIQUE,directory TEXT NOT NULL,state TEXT NOT NULL,result TEXT NOT NULL DEFAULT '');
      CREATE TABLE input(id TEXT PRIMARY KEY,key TEXT NOT NULL UNIQUE,text TEXT NOT NULL,mode TEXT NOT NULL,ticket TEXT,message TEXT NOT NULL UNIQUE,state TEXT NOT NULL,result TEXT NOT NULL DEFAULT '');
      CREATE TABLE setting(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO ticket VALUES('job_old','已有研究','ses_old','/fixture/old','waiting','The worker claimed done');
      INSERT INTO input VALUES('evt_old','user:old','最初科研目标','work','job_old','msg_old','done','old output');`)
    old.close(); store = new Store(oldFile); engine = new Engine(store, aether, config)
    expect(store.ticket("job_old")?.session).toBe("ses_old")
    expect(store.input("evt_old")?.text).toBe("最初科研目标")
    expect(store.research("job_old")?.stage).toBe("planning")
    expect(store.research("job_old")?.revision).toBe(0)
    const snapshot = store.research("job_old")
    store.db.close(); store = new Store(oldFile); engine = new Engine(store, aether, config)
    expect(store.research("job_old")).toEqual(snapshot)
  })

  test("actual progress file updates snapshot and activity while worker remains running", async () => {
    const { input, ticket } = await running()
    const revision = store.research(ticket.id)!.revision + 1
    await writeFile(reportPath(ticket, input), JSON.stringify(report(ticket.id, input.id, revision)))
    await engine.collectProgress()
    expect(store.ticket(ticket.id)?.state).toBe("running")
    expect(store.research(ticket.id)?.summary).toBe("已完成一个可复现检查")
    expect(store.research(ticket.id)?.revision).toBe(revision)
    expect(store.events(ticket.id).at(-1)?.research.summary).toBe("已完成一个可复现检查")
    const events = store.events(ticket.id).length
    await engine.collectProgress()
    expect(store.events(ticket.id)).toHaveLength(events)
    await writeFile(reportPath(ticket, input), JSON.stringify(report(ticket.id, input.id, revision, { summary: "late stale overwrite" })))
    await engine.collectProgress()
    expect(store.research(ticket.id)?.summary).toBe("已完成一个可复现检查")
  })

  test("final report is collected before turn completion and survives database reopen", async () => {
    const { input, ticket, hold } = await running()
    await writeFile(reportPath(ticket, input), JSON.stringify(report(ticket.id, input.id, store.research(ticket.id)!.revision + 1)))
    hold.release(); await drain()
    expect(store.input(input.id)?.state).toBe("done")
    expect(store.research(ticket.id)?.summary).toBe("已完成一个可复现检查")
    const snapshot = store.research(ticket.id), events = store.events(ticket.id)
    expect(events.map((event) => event.kind)).toContain("progress")
    expect(events.at(-1)?.kind).toBe("turn_ended")
    store.db.close(); store = new Store(path.join(config.state, "state.sqlite")); engine = new Engine(store, aether, config)
    expect(store.research(ticket.id)).toEqual(snapshot)
    expect(store.events(ticket.id)).toEqual(events)
  })

  test("wrong task/run, malformed JSON, symlink and missing review evidence cannot replace snapshot", async () => {
    const { input, ticket } = await running()
    const before = store.research(ticket.id)!, file = reportPath(ticket, input)
    for (const patch of [
      { ticket: "job_other" }, { input: "evt_other" },
      { stage: "review", milestones: [{ id: "m1", title: "claim", state: "done" }], evidence: [] },
      { stage: "review", milestones: [{ id: "m1", title: "unfinished", state: "active" }], evidence: [{ label: "log", path: "checks.txt" }] },
      { stage: "review", blockers: ["unresolved"], milestones: [{ id: "m1", title: "claim", state: "done" }], evidence: [{ label: "log", path: "checks.txt" }] },
    ]) {
      await writeFile(file, JSON.stringify(report(ticket.id, input.id, before.revision + 1, patch))); await engine.collectProgress()
      expect(store.research(ticket.id)).toEqual(before)
    }
    await writeFile(file, '{"partial":'); await engine.collectProgress(); expect(store.research(ticket.id)).toEqual(before)
    const { unlink } = await import("node:fs/promises")
    await unlink(file); const external = path.join(directory, "external.json")
    await writeFile(external, JSON.stringify(report(ticket.id, input.id, before.revision + 1)))
    await symlink(external, file); await engine.collectProgress(); expect(store.research(ticket.id)).toEqual(before)
  })

  test("review accepts a supported report but late completed or stopped writes cannot revive research", async () => {
    const { input, ticket, hold } = await running()
    const file = reportPath(ticket, input), revision = store.research(ticket.id)!.revision + 1
    await writeFile(file, JSON.stringify(report(ticket.id, input.id, revision, { stage: "review", milestones: [{ id: "m1", title: "check", state: "done" }], evidence: [{ label: "local fixture evidence", path: "checks.txt" }] })))
    await engine.collectProgress(); expect(store.research(ticket.id)?.stage).toBe("review")
    hold.release(); await drain()
    const completed = store.research(ticket.id)
    await writeFile(file, JSON.stringify(report(ticket.id, input.id, revision + 10, { summary: "late after complete" })))
    await engine.collectProgress(); expect(store.research(ticket.id)).toEqual(completed)
    await engine.stop(ticket.id)
    const stopped = store.research(ticket.id)
    await writeFile(file, JSON.stringify(report(ticket.id, input.id, revision + 20, { summary: "revived" })))
    await engine.collectProgress(); expect(store.research(ticket.id)).toEqual(stopped)
    expect(store.ticket(ticket.id)?.state).toBe("stopped")
  })

  test("stop during a running turn rejects both new progress and late assistant completion", async () => {
    const { input, ticket, hold } = await running()
    await engine.stop(ticket.id)
    const stopped = store.research(ticket.id), events = store.events(ticket.id)
    await writeFile(reportPath(ticket, input), JSON.stringify(report(ticket.id, input.id, stopped!.revision + 10)))
    await engine.collectProgress(); hold.release(); await drain()
    expect(store.research(ticket.id)).toEqual(stopped)
    expect(store.events(ticket.id)).toEqual(events)
    expect(store.ticket(ticket.id)?.state).toBe("stopped")
    expect(store.input(input.id)?.state).toBe("cancelled")
  })

  test("replacement of a running worktree directory cannot inject a report", async () => {
    const { input, ticket } = await running()
    const previous = store.research(ticket.id)!
    await rename(ticket.directory, ticket.directory + "-original")
    await mkdir(ticket.directory)
    await writeFile(reportPath(ticket, input), JSON.stringify(report(ticket.id, input.id, previous.revision + 1)))
    await engine.collectProgress()
    expect(store.research(ticket.id)).toEqual(previous)
  })

  test("next run has a newer revision and refuses previous run progress", async () => {
    const { input, ticket, hold } = await running()
    await writeFile(reportPath(ticket, input), JSON.stringify(report(ticket.id, input.id, store.research(ticket.id)!.revision + 1)))
    await engine.collectProgress(); hold.release(); await drain()
    const previous = store.research(ticket.id)!
    const nextGate = gate(); aether.respond = async (call) => { await nextGate.promise; return result(call) }
    const next = engine.submit("next", "继续检查", ticket.id)
    engine.tick(); await until(() => aether.calls.length === 2)
    const current = store.research(ticket.id)!
    expect(current.revision).toBeGreaterThan(previous.revision)
    expect(current.input).toBe(next.id)
    await writeFile(reportPath(ticket, input), JSON.stringify(report(ticket.id, input.id, current.revision + 100)))
    await writeFile(reportPath(ticket, next), JSON.stringify(report(ticket.id, input.id, current.revision + 101)))
    await engine.collectProgress(); expect(store.research(ticket.id)).toEqual(current)
  })

  test("router bounds 50-task context under extreme valid reports while retaining old focus", async () => {
    for (let i = 0; i < 55; i++) {
      const input = engine.submit(`bulk-${i}`, "o".repeat(100000), undefined, `topic-${i}`)
      const previous = store.research(input.ticket!)!
      store.recordResearch(input.ticket!, { ...previous, summary: "s".repeat(12000), next: "n".repeat(4000),
        blockers: Array.from({ length: 30 }, () => "b".repeat(2000)),
        milestones: Array.from({ length: 100 }, (_, index) => ({ id: String(index), title: "m".repeat(1000), state: "active" })),
        evidence: Array.from({ length: 100 }, () => ({ label: "e".repeat(1000), path: "p".repeat(2000) })),
      }, "progress")
    }
    const focused = store.tickets()[0]!
    aether.respond = async (call) => result(call, { action: "reply", ticket: "", title: "", text: "clarify" })
    const input = engine.submit("budget", "继续最早课题", undefined, undefined, focused.id)
    store.put({ ...input, state: "dispatching" }); await engine.run(input)
    const prompt = aether.calls[0]!.text
    const line = prompt.split("\n").find((line) => line.startsWith("Tickets: "))!.slice("Tickets: ".length)
    const listed = JSON.parse(line) as { id: string; research: unknown }[]
    expect(line.length).toBeLessThanOrEqual(64000)
    expect(listed.length).toBeLessThanOrEqual(50)
    expect(listed.some((ticket) => ticket.id === focused.id)).toBe(true)
    expect(new Set(listed.map((ticket) => ticket.id)).size).toBe(listed.length)
    expect(store.input(input.id)?.state).toBe("done")
  })

  test("read-only investigation outside the worktree dispatches a worker and preserves per-request answers", async () => {
    const external = path.join(directory, "external-research")
    await mkdir(external); const file = path.join(external, "PROGRESS.txt")
    await writeFile(file, "Reduction stage: 17 of 23 families checked; 6 remain.\n")
    aether.respond = async (call) => {
      if (call.schema) {
        expect(call.text).toContain(file)
        expect(call.text.split("User request:")[0]).toContain("Any answer requiring new observations MUST be delegated")
        expect(call.text.split("User request:")[0]).toContain("~/research/projects/*")
        return result(call, { action: "create", ticket: "", title: "Inspect existing research", text: "Requires filesystem evidence" })
      }
      return { ...result(call), parts: [{ type: "text", text: await readFile(file, "utf8") }] }
    }
    const request = engine.submit("readonly", `Read-only: inspect ${file} and tell me the actual calculation progress. Do not modify it.`)
    engine.tick(); await drain(); engine.tick(); await drain()
    const route = JSON.parse(store.input(request.id)!.result) as { ticket: string; input: string }
    expect(aether.calls).toHaveLength(2)
    expect(aether.calls[1]!.schema).toBeUndefined()
    expect(store.input(route.input)?.result).toContain("17 of 23")
    expect(await readFile(file, "utf8")).toBe("Reduction stage: 17 of 23 families checked; 6 remain.\n")
    aether.respond = async (call) => ({ ...result(call), parts: [{ type: "text", text: "Unrelated later result on the same ticket" }] })
    engine.submit("unrelated-update", "Another update", route.ticket)
    engine.tick(); await drain()
    expect(store.ticket(route.ticket)?.result).toBe("Unrelated later result on the same ticket")
    expect(store.input(route.input)?.result).toContain("17 of 23")
    expect(JSON.parse(store.input(request.id)!.result).input).toBe(route.input)
  })

  test("global router chooses same-session followup or unrelated create despite focus", async () => {
    let routeCount = 0
    aether.respond = async (call) => {
      if (!call.schema) return result(call)
      routeCount++
      const ticket = store.tickets()[0]
      return result(call, routeCount === 2 ? { action: "followup", ticket: ticket!.id, title: "", text: "same research topic" }
        : { action: "create", ticket: "", title: routeCount === 1 ? "边界研究" : "无关文献研究", text: "independent topic" })
    }
    engine.submit("route1", "开始研究边界"); engine.tick(); await drain(); engine.tick(); await drain()
    const first = store.tickets()[0]!
    engine.submit("route2", "继续刚才边界研究", undefined, undefined, first.id)
    expect(() => engine.submit("route2", "继续刚才边界研究", undefined, undefined, "different-focus")).toThrow("different request")
    engine.tick(); await drain(); engine.tick(); await drain()
    expect(store.tickets()).toHaveLength(1)
    expect(aether.calls.filter((call) => !call.schema).map((call) => call.session)).toEqual([first.session, first.session])
    engine.submit("route3", "开始一个完全无关的文献研究", undefined, undefined, first.id)
    engine.tick(); await drain(); engine.tick(); await drain()
    expect(store.tickets()).toHaveLength(2)
    expect(store.tickets()[1]!.session).not.toBe(first.session)
    expect(routeCount).toBe(3)
    expect(store.tickets().every((ticket) => store.research(ticket.id)?.stage !== "review")).toBe(true)
  })
})
