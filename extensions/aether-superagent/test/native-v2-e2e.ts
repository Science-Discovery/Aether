// Opt-in real browser acceptance: actual Aether backend, actual panel main and
// actual Aether Web/Vite, with a local deterministic model (no paid API).
import { mkdir, mkdtemp, writeFile, readFile, access, readdir, symlink } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import assert from "node:assert/strict"
import { git } from "../src/workspace"
import { install } from "../src/integration"

const verifyCron = process.env.NATIVE_E2E_CRON === "1"
const verifyProjects = process.env.NATIVE_E2E_PROJECTS === "1"
const cronFinding = "CRON_FINDING: 下一步应核对剩余 6 个族的检查记录，等待用户确定范围。"
const source = path.resolve(process.argv[2] ?? "../Aether")
const parent = process.env.SUPERAGENT_TEST_ROOT ?? path.join(homedir(), "data/aether-superagent-tests")
await mkdir(parent, { recursive: true })
const directory = await mkdtemp(path.join(parent, "native-v2-e2e-"))
const upstream = path.join(directory, "Aether-native")
await git(source, "worktree", "add", "--detach", upstream, "HEAD")
// Reuse installed dependencies without copying them or changing the source tree.
async function linkDependencies(from: string, to: string, depth = 0) {
  if (depth > 4) return
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      await mkdir(to, { recursive: true })
      await symlink(path.join(from, entry.name), path.join(to, entry.name), "dir")
    } else if (entry.isDirectory() && !entry.name.startsWith(".") && ["packages", "script", "app", "opencode", "ui", "sdk", "js", "util", "plugin", "function"].includes(entry.name)) {
      await linkDependencies(path.join(from, entry.name), path.join(to, entry.name), depth + 1)
    }
  }
}
await linkDependencies(source, upstream)
const repo = path.join(directory, "工程-fixture"), state = path.join(directory, "coordinator")
await mkdir(repo); await mkdir(state)
await git(repo, "init")
await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "panel fixture")
const externalResearch = path.join(directory, "external-research")
await mkdir(externalResearch)
const externalFile = path.join(externalResearch, "STATUS.txt")
const externalEvidence = `EVIDENCE_${crypto.randomUUID()}: 17 of 23 families checked; 6 remain.`
await writeFile(externalFile, externalEvidence + "\n")
let liveEvidence = externalEvidence
const secondFile = path.join(repo, "EXISTING.txt")
const secondEvidence = `SECOND_${crypto.randomUUID()}: 4 of 9 checks remain.`
if (verifyProjects) {
  await writeFile(secondFile, secondEvidence + "\n")
  await git(repo, "add", "EXISTING.txt")
  await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "existing project data")
}
const originalHead = await git(repo, "rev-parse", "HEAD")
const damaged = path.join(directory, "damaged-project")
if (verifyProjects) {
  await mkdir(path.join(damaged, ".git"), { recursive: true })
  await writeFile(path.join(damaged, ".git", "preserve.txt"), "Do not overwrite invalid existing metadata.\n")
  await writeFile(path.join(damaged, "STATUS.txt"), "Existing research is preserved.\n")
}
const dispatches: object[] = []
let releaseMaster: (() => void) | undefined
let releaseWorker: (() => void) | undefined
const fixtureToken = "native-v2-server-side-fixture-only"
await writeFile(path.join(state, "token"), fixtureToken, { mode: 0o600 })
const calls: { tools: string[]; at: number; operation: string; prompt: string }[] = []
const flatten = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => part.text ?? "").join("\n") : ""
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as { stream?: boolean; tools?: { function: { name: string } }[]; messages?: { role: string; content: unknown; name?: string }[] }
  const tools = (body.tools ?? []).map((x) => x.function.name), messages = body.messages ?? []
  const lastUser = messages.findLastIndex((message) => message.role === "user")
  const prompt = flatten(messages[lastUser]?.content)
  const results = messages.slice(lastUser + 1).filter((message) => message.role === "tool")
  const selected = verifyProjects && prompt.includes("PROJECT_C")
    ? { directory: damaged, file: path.join(damaged, "STATUS.txt"), evidence: "Existing research is preserved." }
    : verifyProjects && prompt.includes("PROJECT_B")
      ? { directory: repo, file: secondFile, evidence: secondEvidence }
      : { directory: externalResearch, file: externalFile, evidence: liveEvidence }
  let delta: object, operation: string, finish = "stop"
  const tool = (name: string, args: object) => {
    assert.ok(tools.includes(name), `Required actual tool missing: ${name}`)
    finish = "tool_calls"
    return { tool_calls: [{ index: 0, id: `call_${crypto.randomUUID().replaceAll("-", "")}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
  }
  try {
    const line = prompt.split("\n").find((line) => line.startsWith("SUPERAGENT_RUN: "))
    if (verifyProjects && !line && tools.includes("superagent_dispatch")) {
      for (const raw of ["read", "bash", "task"]) assert.ok(!tools.includes(raw), `Primary agent must delegate instead of exposing ${raw}`)
    }
    if (line) {
      const run = JSON.parse(line.slice("SUPERAGENT_RUN: ".length)) as { ticket: string; run: string; revision: number }
      if (verifyProjects) {
        const binding = prompt.split("\n").find((line) => line.startsWith("SOURCE_PROJECT "))
        assert.ok(binding, "Worker receives its source binding explicitly")
        assert.equal(JSON.parse(binding.slice("SOURCE_PROJECT ".length)).directory, selected.directory)
      }
      if (results.length === 0) {
        if (prompt.includes("HOLD_WORKER")) await new Promise<void>((resolve) => { releaseWorker = resolve })
        operation = "worker-progress"
        delta = tool("superagent_report", { ...run, kind: "progress", summary: "正在读取本地科研记录", research: { stage: "research", summary: "正在读取本地科研记录", milestones: [{ id: "read", title: "核对真实记录", state: "active" }], blockers: [] } })
      } else if (results.length === 1) {
        assert.ok(!flatten(results[0]?.content).includes("Error"), flatten(results[0]?.content))
        operation = "worker-read"; delta = tool("read", { filePath: selected.file })
      } else if (results.length === 2) {
        assert.ok(flatten(results[1]?.content).includes(selected.evidence), "Actual read tool must return current source evidence")
        operation = "worker-answer"
        delta = tool("superagent_report", { ...run, revision: run.revision + 1, kind: "answer", summary: selected.evidence, answer: `原生科研答复：${selected.evidence}`, research: { stage: "review", summary: verifyProjects ? `已核对真实文件：${selected.evidence}` : "已核对真实文件：23 个族中已检查 17 个", next: "等待用户确认后续范围", blockers: [], milestones: [{ id: "read", title: "核对真实记录", state: "done" }], evidence: [{ label: "原始记录", path: selected.file }] } })
      } else {
        operation = "worker-final"; delta = { content: `执行完成：${selected.evidence}` }
      }
    } else if (prompt.includes("Scheduled check-in:")) {
      if (results.length === 0) {
        operation = "checker-status"; delta = tool("superagent_status", {})
      } else {
        const actual = JSON.parse(flatten(results[0]?.content))
        assert.ok(actual.tickets?.some((ticket: { research?: { summary?: string } }) => ticket.research?.summary?.includes("23 个族")), "Checker must receive real persisted task status")
        const quiet = !calls.some((call) => call.operation === "checker-no-update")
        operation = quiet ? "checker-no-update" : "checker-finding"
        delta = { content: quiet ? "NO_UPDATE" : cronFinding }
      }
    } else if (prompt.includes("Background check-in finding")) {
      assert.ok(prompt.includes(cronFinding), "Master receives exact checker finding")
      operation = "master-checkin-reply"; delta = { content: `主控主动检查发现：${cronFinding}` }
    } else if (prompt.includes("Super-agent system event")) {
      operation = "master-report-reply"; delta = { content: verifyProjects
        ? `主控已收到实际科研结果：${prompt}`
        : `主控已收到实际科研结果：${externalEvidence}。剩余 6 个族尚未检查。` }
    } else if (prompt.includes("NATIVE_V2_REQUEST")) {
      if (results.length === 0) {
        if (verifyProjects && prompt.includes("PROJECT_A") && !prompt.includes("FOLLOWUP"))
          await new Promise<void>((resolve) => { releaseMaster = resolve })
        const prior = prompt.includes("FOLLOWUP") ? (await stateRead()).tickets.find((ticket) => !verifyProjects || ticket.project?.directory === selected.directory) : undefined
        operation = prior ? "master-followup" : "master-dispatch"
        const args = { text: `${prompt} 只读 ${selected.file} 并报告证据。`, title: verifyProjects ? (selected.directory === damaged ? "初始化失败项目C" : selected.directory === repo ? "已有Git项目B" : "现有文件项目A") : "原生科研检查",
          ...(prior ? { ticket: prior.id } : verifyProjects ? { project: selected.directory } : {}) }
        dispatches.push(args)
        delta = tool("superagent_dispatch", args)
      } else {
        assert.ok(flatten(results[0]?.content).includes('"ticket"'), flatten(results[0]?.content))
        operation = "master-acknowledge"; delta = { content: "已安排实际文件检查，结果会回到这个主控会话。" }
      }
    } else { operation = "background"; delta = { content: "本地确定性检查完成。" } }
    calls.push({ tools, at: Date.now(), operation, prompt })
    if (!body.stream) return Response.json({ id: "fixture", object: "chat.completion", created: 1, model: "tiny", choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "tiny", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })
  } catch (error) {
    calls.push({ tools, at: Date.now(), operation: `fixture-failed:${error}`, prompt })
    return Response.json({ error: { message: String(error), type: "invalid_request_error" } }, { status: 400 })
  }
} })
function port() { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const p = s.port!; s.stop(true); return p }
const apiPort = port(), panelPort = port(), webPort = port()
const apiUrl = `http://127.0.0.1:${apiPort}`, panelUrl = `http://127.0.0.1:${panelPort}`, webUrl = `http://127.0.0.1:${webPort}`
const bridge = path.join(directory, "bridge/superagent.json")
await install({ root: upstream, bridge, url: panelUrl, token: path.join(state, "token") })

const isolated = {
  PATH: process.env.PATH, LANG: "C.UTF-8", HOME: process.env.HOME,
  XDG_DATA_HOME: path.join(directory, "data"), XDG_CONFIG_HOME: path.join(directory, "config"), XDG_CACHE_HOME: path.join(directory, "cache"),
  XDG_STATE_HOME: path.join(directory, "xdg-state"), OPENCODE_TEST_HOME: path.join(directory, "home"), OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"), TMPDIR: directory,
}
const config = { enabled_providers: ["fixture"], model: "fixture/tiny", small_model: "fixture/tiny",
  provider: { fixture: { name: "Local fixture", npm: "@ai-sdk/openai-compatible", env: [], options: { apiKey: "fixture-only", baseURL: `${model.url.origin}/v1` },
    models: { tiny: { name: "Tiny", tool_call: true, limit: { context: 100_000, output: 2000 } } } } }, agent: { "superagent-worker": { steps: 10, permission: { external_read: { [path.join(externalResearch, "*")]: "allow", ...(verifyProjects ? { [path.join(repo, "*")]: "allow" } : {}) } } } } }
const children: ReturnType<typeof Bun.spawn>[] = []
function launch(name: string, command: string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd, env, stdout: Bun.file(path.join(directory, `${name}.log`)), stderr: Bun.file(path.join(directory, `${name}.log`)) })
  children.push(child); return child
}
const backend = launch("aether", [process.execPath, "run", "--conditions=browser", path.join(upstream, "packages/opencode/src/index.ts"), "serve", "--hostname", "127.0.0.1", "--port", String(apiPort)], path.join(upstream, "packages/opencode"), {
  ...isolated, OPENCODE_CONFIG_DIR: path.dirname(bridge), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_BACKGROUND_SERVICES: "false",
  OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true", OPENCODE_CHANNEL: `native-v2-e2e-${apiPort}`, AETHER_SUPERAGENT_CONFIG: bridge,
})
async function until(check: () => boolean | Promise<boolean>, description: string, timeout = 90_000) {
  const end = Date.now() + timeout
  while (!await check()) { if (Date.now() >= end) throw new Error(`Timed out: ${description}`); await Bun.sleep(300) }
}
async function available(url: string) { try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok } catch { return false } }
async function stateRead() { const response = await fetch(`${panelUrl}/panel/state`, { headers: { Authorization: `Bearer ${fixtureToken}` } }); assert.equal(response.status, 200); return await response.json() as { native: { enabled: boolean; installed: boolean; master?: { session: string; directory: string }; schedule: { enabled: boolean; minutes: number }; reports: { kind: string; run: string }[]; outbox: { kind: string; state: string }[] }; tickets: { id: string; project?: { directory: string; repo?: string; base?: string; initialized?: boolean }; title: string; session: string; directory: string; state: string; result: string; research: { summary: string; revision: number; stage: string; input: string } }[]; inputs: { id: string; key: string; mode: string; result: string; ticket: string | null; state: string }[] } }
const browserSession = "sa-native-v2-independent"
const commands: { args: string[]; code: number; output: string; error: string }[] = []
async function browser(...args: string[]) {
  const child = Bun.spawn(["agent-browser", "--session", browserSession, ...args], { stdout: "pipe", stderr: "pipe" })
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  commands.push({ args, code, output, error })
  await writeFile(path.join(directory, "browser-commands.json"), JSON.stringify(commands, null, 2))
  if (code) throw new Error(`Browser ${args[0]} failed: ${error || output}`)
  return output
}
let receipt: Record<string, unknown> = { passed: false, directory, upstream, apiUrl, panelUrl, webUrl, model: "local deterministic fixture; no paid API", browserSession, verifyProjects }
try {
  await until(async () => { if (backend.exitCode !== null) throw new Error(`Backend exited ${backend.exitCode}`); return available(`${apiUrl}/global/health`) }, "backend startup")
  const web = launch("web", [process.execPath, "run", "dev", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], path.join(upstream, "packages/app"), { ...isolated, VITE_OPENCODE_SERVER_HOST: "127.0.0.1", VITE_OPENCODE_SERVER_PORT: String(apiPort) })
  await until(async () => { if (web.exitCode !== null) throw new Error(`Real Aether Web exited ${web.exitCode}`); return available(webUrl) }, "real Aether Vite startup")
  const panelConfig = path.join(directory, "panel-config.json")
  await writeFile(panelConfig, JSON.stringify({ ...(verifyProjects ? {} : { repo, base: "HEAD" }), state, workers: 2, aether: apiUrl, port: panelPort, model: { providerID: "fixture", modelID: "tiny" } }))
  launch("panel", [process.execPath, "run", path.resolve("src/main.ts"), panelConfig], process.cwd(), { ...isolated })
  await until(() => available(`${panelUrl}/health`), "panel main startup")
  const ready = { directory, apiUrl, panelUrl, webUrl, bridge, pids: children.map((x) => x.pid) }
  await writeFile(path.join(directory, "ready.json"), JSON.stringify(ready, null, 2))
  console.log(JSON.stringify({ stage: "ready", ...ready }))
  await browser("set", "viewport", "1440", "900")
  await browser("open", webUrl)
  await browser("eval", `window.__nativeResponses = []; const originalFetch = window.fetch; window.fetch = async (...args) => { const response = await originalFetch(...args); if (String(args[0]?.url ?? args[0]).includes('/superagent/')) window.__nativeResponses.push({url:response.url,status:response.status,body:await response.clone().text()}); return response; }`)
  await browser("wait", "[data-testid=superagent-entry]")
  await browser("click", "[data-testid=superagent-entry]")
  await browser("wait", "[data-testid=superagent-master]:not(:disabled)")
  assert.equal(calls.length, 0, "Management page must not invoke a model")
  assert.equal((await browser("get", "count", "[data-testid=superagent-message], [data-testid=superagent-answer]")).trim(), "0")
  await browser("click", "[data-testid=superagent-master]")
  await browser("wait", "[data-component=prompt-input]")
  const master = (await stateRead()).native.master!
  assert.ok(master?.session)
  assert.ok((await browser("get", "url")).includes(master.session))
  async function send(text: string) {
    await browser("wait", "[data-component=prompt-input]")
    if (verifyProjects && !(await browser("get", "text", "[data-action=prompt-agent]")).trim().toLowerCase().includes("superagent")) {
      await browser("click", "[data-action=prompt-agent]")
      await browser("wait", "--fn", "Array.from(document.querySelectorAll('[role=option]')).some(option => option.textContent.trim().toLowerCase()==='superagent')")
      await browser("eval", "Array.from(document.querySelectorAll('[role=option]')).find(option => option.textContent.trim().toLowerCase()==='superagent').click()")
    }
    await browser("fill", "[data-component=prompt-input]", text)
    await browser("press", "Enter")
  }
  await writeFile(path.join(directory, "master-before.txt"), await browser("snapshot", "-i"))
  if (verifyProjects) {
    const exists = async (file: string) => access(file).then(() => true, () => false)
    assert.equal(Object.hasOwn(JSON.parse(await readFile(panelConfig, "utf8")), "repo"), false, "Coordinator starts without a default project")
    assert.equal(await exists(path.join(externalResearch, ".git")), false, "Startup and opening master never initialize an unrelated existing directory")
    assert.equal((await stateRead()).tickets.length, 0)
    await send("你好，请先简短回复；我还没有指定任何工作项目。")
    await browser("wait", "--text", "本地确定性检查完成。")
    assert.equal((await stateRead()).tickets.length, 0, "Ordinary main conversation needs no task or project")
    assert.equal(await exists(path.join(externalResearch, ".git")), false, "Ordinary conversation never initializes a project")
    const answers = async () => (await stateRead()).native.outbox.filter((item) => item.kind === "answer" && item.state === "delivered").length
    await send(`NATIVE_V2_REQUEST PROJECT_A 请检查现有文件夹 ${externalResearch} 中的 STATUS.txt，告诉我研究进展。`)
    await until(() => !!releaseMaster, "primary response is actually pending before dispatch")
    await browser("click", "[data-testid=superagent-entry]")
    await browser("wait", "[data-testid=superagent-panel]")
    assert.equal((await stateRead()).tickets.length, 0, "Pending primary response has not dispatched a task")
    await browser("wait", "[data-testid=superagent-master-status][data-state=busy]")
    await browser("screenshot", path.join(directory, "native-primary-busy.png"))
    releaseMaster!()
    await until(async () => await answers() === 1, "repo-less task A actual read/report")
    await browser("click", "[data-testid=superagent-master]")
    await browser("wait", "[data-component=prompt-input]")
    const first = (await stateRead()).tickets.find((ticket) => ticket.project?.directory === externalResearch)!
    assert.ok(first, "First task records the explicit source project")
    assert.ok(first.session)
    assert.notEqual(first.directory, externalResearch, "Worker edits have a separate worktree")
    assert.equal(await exists(path.join(externalResearch, ".git")), true)
    assert.equal(await git(externalResearch, "ls-files"), "", "Lazy initialization never auto-adds existing files")
    assert.equal(await git(externalResearch, "rev-list", "--count", "HEAD"), "1", "Exactly one empty baseline exists")
    assert.equal(await git(externalResearch, "status", "--porcelain"), "?? STATUS.txt")
    assert.equal(await readFile(externalFile, "utf8"), externalEvidence + "\n")
    assert.equal(await exists(path.join(first.directory, "STATUS.txt")), false, "Success requires reading live source, not an absent untracked worktree copy")
    assert.equal(await git(first.directory, "rev-parse", "--path-format=absolute", "--git-common-dir"), path.join(externalResearch, ".git"))
    await browser("wait", "--text", externalEvidence)
    await browser("screenshot", path.join(directory, "project-a-master.png"))
    await send(`NATIVE_V2_REQUEST PROJECT_B 请检查另一个已有Git项目 ${repo} 的 EXISTING.txt，建立独立课题。`)
    await until(async () => await answers() === 2, "existing Git task B actual read/report")
    const second = (await stateRead()).tickets.find((ticket) => ticket.project?.directory === repo)!
    assert.ok(second)
    assert.notEqual(second.session, first.session)
    assert.notEqual(second.directory, first.directory)
    assert.equal(await git(repo, "rev-parse", "HEAD"), originalHead, "Existing repository HEAD is preserved")
    assert.equal(await git(repo, "status", "--porcelain"), "")
    assert.equal(await git(second.directory, "rev-parse", "--path-format=absolute", "--git-common-dir"), path.join(repo, ".git"))
    assert.equal(await readFile(secondFile, "utf8"), secondEvidence + "\n")
    liveEvidence = `UPDATED_${crypto.randomUUID()}: 19 of 23 families checked; 4 remain.`
    await writeFile(externalFile, liveEvidence + "\n")
    await send(`NATIVE_V2_REQUEST PROJECT_A FOLLOWUP 回到第一个课题，重新读取 ${externalFile} 的最新进展，不要新建任务。`)
    await until(async () => await answers() === 3, "same-ticket followup reads fresh live source")
    const current = (await stateRead()).tickets.find((ticket) => ticket.id === first.id)!
    assert.equal((await stateRead()).tickets.length, 2)
    assert.deepEqual(current.project, first.project)
    assert.equal(current.session, first.session)
    assert.equal(current.directory, first.directory)
    assert.equal(await readFile(externalFile, "utf8"), liveEvidence + "\n")
    assert.equal(await git(externalResearch, "ls-files"), "")
    await browser("wait", "--text", liveEvidence)
    await browser("click", "[data-testid=superagent-entry]")
    await browser("wait", "[data-testid=superagent-ticket]")
    assert.equal((await browser("get", "count", "[data-testid=superagent-ticket]")).trim(), "2")
    await browser("screenshot", path.join(directory, "native-projects-panel.png"))
    await browser("click", "[data-testid=superagent-master]")
    await send(`NATIVE_V2_REQUEST PROJECT_C 请检查 ${damaged} 的进展；已有文件和元数据必须保留。`)
    await until(async () => (await stateRead()).tickets.some((ticket) => ticket.project?.directory === damaged && ticket.state === "attention"), "initialization failure remains a visible task")
    const failed = (await stateRead()).tickets.find((ticket) => ticket.project?.directory === damaged)!
    assert.ok(failed.result.includes("Existing Git metadata is invalid"))
    assert.equal(failed.research.stage, "planning", "Initialization failure cannot claim research completion")
    assert.equal(calls.filter((call) => call.operation.startsWith("worker-") && call.prompt.includes("PROJECT_C")).length, 0)
    assert.equal(await readFile(path.join(damaged, ".git", "preserve.txt"), "utf8"), "Do not overwrite invalid existing metadata.\n")
    assert.equal(await readFile(path.join(damaged, "STATUS.txt"), "utf8"), "Existing research is preserved.\n")
    await browser("click", "[data-testid=superagent-entry]")
    await browser("wait", "--text", "初始化失败项目C")
    await browser("wait", "--text", "Existing Git metadata is invalid")
    await browser("screenshot", path.join(directory, "native-project-failure.png"))
    receipt.failedProject = failed
    const observations = await browser("eval", "JSON.stringify(window.__nativeResponses)")
    assert.ok(!observations.includes(fixtureToken))
    receipt = { ...receipt, passed: true, master, first, second, current, dispatches, state: await stateRead(), modelCalls: calls,
      checks: ["primary tools exclude raw read/bash/task", "pending primary response visible before any task", "repo-less startup and ordinary native main conversation", "no initialization before explicit task", "real dispatch supplies source project", "non-Git source gets empty baseline without auto-add", "worker reads live untracked source", "existing Git project HEAD and files preserved", "distinct per-ticket project and worktree binding", "followup preserves session/worktree/project", "followup observes updated live source", "native panel shows both research tasks", "initialization failure visible without false completion or lost files", "browser receives no coordinator credential"] }
    console.log(JSON.stringify({ stage: "projects-passed", directory, webUrl }))
  } else {
  await send("NATIVE_V2_REQUEST 请只读检查科研记录并说明进展。")
  await until(async () => (await stateRead()).native.outbox.some((item) => item.kind === "answer" && item.state === "delivered"), "worker report returned to native master")
  await browser("wait", "--text", "主控已收到实际科研结果")
  console.log(JSON.stringify({ stage: "native-report-returned", directory }))
  const first = (await stateRead()).tickets[0]!
  assert.equal(await readFile(externalFile, "utf8"), externalEvidence + "\n")
  await browser("screenshot", path.join(directory, "native-master-result.png"))
  await send("NATIVE_V2_REQUEST FOLLOWUP 继续同一个课题，再核对一次记录。")
  await until(async () => (await stateRead()).native.outbox.filter((item) => item.kind === "answer" && item.state === "delivered").length === 2, "followup native result")
  assert.equal((await stateRead()).tickets.length, 1)
  assert.equal((await stateRead()).tickets[0]!.session, first.session)
  await browser("click", "[data-testid=superagent-entry]")
  await browser("wait", "--text", "已核对真实文件")
  await browser("click", "[data-testid=superagent-ticket]")
  await browser("wait", "[data-testid=superagent-milestones]")
  await browser("screenshot", path.join(directory, "native-management.png"))
  await browser("set", "viewport", "390", "844")
  await browser("screenshot", path.join(directory, "native-management-mobile.png"))
  await browser("set", "viewport", "1440", "900")
  await browser("scrollintoview", "[data-testid=superagent-open]")
  await browser("screenshot", path.join(directory, "native-worker-link.png"))
  await browser("wait", "[data-testid=superagent-open]:not(:disabled)")
  await browser("click", "[data-testid=superagent-open]")
  await browser("wait", "[data-component=prompt-input]")
  assert.ok((await browser("get", "url")).includes(first.session))
  await browser("click", "[data-testid=superagent-entry]")
  await browser("reload")
  await browser("wait", "[data-testid=superagent-panel]")
  await Bun.sleep(1500)
  assert.equal(new URL((await browser("get", "url")).trim()).pathname, "/superagent")
  await browser("eval", `window.__nativeResponses = []; const originalFetch = window.fetch; window.fetch = async (...args) => { const response = await originalFetch(...args); if (String(args[0]?.url ?? args[0]).includes('/superagent/')) window.__nativeResponses.push({url:response.url,status:response.status,body:await response.clone().text()}); return response; }`)
  async function settings() {
    await browser("find", "role", "button", "click", "--name", "Settings", "--exact")
    await browser("wait", "--fn", "Array.from(document.querySelectorAll('[role=tab]')).some(x => x.textContent.trim() === 'Super-agent')")
    await browser("find", "role", "tab", "click", "--name", "Super-agent", "--exact")
    await browser("wait", "[data-testid=superagent-settings]")
    await browser("wait", "[data-testid=superagent-enabled] input:not(:disabled)")
  }
  async function confirmUninstall() {
    // Native dialogs animate and the confirmation expands their height. Wait
    // for the actual pointer target to settle before the browser's real click.
    await browser("scrollintoview", "[data-testid=superagent-uninstall-confirm]")
    await browser("wait", "--fn", "(()=>{const button=document.querySelector('[data-testid=superagent-uninstall-confirm]');if(!button||button.disabled)return false;const r=button.getBoundingClientRect();if(!button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)))return false;const key=[r.x,r.y,r.width,r.height].join(',');if(window.__uninstallLayout?.key!==key){window.__uninstallLayout={key,since:Date.now()};return false}return Date.now()-window.__uninstallLayout.since>200})()")
    await browser("eval", "(()=>{window.__uninstallClicks??=[];if(window.__uninstallTrace)return;window.__uninstallTrace=true;for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>window.__uninstallClicks.push({type,target:event.target?.getAttribute?.('data-testid'),slot:event.target?.getAttribute?.('data-slot'),tag:event.target?.tagName,dialog:!!document.querySelector('[data-testid=superagent-settings]')}),true)})()")
    await browser("click", "[data-testid=superagent-uninstall-confirm]")
  }
  await settings()
  assert.equal((await stateRead()).native.schedule.enabled, false)
  await browser("click", "[data-testid=superagent-enabled] [data-slot=switch-control]")
  await until(async () => !(await stateRead()).native.enabled, "disable readback")
  const countDisabled = calls.length
  await Bun.sleep(1200); assert.equal(calls.length, countDisabled)
  await browser("wait", "[data-testid=superagent-enabled] input:not(:disabled)")
  await browser("click", "[data-testid=superagent-enabled] [data-slot=switch-control]")
  await until(async () => (await stateRead()).native.enabled, "enable readback")
  await browser("wait", "[data-testid=superagent-schedule-minutes]:not(:disabled)")
  const interval = verifyCron ? 1 : 2
  await browser("fill", "[data-testid=superagent-schedule-minutes]", String(interval))
  await browser("click", "[data-testid=superagent-schedule-save]")
  await until(async () => (await stateRead()).native.schedule.minutes === interval, "schedule interval persisted")
  await browser("wait", "[data-testid=superagent-schedule-enabled] input:not(:disabled)")
  const history = async () => {
    const response = await fetch(`${apiUrl}/session/${master.session}/message?directory=${encodeURIComponent(master.directory)}`)
    assert.equal(response.status, 200)
    return await response.json() as { info: { id: string; role: string }; parts: { type: string; text?: string }[] }[]
  }
  const beforeCron = verifyCron ? await history() : []
  const cronStarted = Date.now()
  await browser("click", "[data-testid=superagent-schedule-enabled] [data-slot=switch-control]")
  await until(async () => (await stateRead()).native.schedule.enabled, "schedule enabled")
  if (verifyCron) {
    console.log(JSON.stringify({ stage: "cron-wait-first-real-minute", directory, cronStarted }))
    await until(async () => (await stateRead()).native.outbox.filter((item) => item.kind === "checkin" && item.state === "delivered").length === 1, "first real cron cycle", 100_000)
    const quietAt = Date.now(), afterQuiet = await history()
    assert.ok(quietAt - cronStarted >= 58_000, "Real interval must elapse without clock injection")
    assert.deepEqual(afterQuiet, beforeCron, "NO_UPDATE creates no user or assistant messages in master")
    assert.equal((await stateRead()).native.outbox.filter((item) => item.kind === "update").length, 0)
    assert.equal(calls.filter((call) => call.operation === "checker-status").length, 1)
    console.log(JSON.stringify({ stage: "cron-quiet-verified-wait-second-minute", directory, quietAt }))
    await until(async () => (await stateRead()).native.outbox.some((item) => item.kind === "update" && item.state === "delivered"), "second real cron finding delivered", 100_000)
    const findingAt = Date.now(), afterFinding = await history()
    assert.ok(findingAt - cronStarted >= 118_000, "Second real interval must elapse")
    assert.equal((await stateRead()).native.outbox.filter((item) => item.kind === "checkin" && item.state === "delivered").length, 2)
    assert.equal(calls.filter((call) => call.operation === "checker-status").length, 2)
    const added = afterFinding.slice(beforeCron.length)
    assert.equal(added.filter((message) => message.info.role === "user").length, 1)
    assert.equal(added.filter((message) => message.info.role === "assistant").length, 1)
    assert.ok(added.some((message) => message.info.role === "assistant" && message.parts.some((part) => part.type === "text" && part.text?.includes(cronFinding))))
    receipt.cron = { realClock: true, intervalMinutes: interval, cronStarted, quietAt, findingAt, quietMasterUnchanged: true, realStatusToolCalls: 2, findingDelivered: true }
    await writeFile(path.join(directory, "cron-history.json"), JSON.stringify({ beforeCron, afterQuiet, afterFinding }, null, 2))
    console.log(JSON.stringify({ stage: "cron-finding-verified", directory, findingAt }))
  }
  await browser("wait", "[data-testid=superagent-schedule-enabled] input:not(:disabled)")
  await browser("click", "[data-testid=superagent-schedule-enabled] [data-slot=switch-control]")
  await until(async () => !(await stateRead()).native.schedule.enabled, "schedule disabled")
  await browser("screenshot", path.join(directory, "native-settings.png"))
  console.log(JSON.stringify({ stage: "settings-verified", directory }))
  await browser("press", "Escape")
  await browser("click", "[data-testid=superagent-master]")
  await browser("wait", "[data-component=prompt-input]")
  if (verifyCron) {
    await browser("wait", "--text", "主控主动检查发现")
    await browser("screenshot", path.join(directory, "native-cron-finding.png"))
  }
  await send("NATIVE_V2_REQUEST FOLLOWUP HOLD_WORKER 暂时等待的只读检查。")
  await until(() => !!releaseWorker, "held real worker active")
  await settings()
  await browser("click", "[data-testid=superagent-uninstall]")
  await browser("wait", "[data-testid=superagent-uninstall-confirmation]")
  assert.equal((await stateRead()).native.installed, true, "First uninstall click must not remove anything")
  await confirmUninstall()
  await browser("wait", "--fn", "window.__nativeResponses.some(x => x.status === 409)")
  await browser("wait", "[data-testid=superagent-settings] [role=alert]")
  assert.equal((await stateRead()).native.installed, true)
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-enabled] input')?.checked === false")
  receipt.busyUninstallRefused = true
  releaseWorker!()
  await until(async () => (await stateRead()).inputs.every((input) => input.state === "done"), "disabled worker can finish and report")
  await browser("wait", "[data-testid=superagent-enabled] input:not(:disabled)")
  await browser("click", "[data-testid=superagent-enabled] [data-slot=switch-control]")
  await until(async () => (await stateRead()).native.outbox.filter((item) => item.kind === "answer" && item.state === "delivered").length === 3, "retained report delivered after reenable")
  const beforeRemove = await stateRead()
  const observations = await browser("eval", "JSON.stringify(window.__nativeResponses)")
  assert.ok(!observations.includes(fixtureToken), "Browser must not receive sidecar token")
  await writeFile(path.join(directory, "browser-api-observations.json"), observations)
  await browser("click", "[data-testid=superagent-uninstall]")
  await confirmUninstall()
  await until(async () => !(await stateRead()).native.installed, "uninstall finished")
  assert.equal((await stateRead()).tickets.length, beforeRemove.tickets.length)
  assert.equal(await readFile(externalFile, "utf8"), externalEvidence + "\n")
  assert.equal((await fetch(`${apiUrl}/session/${master.session}?directory=${encodeURIComponent(master.directory)}`)).status, 200)
  assert.equal((await fetch(`${apiUrl}/session/${first.session}?directory=${encodeURIComponent(first.directory)}`)).status, 200)
  receipt = { ...receipt, passed: true, master, ticket: first, beforeRemove, state: await stateRead(), modelCalls: calls,
    checks: ["real native UI sends ordinary message", "actual dispatch/read/report tool calls", "worker report wakes master and renders response", "followup same worker session", "management has no chat composer", "settings disable/enable and cron configuration", "busy uninstall refused and UI readback correct", "uninstall preserves sessions/research/files", "browser receives no sidecar credential", ...(verifyCron ? ["two actual one-minute cron cycles: real status tool, silent NO_UPDATE, finding returned to native master"] : [])] }
  console.log(JSON.stringify({ stage: "passed", directory, webUrl }))
  }
} catch (error) {
  receipt.error = String(error)
  receipt.modelCalls = calls
  receipt.browserResponses = await browser("eval", "window.__nativeResponses ?? []").catch(() => [])
  const failedState = await stateRead().catch(() => undefined)
  receipt.state = failedState
  for (const item of [...(failedState?.native.master ? [failedState.native.master] : []), ...(failedState?.tickets ?? [])]) {
    const history = await fetch(`${apiUrl}/session/${item.session}/message?directory=${encodeURIComponent(item.directory)}`).then((response) => response.json()).catch(() => undefined)
    if (history) await writeFile(path.join(directory, `history-${item.session}.json`), JSON.stringify(history, null, 2))
  }
  receipt.uninstallClicks = await browser("eval", "window.__uninstallClicks ?? []").catch(() => "unavailable")
  receipt.inputTrace = await browser("eval", "window.__nativeInputEvents ?? []").catch(() => "unavailable")
  receipt.failureUrl = await browser("get", "url").catch(() => "unavailable")
  console.error(String(error))
  await browser("screenshot", path.join(directory, "failure.png")).catch(() => undefined)
  await browser("snapshot").then((x) => writeFile(path.join(directory, "failure-snapshot.txt"), x)).catch(() => undefined)
  process.exitCode = 1
} finally {
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2))
  releaseMaster?.()
  releaseWorker?.()
  // Optional inspection applies only to this isolated fixture.
  if (receipt.passed && process.env.NATIVE_E2E_KEEP === "1") {
    console.log(JSON.stringify({ stage: "holding", stopFile: path.join(directory, "stop") }))
    await until(async () => { try { await access(path.join(directory, "stop")); return true } catch { return false } }, "operator inspection", 1_800_000).catch(() => undefined)
  }
  await browser("close").catch(() => undefined)
  for (const child of children.reverse()) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(3000)]) }
  model.stop(true)
}
