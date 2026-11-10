// Opt-in real browser acceptance: actual Aether backend, actual panel main and
// actual Aether Web/Vite, with a local deterministic model (no paid API).
import { mkdir, mkdtemp, writeFile, readFile, access, readdir, symlink } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import assert from "node:assert/strict"
import { git } from "../src/workspace"
import { install } from "../src/integration"

const source = path.resolve(process.argv[2] ?? "../Aether")
const parent = process.env.SUPERAGENT_TEST_ROOT ?? path.join(homedir(), "data/aether-superagent-tests")
await mkdir(parent, { recursive: true })
const directory = await mkdtemp(path.join(parent, "native-e2e-"))
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
let releaseClarification: (() => void) | undefined
const fixtureToken = "native-e2e-server-side-fixture-only"
await writeFile(path.join(state, "token"), fixtureToken, { mode: 0o600 })
const calls: { router: boolean; tools: string[]; at: number; operation?: string }[] = []
let routeCount = 0, workerTurn = 0
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as { stream?: boolean; tools?: { function: { name: string } }[]; messages?: { role: string; content: unknown }[] }
  const tools = (body.tools ?? []).map((x) => x.function.name), router = tools.includes("StructuredOutput")
  const messages = body.messages ?? []
  const lastUser = messages.findLastIndex((message) => message.role === "user")
  const flatten = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => part.text ?? "").join("\n") : ""
  const prompt = flatten(messages[lastUser]?.content)
  let delta: object, operation: string, finish: string
  if (router) {
    routeCount++
    const first = routeCount === 2 ? (await stateRead()).tickets[0] : undefined
    const userRequest = prompt.split("User request:").at(-1) ?? prompt
    if (userRequest.includes("需要澄清的未指定目录")) await new Promise<void>((resolve) => { releaseClarification = resolve })
    const audit = (await stateRead()).tickets.find((ticket) => ticket.title === "外部目录只读调研")
    const route = userRequest.includes("需要澄清的未指定目录") ? { action: "reply", ticket: "", title: "", text: "请提供希望检查的目录。CLARIFICATION_ONLY" }
      : userRequest.includes("触发本地模型错误") || userRequest.includes("外部调研追问") ? { action: "followup", ticket: audit!.id, title: "", text: "继续只读调研" }
      : userRequest.includes("外部目录只读调研") ? { action: "create", ticket: "", title: "外部目录只读调研", text: "读取真实文件才能回答" }
      : first ? { action: "followup", ticket: first.id, title: "", text: "继续既有边界计算研究" }
      : { action: "create", ticket: "", title: routeCount === 1 ? "边界计算研究" : "文献对照研究", text: "独立科研课题" }
    delta = { tool_calls: [{ index: 0, id: `route_${routeCount}`, type: "function", function: { name: "StructuredOutput", arguments: JSON.stringify(route) } }] }
    operation = route.action; finish = "tool_calls"
  } else if (prompt.includes("触发本地模型错误")) {
    calls.push({ router, tools, at: Date.now(), operation: "intentional-error" })
    return Response.json({ error: { message: "Deterministic local model failure", type: "invalid_request_error" } }, { status: 400 })
  } else if (prompt.includes("同工单后台更新")) {
    delta = { content: "BACKGROUND_UPDATE_MUST_NOT_REPLACE_REQUEST_ANSWER" }; operation = "background-update"; finish = "stop"
  } else if (prompt.includes("外部目录只读调研") || prompt.includes("外部调研追问")) {
    const outputs = messages.slice(lastUser + 1).filter((message) => message.role === "tool").map((message) => flatten(message.content)).join("\n")
    if (!outputs) {
      delta = { tool_calls: [{ index: 0, id: `read_${Date.now()}`, type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: externalFile }) } }] }
      operation = "read-external"; finish = "tool_calls"
    } else {
      assert.ok(outputs.includes(externalEvidence), "Answer must be grounded in actual read tool output")
      await Bun.sleep(6000)
      delta = { content: `${prompt.includes("外部调研追问") ? "FOLLOWUP_READ" : "FIRST_READ"}: ${externalEvidence}` }
      operation = "read-answer"; finish = "stop"
    }
  } else if (!messages.slice(lastUser + 1).some((message) => message.role === "tool")) {
    workerTurn++
    const line = prompt.split("\n").find((line) => line.startsWith("SUPERAGENT_PROGRESS: "))
    assert.ok(line, "Worker prompt must carry actual report path and revision")
    const context = JSON.parse(line.slice("SUPERAGENT_PROGRESS: ".length)) as { path: string; ticket: string; input: string; revision: number }
    const report = { ticket: context.ticket, input: context.input, revision: context.revision,
      objective: "独立验证科研工作台", stage: "computing", summary: `真实工具已写入科研进度 ${workerTurn}`,
      next: "核对剩余边界与证据", blockers: [], milestones: [{ id: "fixture-write", title: "真实工具写入进度", state: "done" }, { id: "boundary", title: "后续边界验证", state: "active" }], evidence: [{ label: "本地工具写入记录", path: path.basename(context.path) }] }
    delta = { tool_calls: [{ index: 0, id: `write_${workerTurn}`, type: "function", function: { name: "write", arguments: JSON.stringify({ filePath: context.path, content: JSON.stringify(report, null, 2) }) } }] }
    operation = "write-report"; finish = "tool_calls"
  } else {
    // Leave the real worker in-flight long enough to observe file polling in UI.
    await Bun.sleep(6000)
    delta = { content: "Fixture worker completed this turn. 科研进度已落盘。" }; operation = "finish"; finish = "stop"
  }
  calls.push({ router, tools, at: Date.now(), operation })
  if (!body.stream) return Response.json({ id: "fixture", object: "chat.completion", created: 1, model: "tiny",
    choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "tiny", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  return new Response(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })
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
    models: { tiny: { name: "Tiny", tool_call: true, limit: { context: 100_000, output: 2000 } } } } }, agent: { build: { steps: 2, permission: { external_read: { [path.join(externalResearch, "*")]: "allow" } } } } }
