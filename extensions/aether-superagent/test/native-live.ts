import { homedir } from "node:os"
// Explicit opt-in: consumes the operator's DeepSeek API quota. Never runs under
// `bun test`. Credentials are inherited only by Aether, not the coordinator.
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { git } from "../src/workspace"
import { Aether } from "../src/aether"
import { id } from "../src/store"
import type { Research, ResearchEvent } from "../src/research"

if (!process.env.DEEPSEEK_API_KEY) throw new Error("Set DEEPSEEK_API_KEY for this explicitly paid integration test.")
const upstream = path.resolve(process.argv[2] ?? "../Aether")
const root = process.env.SUPERAGENT_TEST_ROOT ?? path.join(homedir(), "data/aether-superagent-tests")
await mkdir(root, { recursive: true })
const directory = await mkdtemp(path.join(root, "native-live-"))
const repo = path.join(directory, "repo")
await mkdir(path.join(repo, "data"), { recursive: true })
await writeFile(path.join(repo, "bounds.py"), "def clamp(value, low, high):\n    return min(low, max(high, value))\n")
await writeFile(path.join(repo, "test_bounds.py"), `import unittest
from bounds import clamp

class BoundsTest(unittest.TestCase):
    def test_inside(self): self.assertEqual(clamp(5, 0, 10), 5)
    def test_below(self): self.assertEqual(clamp(-3, 0, 10), 0)
    def test_above(self): self.assertEqual(clamp(13, 0, 10), 10)
    def test_equal(self): self.assertEqual(clamp(4, 2, 2), 2)
    def test_reversed(self):
        with self.assertRaises(ValueError): clamp(3, 8, 2)

if __name__ == '__main__': unittest.main()
`)
await writeFile(path.join(repo, "data/sales.csv"), 'category,amount\nbooks,12.50\n"lab, tools",20.25\nbooks,-2.50\n"lab, tools",9.75\nbooks,0.10\n')
await writeFile(path.join(repo, "README.md"), "# Two independent small agent acceptance tasks\nUse Python standard library only. Do not install packages or access files outside this repository.\n")
await git(repo, "init")
await git(repo, "add", ".")
await git(repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "initial intentionally failing fixture")
const provider = {
  name: "DeepSeek", npm: "@ai-sdk/openai-compatible", env: ["DEEPSEEK_API_KEY"],
  options: { baseURL: "https://api.deepseek.com/v1" },
  models: { "deepseek-flash": { name: "DeepSeek Flash", tool_call: true, reasoning: false,
    limit: { context: 65536, output: 4096 }, options: { thinking: { type: "disabled" } } } },
}
const config = {
  enabled_providers: ["deepseek"], model: "deepseek/deepseek-flash", small_model: "deepseek/deepseek-flash",
  provider: { deepseek: provider }, default_agent: "acceptance-worker",
  agent: { "acceptance-worker": {
    description: "Bounded local acceptance worker", mode: "primary", steps: 12,
    prompt: "Complete the requested small local task directly. Use tools to read, edit and test files. Do not delegate. Stay inside the supplied repository. Never read or print credentials, environment variables, personal files or unrelated repositories. Do not commit or push. If asked to return a routing decision, use StructuredOutput and do no execution.",
    permission: { task: "deny", webfetch: "deny", websearch: "deny", external_directory: "deny", external_read: "deny" },
  } },
}
await writeFile(path.join(directory, "aether-config.json"), JSON.stringify(config, null, 2))
const password = crypto.randomUUID()
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const log = Bun.file(path.join(directory, "aether.log"))
const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const backendPort = reserved.port!
reserved.stop(true)
const backend = Bun.spawn([process.execPath, "run", "--conditions=browser", path.join(upstream, "packages/opencode/src/index.ts"), "serve", "--hostname", "127.0.0.1", "--port", String(backendPort)], {
  cwd: path.join(upstream, "packages/opencode"),
  env: {
    PATH: process.env.PATH, LANG: "C.UTF-8", DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    XDG_DATA_HOME: path.join(directory, "data"), XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_CACHE_HOME: path.join(directory, "cache"), XDG_STATE_HOME: path.join(directory, "xdg-state"),
    OPENCODE_TEST_HOME: path.join(directory, "home"), OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_BACKGROUND_SERVICES: "false", OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_CHANNEL: "superagent-live-test", OPENCODE_SERVER_PASSWORD: password, TMPDIR: directory,
  }, stdout: log, stderr: log,
})
let coordinator: ReturnType<typeof Bun.spawn> | undefined
let bearer = ""
let api = ""
let aether = ""
let tickets: Ticket[] = []
type Ticket = { id: string; title: string; session: string; directory: string; state: string; result: string }
type Input = { id: string; state: string; result: string }
const call = async <T>(route: string, body?: object): Promise<T> => {
  const response = await fetch(`${api}${route}`, { method: body ? "POST" : "GET", headers: {
    Authorization: `Bearer ${bearer}`, "Content-Type": "application/json",
  }, body: body ? JSON.stringify(body) : undefined })
  const value = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(value))
  return value as T
}
const progressEvents = new Map<number, ResearchEvent>()
const runningProgress = new Set<string>()
const observations: { at: number; ticket: string; state: string; revision: number; stage: string }[] = []
async function observeResearch() {
  const snapshot = await call<{ tickets: (Ticket & { research: Research | null })[]; events: ResearchEvent[] }>("/panel/state")
  for (const event of snapshot.events) if (event.kind === "progress") progressEvents.set(event.id, event)
  for (const ticket of snapshot.tickets) {
    const research = ticket.research
    if (!research) continue
    if (research.stage === "review") {
      assert.ok(research.evidence.length > 0, "Review must cite evidence")
      assert.ok(research.milestones.length > 0 && research.milestones.every((item) => item.state === "done"), "Review milestones must be complete")
      assert.equal(research.blockers.length, 0)
    }
    if (ticket.state === "running" && snapshot.events.some((event) => event.ticket === ticket.id && event.input === research.input && event.kind === "progress")) {
      runningProgress.add(ticket.id)
      if (!observations.some((item) => item.ticket === ticket.id && item.revision === research.revision))
        observations.push({ at: Date.now(), ticket: ticket.id, state: ticket.state, revision: research.revision, stage: research.stage })
    }
  }
  await writeFile(path.join(directory, "research-observations.json"), JSON.stringify({ runningTickets: [...runningProgress], observations, events: [...progressEvents.values()] }, null, 2))
  return snapshot
}
async function python(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["python3", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, output, error] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code, output, error }
}
try {
  for (let i = 0; i < 120; i++) {
    aether = (await log.text()).match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? ""
    if (aether) break
    if (backend.exitCode !== null) throw new Error(`Aether failed; inspect ${log.name}`)
    await Bun.sleep(500)
  }
  assert.ok(aether, "Aether startup timeout")
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port!
  reservation.stop(true)
  api = `http://127.0.0.1:${port}`
  const state = path.join(directory, "coordinator")
  const settings = path.join(directory, "coordinator.json")
  await writeFile(settings, JSON.stringify({ repo, state, aether, port, workers: 2, model: { providerID: "deepseek", modelID: "deepseek-flash" } }, null, 2))
  coordinator = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/main.ts"), settings], {
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", AETHER_AUTHORIZATION: authorization },
    stdout: Bun.file(path.join(directory, "coordinator.log")), stderr: Bun.file(path.join(directory, "coordinator.err")),
  })
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${api}/health`).then((r) => r.ok).catch(() => false)) break
    if (coordinator.exitCode !== null) throw new Error("Coordinator exited during startup")
    await Bun.sleep(100)
  }
  bearer = (await readFile(path.join(state, "token"), "utf8")).trim()
  const globalConfig = path.join(directory, "config/aether")
  await mkdir(path.join(globalConfig, "plugins"), { recursive: true })
  await mkdir(path.join(globalConfig, "agents"), { recursive: true })
  const bridge = path.join(globalConfig, "superagent.json")
  await writeFile(bridge, JSON.stringify({ url: api, tokenFile: path.join(state, "token") }), { mode: 0o600 })
  const plugin = await readFile(path.join(import.meta.dir, "../integration/plugin/superagent.ts"), "utf8")
  await writeFile(path.join(globalConfig, "plugins/aether-superagent.ts"), plugin.replace("__SUPERAGENT_BRIDGE__", JSON.stringify(bridge)).replace("__SUPERAGENT_PLUGIN__", JSON.stringify(path.join(upstream, "packages/plugin/src/index.ts"))))
  for (const agent of ["superagent", "superagent-worker"]) {
    let preset = await readFile(path.join(import.meta.dir, `../integration/agents/${agent}.md`), "utf8")
    // This bounded fixture never needs external files. Reject immediately so a
    // model choosing /tmp can switch to stdin without hanging on permission UI.
    // These overrides exist only in the fixture's private configuration tree.
    if (agent === "superagent-worker") preset = preset.replace("permission:\n", "permission:\n  external_directory: deny\n  external_read: deny\n")
    await writeFile(path.join(globalConfig, `agents/${agent}.md`), preset)
  }
  const client = new Aether(aether, authorization)
  const master = await call<{ directory: string; session: string }>("/native/open", {})
  const send = (text: string) => client.prompt(master.directory, master.session, id("msg"), text,
    { providerID: "deepseek", modelID: "deepseek-flash" }, undefined, { agent: "superagent" })
  const before = await python(repo, "-m", "unittest", "-v", "test_bounds.py")
  assert.notEqual(before.code, 0)
  const first = await send("请直接通过superagent_dispatch安排一个小任务；你本轮只负责派工，不要先自己定位、读取或测试仓库，worker会在默认任务仓库中执行：修复默认任务仓库 bounds.py 的 clamp，low>high抛ValueError。读取运行test_bounds.py，不能改测试或CSV，不提交。执行前报告progress，完成后用superagent_report返回answer和测试证据。你负责在这个主会话里向我汇报真实结果。")
  console.log(JSON.stringify({ stage: "first-dispatched", directory, master }))
  const second = await send("另一个独立任务：通过superagent_dispatch派工，读取默认任务仓库data/sales.csv，用Python标准库csv和Decimal逐类别求和。只读调查，不能改仓库文件。worker要用superagent_report报告进度与最终答案，最终需给出行数和每类精确总额。不要与clamp工单合并。")
  const began = Date.now()
  let final: any
  while (Date.now() - began < 12 * 60_000) {
    final = await call<any>("/panel/state")
    tickets = final.tickets
    const native = final.native
    if (tickets.length === 2 && tickets.every((ticket) => ticket.state === "waiting") &&
      native.runs.every((run: any) => run.state === "done") && native.outbox.length >= 2 && native.outbox.every((notice: any) => notice.state === "delivered")) break
    if (native.outbox.some((notice: any) => notice.state === "unknown"))
      await writeFile(path.join(directory, "pending-notices.json"), JSON.stringify(native.outbox, null, 2))
    await Bun.sleep(1000)
  }
  assert.equal(tickets.length, 2)
  assert.ok(tickets.every((ticket) => ticket.state === "waiting"), "Both actual worker executions must finish")
  assert.ok(final.native.reports.filter((report: any) => ["answer", "ready"].includes(report.kind)).length >= 2, "Both workers must use report tool")
  assert.ok(final.native.outbox.every((notice: any) => notice.state === "delivered"), "Reports must be acknowledged by native main conversation")
  const checks = []
  for (const ticket of tickets) {
    const content = await readFile(path.join(ticket.directory, "bounds.py"), "utf8")
    const original = await readFile(path.join(repo, "bounds.py"), "utf8")
    if (content !== original) {
      const tests = await python(ticket.directory, "-m", "unittest", "-v", "test_bounds.py")
      assert.equal(tests.code, 0)
      assert.equal(await readFile(path.join(ticket.directory, "test_bounds.py"), "utf8"), await readFile(path.join(repo, "test_bounds.py"), "utf8"))
      checks.push({ kind: "clamp", ticket: ticket.id, tests })
    } else {
      const reports = final.native.reports.filter((report: any) => report.ticket === ticket.id).map((report: any) => report.answer ?? report.summary).join("\n")
      assert.ok(reports.includes("10.10") && reports.includes("30.00"), "CSV answer must match independent exact totals")
      const changes = await git(ticket.directory, "status", "--porcelain")
      assert.equal(changes.trim(), "", "Read-only worker must leave its repository unchanged")
      checks.push({ kind: "csv", ticket: ticket.id, expected: { rows: 5, books: "10.10", "lab, tools": "30.00" } })
    }
  }
  assert.equal(checks.filter((check) => check.kind === "clamp").length, 1)
  assert.equal(checks.filter((check) => check.kind === "csv").length, 1)
  const history = await client.request(master.directory, `/session/${master.session}/message`)
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify({ passed: true, realApi: true, model: "deepseek/deepseek-flash", directory, master, checks, first, second, final, history }, null, 2))
  console.log(JSON.stringify({ stage: "passed", directory, checks }))
} finally {
  for (const ticket of tickets) {
    const url = new URL(`/session/${ticket.session}/abort`, aether || "http://127.0.0.1:1")
    url.searchParams.set("directory", ticket.directory)
    await fetch(url, { method: "POST", headers: { Authorization: authorization }, signal: AbortSignal.timeout(5000) }).catch(() => undefined)
  }
  coordinator?.kill("SIGTERM")
  if (coordinator) await coordinator.exited
  backend.kill("SIGTERM")
  await backend.exited
}
