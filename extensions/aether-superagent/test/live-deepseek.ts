import { homedir } from "node:os"
// Explicit opt-in: consumes the operator's DeepSeek API quota. Never runs under
// `bun test`. Credentials are inherited only by Aether, not the coordinator.
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { git } from "../src/workspace"
import type { Research, ResearchEvent } from "../src/research"

if (!process.env.DEEPSEEK_API_KEY) throw new Error("Set DEEPSEEK_API_KEY for this explicitly paid integration test.")
const upstream = path.resolve(process.argv[2] ?? "../Aether")
const root = process.env.SUPERAGENT_TEST_ROOT ?? path.join(homedir(), "data/aether-superagent-tests")
await mkdir(root, { recursive: true })
const directory = await mkdtemp(path.join(root, "live-deepseek-"))
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
  const before = await python(repo, "-m", "unittest", "-v", "test_bounds.py")
  assert.notEqual(before.code, 0, "Fixture should fail before agent work")
  await writeFile(path.join(directory, "baseline-tests.json"), JSON.stringify(before, null, 2))
  const first = await call<Input>("/requests", { key: "real-clamp", text: "新建一个独立任务：修复 bounds.py 的 clamp(value, low, high)。它应将 value 限制在闭区间 [low, high]，当 low > high 时抛出 ValueError。请读取并运行现有 test_bounds.py，修复后重新运行测试。不得修改现有测试，不要修改 CSV 或其他任务文件，不提交也不推送。开始执行时先用 write 工具写本轮指定进度 JSON，随后更新里程碑与证据；原有测试和独立检查完成后再报告 review。最后简要报告改动和测试结果。" })
  const second = await call<Input>("/requests", { key: "real-csv", text: "这是另一个独立任务，不是 clamp 的追问。请新增 Python 标准库脚本 summarize.py，读取 data/sales.csv，正确处理带逗号的 quoted category 和负数金额，用 Decimal 按 category 求和。输出 summary.json，格式为 {\"rows\":行数,\"totals\":{类别:保留两位小数的金额字符串}}，totals 按类别排序。运行脚本检查结果。只创建 summarize.py、summary.json，以及本轮 SUPERAGENT_PROGRESS 指定的进度 JSON，不修改 bounds.py 或测试，不提交也不推送。开始执行时先用 write 工具写本轮指定进度 JSON，随后更新里程碑与证据；运行脚本核对正确后再报告 review。最后报告结果。" })
  console.log(JSON.stringify({ stage: "submitted", directory, inputs: [first.id, second.id], api, aether }))
  let overlap = false
  let last = ""
  const began = Date.now()
  while (Date.now() - began < 15 * 60_000) {
    await observeResearch()
    tickets = await call<Ticket[]>("/tickets")
    const inputs = await call<Input[]>("/inputs")
    overlap ||= tickets.filter((t) => t.state === "running").length === 2
    const status = JSON.stringify({ tickets: tickets.map((t) => ({ id: t.id, state: t.state, title: t.title })), inputs: inputs.map((i) => ({ id: i.id, state: i.state })) })
    if (status !== last) { console.log(status); last = status }
    if (inputs.some((i) => i.state === "uncertain")) throw new Error(`Input requires attention: ${inputs.filter((i) => i.state === "uncertain").map((i) => i.result).join("\n").slice(0, 3000)}`)
    if (tickets.length === 2 && tickets.every((t) => t.state === "waiting") && inputs.every((i) => i.state === "done")) break
    await Bun.sleep(1000)
  }
  await observeResearch()
  assert.equal(tickets.length, 2, "Router must create two independent tickets")
  for (const ticket of tickets) {
    assert.ok([...progressEvents.values()].some((event) => event.ticket === ticket.id), "Both workers must report structured research progress")
    assert.ok(runningProgress.has(ticket.id), "Each worker progress must be observed while it is running")
  }
  assert.ok(tickets.every((t) => t.state === "waiting"), "Workers did not finish in bounded time")
  const routed = await call<Input>(`/inputs/${first.id}`)
  const clamp = tickets.find((t) => t.id === JSON.parse(routed.result).ticket)!
  const csv = tickets.find((t) => t.id !== clamp.id)!
  const unit = await python(clamp.directory, "-m", "unittest", "-v", "test_bounds.py")
  assert.equal(unit.code, 0, JSON.stringify(unit))
  assert.equal(await readFile(path.join(clamp.directory, "test_bounds.py"), "utf8"), await readFile(path.join(repo, "test_bounds.py"), "utf8"))
  const holdout = await python(clamp.directory, "-c", "from bounds import clamp\nfor lo,hi in [(-4,7),(0,0),(2.5,3.5)]:\n for x in [-10,-4,0,2.75,7,20]:\n  assert clamp(x,lo,hi)==max(lo,min(hi,x))\ntry: clamp(1,3,2)\nexcept ValueError: pass\nelse: raise AssertionError('missing error')\nprint('19 independent checks passed')")
  assert.equal(holdout.code, 0, JSON.stringify(holdout))
  const csvrun = await python(csv.directory, "summarize.py")
  assert.equal(csvrun.code, 0, JSON.stringify(csvrun))
  const summary = JSON.parse(await readFile(path.join(csv.directory, "summary.json"), "utf8"))
  assert.deepEqual(summary, { rows: 5, totals: { books: "10.10", "lab, tools": "30.00" } })
  assert.equal(await readFile(path.join(csv.directory, "bounds.py"), "utf8"), await readFile(path.join(repo, "bounds.py"), "utf8"))
  const followup = await call<Input>("/requests", { key: "real-followup", text: "继续刚才修复 clamp 的原工单，不要新建任务，也不要动 CSV 任务。在同一工作目录新增 CLAMP_NOTES.txt，用两句话说明 low==high 时的返回值，以及 low>high 时的异常。重新运行原有测试，保留修复代码。允许写本轮指定进度 JSON；开始时报告计划，验证后更新证据与里程碑。" })
  for (let i = 0; i < 300; i++) {
    await observeResearch()
    const inputs = await call<Input[]>("/inputs")
    if (inputs.some((x) => x.state === "uncertain")) throw new Error("Followup requires attention")
    if (inputs.every((x) => x.state === "done")) break
    await Bun.sleep(1000)
  }
  const followed = await call<Input>(`/inputs/${followup.id}`)
  assert.equal(followed.state, "done")
  assert.equal(JSON.parse(followed.result).action, "followup")
  assert.equal(JSON.parse(followed.result).ticket, clamp.id)
  tickets = await call<Ticket[]>("/tickets")
  assert.equal(tickets.length, 2)
  assert.equal(tickets.find((ticket) => ticket.id === clamp.id)?.session, clamp.session, "Followup must preserve original session")
  const finalResearch = await observeResearch()
  for (const ticket of finalResearch.tickets) {
    assert.equal(ticket.research?.stage, "review", "Verified bounded tasks should report ready for human review")
    assert.ok(ticket.research!.evidence.length > 0 && ticket.research!.milestones.every((item) => item.state === "done"))
  }
  assert.ok((await readFile(path.join(clamp.directory, "CLAMP_NOTES.txt"), "utf8")).trim().length > 0)
  const after = await python(clamp.directory, "-m", "unittest", "-v", "test_bounds.py")
  assert.equal(after.code, 0)
  const histories = []
  for (const ticket of tickets) {
    const url = new URL(`/session/${ticket.session}/message`, aether)
    url.searchParams.set("directory", ticket.directory)
    const messages = await fetch(url, { headers: { Authorization: authorization } }).then((r) => r.json())
    histories.push({ ticket: ticket.id, messages })
  }
  const receipt = { passed: true, directory, aetherHead: await git(upstream, "rev-parse", "HEAD"), model: "deepseek/deepseek-flash",
    realApi: true, overlapObserved: overlap, tickets, baseline: before, tests: unit, holdout, csvrun, summary, followup: followed, after,
    inputs: await call<Input[]>("/inputs"), histories, research: { final: finalResearch, runningProgressTickets: [...runningProgress], observations, events: [...progressEvents.values()] } }
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ stage: "passed", directory, overlapObserved: overlap, checks: ["two real routed tasks", "five existing tests preserved and passing", "19 independent clamp checks", "exact CSV totals", "followup returned to original ticket", "two worker sessions persisted", "both workers reported progress while running", "review snapshots contain evidence and completed milestones"] }))
} finally {
  // Cancel only sessions created by this test, then stop only its own processes.
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