const children: ReturnType<typeof Bun.spawn>[] = []
function launch(name: string, command: string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd, env, stdout: Bun.file(path.join(directory, `${name}.log`)), stderr: Bun.file(path.join(directory, `${name}.log`)) })
  children.push(child); return child
}
const backend = launch("aether", [process.execPath, "run", "--conditions=browser", path.join(upstream, "packages/opencode/src/index.ts"), "serve", "--hostname", "127.0.0.1", "--port", String(apiPort)], path.join(upstream, "packages/opencode"), {
  ...isolated, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_BACKGROUND_SERVICES: "false",
  OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true", OPENCODE_CHANNEL: `native-e2e-${apiPort}`, AETHER_SUPERAGENT_CONFIG: bridge,
})
async function until(check: () => boolean | Promise<boolean>, description: string, timeout = 90_000) {
  const end = Date.now() + timeout
  while (!await check()) { if (Date.now() >= end) throw new Error(`Timed out: ${description}`); await Bun.sleep(300) }
}
async function available(url: string) { try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok } catch { return false } }
async function stateRead() { const response = await fetch(`${panelUrl}/panel/state`, { headers: { Authorization: `Bearer ${fixtureToken}` } }); assert.equal(response.status, 200); return await response.json() as { tickets: { id: string; title: string; session: string; directory: string; state: string; research: { summary: string; revision: number; stage: string; input: string } }[]; inputs: { id: string; key: string; mode: string; result: string; ticket: string | null; state: string }[] } }
const browserSession = "sa-native-independent"
const commands: { args: string[]; code: number; output: string; error: string }[] = []
async function browser(...args: string[]) {
  const child = Bun.spawn(["agent-browser", "--session", browserSession, ...args], { stdout: "pipe", stderr: "pipe" })
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  commands.push({ args, code, output, error })
  await writeFile(path.join(directory, "browser-commands.json"), JSON.stringify(commands, null, 2))
  if (code) throw new Error(`Browser ${args[0]} failed: ${error || output}`)
  return output
}
let receipt: Record<string, unknown> = { passed: false, directory, upstream, apiUrl, panelUrl, webUrl, model: "local deterministic fixture; no paid API", browserSession }
try {
  await until(async () => { if (backend.exitCode !== null) throw new Error(`Backend exited ${backend.exitCode}`); return available(`${apiUrl}/global/health`) }, "backend startup")
  const web = launch("web", [process.execPath, "run", "dev", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], path.join(upstream, "packages/app"), { ...isolated, VITE_OPENCODE_SERVER_HOST: "127.0.0.1", VITE_OPENCODE_SERVER_PORT: String(apiPort) })
  await until(async () => { if (web.exitCode !== null) throw new Error(`Real Aether Web exited ${web.exitCode}`); return available(webUrl) }, "real Aether Vite startup")
  const panelConfig = path.join(directory, "panel-config.json")
  await writeFile(panelConfig, JSON.stringify({ repo, state, base: "HEAD", workers: 2, aether: apiUrl, port: panelPort, model: { providerID: "fixture", modelID: "tiny" } }))
  launch("panel", [process.execPath, "run", path.resolve("src/main.ts"), panelConfig], process.cwd(), { ...isolated })
  await until(() => available(`${panelUrl}/health`), "panel main startup")
  const ready = { directory, apiUrl, panelUrl, webUrl, bridge, pids: children.map((x) => x.pid) }
  await writeFile(path.join(directory, "ready.json"), JSON.stringify(ready, null, 2))
  console.log(JSON.stringify({ stage: "ready", ...ready }))
  const rejected = []
  for (const suffix of ["/unknown", "/panel/state?directory=arbitrary", "/tickets/unknown/open?session=arbitrary"]) {
    const response = await fetch(`${apiUrl}/superagent${suffix}`)
    assert.equal(response.status, 400, `Bridge must reject ${suffix}`)
    rejected.push({ suffix, status: response.status })
  }
  receipt.bridgeRejected = rejected
  await browser("set", "viewport", "1440", "900")
  await browser("open", webUrl)
  await browser("eval", `window.__nativeResponses = []; const originalFetch = window.fetch; window.fetch = async (...args) => { const response = await originalFetch(...args); if (String(args[0]?.url ?? args[0]).includes('/superagent/')) { window.__nativeResponses.push({url:response.url,status:response.status,headers:[...response.headers],body:await response.clone().text()}); } return response; }`)
  await browser("wait", "[data-testid=superagent-entry]")
  await writeFile(path.join(directory, "native-before-snapshot.txt"), await browser("snapshot", "-i"))
  await browser("click", "[data-testid=superagent-entry]")
  await browser("wait", "[data-testid=superagent-panel]")
  assert.equal(calls.length, 0, "Opening native panel must not invoke model")
  assert.equal(new URL((await browser("get", "url")).trim()).pathname, "/superagent")
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-message]').disabled === false")
  await browser("fill", "[data-testid=superagent-message]", "请建立边界计算研究，写出里程碑与进度。")
  await browser("click", "[data-testid=superagent-send]")
  await browser("wait", "--text", "真实工具已写入科研进度 1")
  const during = await stateRead()
  assert.equal(during.tickets.length, 1)
  assert.equal(during.tickets[0]?.state, "running", "Card must update while worker is still active")
  receipt.liveProgress = during.tickets[0]
  await browser("click", "[data-testid=superagent-ticket]")
  await browser("wait", "[data-testid=superagent-milestones]")
  await browser("wait", "--text", "后续边界验证")
  await browser("screenshot", path.join(directory, "research-live-progress.png"))
  await until(async () => { const state = await stateRead(); return state.tickets[0]?.state === "waiting" && state.inputs.every((input) => input.state === "done") }, "first research turn complete")
  const first = (await stateRead()).tickets[0]!
  const firstReport = path.join(first.directory, `.aether-superagent-progress-${first.research.input}.json`)
  assert.equal(JSON.parse(await readFile(firstReport, "utf8")).summary, "真实工具已写入科研进度 1")
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-message]').disabled === false")
  await browser("fill", "[data-testid=superagent-message]", "继续这个边界研究，补充后续检查。")
  await browser("click", "[data-testid=superagent-send]")
  await browser("wait", "--text", "真实工具已写入科研进度 2")
  await until(async () => { const state = await stateRead(); return state.inputs.filter((input) => input.ticket === first.id).length === 2 && state.inputs.every((input) => input.state === "done") }, "router followup completes")
  const same = await stateRead()
  assert.equal(same.tickets.length, 1); assert.equal(same.tickets[0]!.session, first.session)
  assert.ok(same.tickets[0]!.research.revision > first.research.revision)
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-message]').disabled === false")
  await browser("fill", "[data-testid=superagent-message]", "现在开始完全无关的文献对照研究。")
  await browser("click", "[data-testid=superagent-send]")
  await browser("wait", "--text", "真实工具已写入科研进度 3")
  await until(async () => { const state = await stateRead(); return state.tickets.length === 2 && state.inputs.every((input) => input.state === "done") }, "unrelated request creates separate research")
  const after = await stateRead()
  assert.notEqual(after.tickets[1]!.session, first.session)
  assert.equal(routeCount, 3, "All user requests must pass through router")
  assert.deepEqual(calls.filter((call) => call.router).map((call) => call.operation), ["create", "followup", "create"])
  assert.equal(after.tickets.every((ticket) => ticket.research.stage !== "review"), true)
  const exposure = await browser("eval", "JSON.stringify({responses:window.__nativeResponses,local:{...localStorage},session:{...sessionStorage},html:document.documentElement.outerHTML,cookie:document.cookie})")
  assert.equal(exposure.includes(fixtureToken), false, "Browser must never receive sidecar token")
  assert.equal(exposure.includes(path.join(state, "token")), false, "Bridge must strip server token path")
  await writeFile(path.join(directory, "browser-credential-check.json"), JSON.stringify({ passed: true, tokenFound: false, tokenPathFound: false }))
  await browser("screenshot", path.join(directory, "native-panel-desktop.png"))
  await writeFile(path.join(directory, "native-panel-snapshot.txt"), await browser("snapshot"))
  await browser("set", "viewport", "390", "844")
  await browser("screenshot", path.join(directory, "native-panel-mobile.png"))
  receipt.mobileOverflow = (await browser("eval", "document.documentElement.scrollWidth > window.innerWidth")).trim()
  await browser("set", "viewport", "1440", "900")
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-ticket][aria-pressed=true]').textContent.includes('边界计算研究')")
  await browser("click", "[data-testid=superagent-open]")
  await browser("wait", "--fn", `location.origin === ${JSON.stringify(webUrl)} && location.pathname.includes(${JSON.stringify(first.session)})`)
  const actualUrl = (await browser("get", "url")).trim()
  const expectedUrl = `${webUrl}/${Buffer.from(first.directory).toString("base64url")}/session/${first.session}`
  assert.equal(actualUrl, expectedUrl)
  receipt.openUrl = actualUrl
  await browser("wait", "--text", "Fixture worker completed this turn.")
  await writeFile(path.join(directory, "aether-snapshot.txt"), await browser("snapshot"))
  await browser("screenshot", path.join(directory, "native-aether-session.png"))
  const history = await fetch(`${apiUrl}/session/${first.session}/message?directory=${encodeURIComponent(first.directory)}`).then((x) => x.json()) as { info: { role: string }; parts: { type: string; tool?: string; state?: { status?: string } }[] }[]
  assert.equal(history.filter((x) => x.info.role === "user").length, 2)
  assert.ok(calls.filter((x) => x.router).every((x) => x.tools.length === 1))
  assert.equal(history.flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.tool === "write" && part.state?.status === "completed").length, 2)
  const modelCallsBeforeReload = calls.length
  await browser("click", "[data-testid=superagent-entry]")
  await browser("wait", "[data-testid=superagent-panel]")
  assert.equal(new URL((await browser("get", "url")).trim()).pathname, "/superagent")
  await browser("reload")
  await browser("wait", "[data-testid=superagent-panel]")
  await browser("wait", "--text", "真实工具已写入科研进度 2")
  // Allow the persisted project list and Layout's autoselect effect to settle.
  await Bun.sleep(2500)
  assert.equal(new URL((await browser("get", "url")).trim()).pathname, "/superagent", "Existing project must not redirect a refreshed workbench")
  await browser("wait", "[data-testid=superagent-panel]")
  assert.equal(calls.length, modelCallsBeforeReload, "Return and reload must not trigger model work")
  receipt.reloadWithExistingProject = true
  await browser("click", ".research-grid > article:nth-child(2) [data-testid=superagent-ticket]")
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-ticket][aria-pressed=true]').textContent.includes('边界计算研究')")
  await browser("wait", "[data-testid=superagent-milestones]")
  await browser("screenshot", path.join(directory, "research-final-desktop.png"))
  async function submitFromPage(text: string) {
    await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-message]').disabled === false")
    await browser("fill", "[data-testid=superagent-message]", text)
    await browser("click", "[data-testid=superagent-send]")
  }
  async function answerText() { return await browser("get", "text", "[data-testid=superagent-answer]") }
  await submitFromPage(`外部目录只读调研：请读取 ${externalFile}，回答计算进展；不得修改文件。`)
  await browser("wait", "[data-testid=superagent-answer][data-state=dispatching]")
  assert.equal((await answerText()).includes(externalEvidence), false)
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-answer][data-state=done]')?.textContent.includes('FIRST_READ')")
  assert.ok((await answerText()).includes(externalEvidence))
  assert.equal(await readFile(externalFile, "utf8"), externalEvidence + "\n")
  const audited = await stateRead()
  const audit = audited.tickets.find((ticket) => ticket.title === "外部目录只读调研")!
  const auditRoute = audited.inputs.filter((input) => input.mode === "route").at(-1)!
  const auditChild = JSON.parse(auditRoute.result).input
  const sideResponse = await fetch(`${panelUrl}/tickets/${audit.id}/messages`, { method: "POST", headers: { Authorization: `Bearer ${fixtureToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ key: "background-answer", text: "同工单后台更新，与当前用户请求无关。" }) })
  assert.equal(sideResponse.status, 202)
  await until(async () => (await stateRead()).inputs.some((input) => input.key === "user:background-answer" && input.state === "done"), "same ticket background update")
  await Bun.sleep(1800)
  const stillOriginal = await answerText()
  assert.ok(stillOriginal.includes("FIRST_READ")); assert.equal(stillOriginal.includes("BACKGROUND_UPDATE"), false)
  assert.equal((await stateRead()).inputs.find((input) => input.id === auditChild)?.result.includes("FIRST_READ"), true)
  await submitFromPage("外部调研追问：重新读取同一文件，报告当前进展。")
  await browser("wait", "[data-testid=superagent-answer][data-state=dispatching]")
  assert.equal((await answerText()).includes("FIRST_READ"), false)
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-answer][data-state=done]')?.textContent.includes('FOLLOWUP_READ')")
  assert.equal((await stateRead()).tickets.find((ticket) => ticket.id === audit.id)?.session, audit.session)
  await browser("screenshot", path.join(directory, "read-only-request-answer.png"))
  const auditHistory = await fetch(`${apiUrl}/session/${audit.session}/message?directory=${encodeURIComponent(audit.directory)}`).then((response) => response.json()) as { parts: { type: string; tool?: string; state?: { status?: string } }[] }[]
  assert.equal(auditHistory.flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.tool === "read" && part.state?.status === "completed").length, 2)
  const beforeClarification = (await stateRead()).tickets.length
  const workerCallsBeforeClarification = calls.filter((call) => !call.router).length
  await submitFromPage("需要澄清的未指定目录，请先问我目录。")
  await until(() => !!releaseClarification, "router clarification gate")
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-answer]') === null")
  releaseClarification!()
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-answer][data-state=done]')?.textContent.includes('CLARIFICATION_ONLY')")
  assert.equal((await stateRead()).tickets.length, beforeClarification)
  assert.equal(calls.filter((call) => !call.router).length, workerCallsBeforeClarification, "Clarification must not dispatch a worker")
  await submitFromPage("触发本地模型错误，核对错误状态而非沿用上次答案。")
  await browser("wait", "[data-testid=superagent-answer][data-state=uncertain]")
  const failedAnswer = await answerText()
  assert.equal(failedAnswer.includes("FOLLOWUP_READ"), false); assert.equal(failedAnswer.includes("FIRST_READ"), false)
  await browser("screenshot", path.join(directory, "request-error-state.png"))
  receipt.readOnlyHistory = auditHistory
  receipt.requestAnswerChecks = { readToolExecutions: 2, externalFileUnchanged: true, specificChild: auditChild, unrelatedSameTicketAnswerIgnored: true, sameSessionFollowup: true, waitingHasNoOldAnswer: true, routingHidesOldAnswer: true, clarificationWithoutWorker: true, errorHasNoOldAnswer: true }
  receipt = { ...receipt, passed: true, head: await git(upstream, "rev-parse", "HEAD"), ticket: first, state: await stateRead(), history, modelCalls: calls,
    checks: ["real backend", "source-installed native research page", "real Aether Vite Web", "native entry opens without model or token prompt", "native submit creates one task", "router followup keeps same session", "unrelated request creates second session", "real write tool progress visible while running", "native navigation to existing Aether session", "existing-project workbench return and reload", "desktop/mobile screenshots"] }
  console.log(JSON.stringify({ stage: "passed", directory, panelUrl, webUrl, ticket: first.id }))
} catch (error) {
  receipt.error = String(error)
  receipt.inputTrace = await browser("eval", "window.__nativeInputEvents ?? []").catch(() => "unavailable")
  receipt.failureUrl = await browser("get", "url").catch(() => "unavailable")
  console.error(String(error))
  await browser("screenshot", path.join(directory, "failure.png")).catch(() => undefined)
  await browser("snapshot").then((x) => writeFile(path.join(directory, "failure-snapshot.txt"), x)).catch(() => undefined)
  process.exitCode = 1
} finally {
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2))
  // Keep a successful fixture available for a short independent visual check.
  if (receipt.passed && process.env.NATIVE_E2E_KEEP === "1") {
    console.log(JSON.stringify({ stage: "holding", stopFile: path.join(directory, "stop") }))
    await until(async () => { try { await access(path.join(directory, "stop")); return true } catch { return false } }, "operator inspection", 1_800_000).catch(() => undefined)
  }
  await browser("close").catch(() => undefined)
  for (const child of children.reverse()) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(3000)]) }
  model.stop(true)
}
