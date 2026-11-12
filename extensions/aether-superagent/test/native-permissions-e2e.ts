// Opt-in real browser acceptance: actual Aether backend, actual panel main and
// actual Aether Web/Vite, with a local deterministic model (no paid API).
import { mkdir, mkdtemp, writeFile, readFile, access, readdir, symlink } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import assert from "node:assert/strict"
import { git } from "../src/workspace"
import { install } from "../src/integration"

let primaryTicket = ""
const cronFinding = "CRON_FINDING: 下一步应核对剩余 6 个族的检查记录，等待用户确定范围。"
const source = path.resolve(process.argv[2] ?? "../Aether")
const parent = process.env.SUPERAGENT_TEST_ROOT ?? path.join(homedir(), "data/aether-superagent-tests")
await mkdir(parent, { recursive: true })
const directory = await mkdtemp(path.join(parent, "native-permissions-e2e-"))
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
const externalSecond = path.join(directory, "external-second")
await mkdir(externalSecond)
const externalFile2 = path.join(externalSecond, "STATUS2.txt")
await writeFile(externalFile2, externalEvidence + "\n")
let releaseSecondRead: (() => void) | undefined
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
  let delta: object, operation: string, finish = "stop"
  const tool = (name: string, args: object) => {
    assert.ok(tools.includes(name), `Required actual tool missing: ${name}`)
    finish = "tool_calls"
    return { tool_calls: [{ index: 0, id: `call_${crypto.randomUUID().replaceAll("-", "")}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
  }
  try {
    const line = prompt.split("\n").find((line) => line.startsWith("SUPERAGENT_RUN: "))
    if (line) {
      const run = JSON.parse(line.slice("SUPERAGENT_RUN: ".length)) as { ticket: string; run: string; revision: number }
      if (results.length === 0) {
        if (prompt.includes("HOLD_WORKER")) await new Promise<void>((resolve) => { releaseWorker = resolve })
        operation = "worker-progress"
        delta = tool("superagent_report", { ...run, kind: "progress", summary: "正在读取本地科研记录", research: { stage: "research", summary: "正在读取本地科研记录", milestones: [{ id: "read", title: "核对真实记录", state: "active" }], blockers: [] } })
      } else if (results.length === 1) {
        assert.ok(!flatten(results[0]?.content).includes("Error"), flatten(results[0]?.content))
        operation = "worker-read"; delta = tool("read", { filePath: externalFile })
      } else if (results.length === 2 && prompt.includes("TRUST_ACTIVE")) {
        assert.ok(flatten(results[1]?.content).includes(externalEvidence))
        await new Promise<void>((resolve) => { releaseSecondRead = resolve })
        operation = "worker-second-read"; delta = tool("read", { filePath: externalFile2 })
      } else if (results.length === 2 || (results.length === 3 && prompt.includes("TRUST_ACTIVE"))) {
        if (prompt.includes("TRUST_ACTIVE")) assert.ok(flatten(results[2]?.content).includes(externalEvidence), "Second read in same already-running turn was authorized")
        if (prompt.includes("REJECT_READ") && !flatten(results[1]?.content).includes(externalEvidence)) {
          operation = "worker-rejected"; delta = { content: "用户拒绝读取，未继续访问。" }
          calls.push({ tools, at: Date.now(), operation, prompt })
          const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "tiny", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
          return new Response(chunk(delta, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })
        }
        assert.ok(flatten(results[1]?.content).includes(externalEvidence), "Actual read tool must return fixture evidence")
        operation = "worker-answer"
        delta = tool("superagent_report", { ...run, revision: run.revision + 1, kind: "answer", summary: externalEvidence, answer: `原生科研答复：${externalEvidence}`, research: { stage: "review", summary: "已核对真实文件：23 个族中已检查 17 个", next: "等待用户确认后续范围", blockers: [], milestones: [{ id: "read", title: "核对真实记录", state: "done" }], evidence: [{ label: "原始记录", path: externalFile }] } })
      } else {
        operation = "worker-final"; delta = { content: `执行完成：${externalEvidence}` }
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
      operation = "master-report-reply"; delta = { content: `主控已收到实际科研结果：${externalEvidence}。剩余 6 个族尚未检查。` }
    } else if (prompt.includes("NATIVE_V2_REQUEST")) {
      if (results.length === 0) {
        const prior = prompt.includes("FOLLOWUP") ? (await stateRead()).tickets.find((ticket) => ticket.id === primaryTicket) : undefined
        operation = prior ? "master-followup" : "master-dispatch"
        delta = tool("superagent_dispatch", { text: `${prompt} 只读 ${externalFile} 并报告证据。`, title: prompt.includes("SECOND_TASK") ? "第二独立任务" : "原生科研检查", ...(prior ? { ticket: prior.id } : {}) })
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
// Freeze only isolated fixture addon assets when reproducing the pre-fix UI.
const uiBaseline = process.env.NATIVE_E2E_UI_BASELINE
if (uiBaseline) for (const name of ["entry.tsx", "permissions.tsx"]) {
  const content = await git(process.cwd(), "show", `${uiBaseline}:integration/app/${name}`)
  await writeFile(path.join(upstream, "packages/app/src/addons/superagent", name), content + "\n")
}

const isolated = {
  PATH: process.env.PATH, LANG: "C.UTF-8", HOME: process.env.HOME,
  XDG_DATA_HOME: path.join(directory, "data"), XDG_CONFIG_HOME: path.join(directory, "config"), XDG_CACHE_HOME: path.join(directory, "cache"),
  XDG_STATE_HOME: path.join(directory, "xdg-state"), OPENCODE_TEST_HOME: path.join(directory, "home"), OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"), TMPDIR: directory,
}
const config = { enabled_providers: ["fixture"], model: "fixture/tiny", small_model: "fixture/tiny",
  provider: { fixture: { name: "Local fixture", npm: "@ai-sdk/openai-compatible", env: [], options: { apiKey: "fixture-only", baseURL: `${model.url.origin}/v1` },
    models: { tiny: { name: "Tiny", tool_call: true, limit: { context: 100_000, output: 2000 } } } } }, agent: { "superagent-worker": { steps: 10, permission: { external_read: { [path.join(externalResearch, "*")]: "ask" } } } } }
const children: ReturnType<typeof Bun.spawn>[] = []
function launch(name: string, command: string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd, env, stdout: Bun.file(path.join(directory, `${name}.log`)), stderr: Bun.file(path.join(directory, `${name}.log`)) })
  children.push(child); return child
}
const backend = launch("aether", [process.execPath, "run", "--conditions=browser", path.join(upstream, "packages/opencode/src/index.ts"), "serve", "--hostname", "127.0.0.1", "--port", String(apiPort)], path.join(upstream, "packages/opencode"), {
  ...isolated, OPENCODE_CONFIG_DIR: path.dirname(bridge), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_BACKGROUND_SERVICES: "false",
  OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true", OPENCODE_CHANNEL: `native-permissions-e2e-${apiPort}`, AETHER_SUPERAGENT_CONFIG: bridge,
})
async function until(check: () => boolean | Promise<boolean>, description: string, timeout = 90_000) {
  const end = Date.now() + timeout
  while (!await check()) { if (Date.now() >= end) throw new Error(`Timed out: ${description}`); await Bun.sleep(300) }
}
async function available(url: string) { try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok } catch { return false } }
async function stateRead() { const response = await fetch(`${panelUrl}/panel/state`, { headers: { Authorization: `Bearer ${fixtureToken}` } }); assert.equal(response.status, 200); return await response.json() as { native: { enabled: boolean; installed: boolean; master?: { session: string; directory: string }; schedule: { enabled: boolean; minutes: number }; reports: { kind: string; run: string }[]; outbox: { kind: string; state: string }[] }; tickets: { id: string; title: string; session: string; directory: string; state: string; research: { summary: string; revision: number; stage: string; input: string } }[]; inputs: { id: string; key: string; mode: string; result: string; ticket: string | null; state: string }[] } }
const browserSession = "sa-native-permissions-independent"
const commands: { args: string[]; code: number; output: string; error: string }[] = []
async function browser(...args: string[]) {
  const child = Bun.spawn(["agent-browser", "--session", browserSession, ...args], { stdout: "pipe", stderr: "pipe" })
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  commands.push({ args, code, output, error })
  await writeFile(path.join(directory, "browser-commands.json"), JSON.stringify(commands, null, 2))
  if (code) throw new Error(`Browser ${args[0]} failed: ${error || output}`)
  return output
}
let receipt: Record<string, unknown> = { passed: false, uiBaseline: uiBaseline ?? "current source", directory, upstream, apiUrl, panelUrl, webUrl, model: "local deterministic fixture; no paid API", browserSession }
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
    // This fixture targets permission behavior; explicitly choose the native
    // role if first-load preferences have not selected it yet.
    if (!(await browser("get", "text", "[data-action=prompt-agent]")).trim().toLowerCase().includes("superagent")) {
      await browser("click", "[data-action=prompt-agent]")
      await browser("wait", "--fn", "Array.from(document.querySelectorAll('[role=option]')).some(option => option.textContent.trim().toLowerCase()==='superagent')")
      await browser("eval", "Array.from(document.querySelectorAll('[role=option]')).find(option => option.textContent.trim().toLowerCase()==='superagent').click()")
    }
    await browser("fill", "[data-component=prompt-input]", text)
    await browser("press", "Enter")
  }
  await writeFile(path.join(directory, "master-before.txt"), await browser("snapshot", "-i"))

  type Item = { ticket: string; session: string; trusted: boolean; available: boolean; trustable: boolean; requests: { id: string; permission: string; patterns: string[] }[] }
  async function native<T>(route: string, body = {}): Promise<T> {
    const response = await fetch(`${panelUrl}/requests`, { method: "POST", headers: { Authorization: `Bearer ${fixtureToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ native: { path: route, body } }) })
    assert.equal(response.status, 200, await response.clone().text())
    return await response.json() as T
  }
  const permissions = async () => (await native<{ tickets: Item[] }>("/native/permissions")).tickets
  const task = (id: string) => `[data-testid=superagent-permission-task][data-ticket="${id}"]`
  async function closePermissions(button = false) {
    if ((await browser("get", "count", "[data-testid=superagent-permissions]")).trim() === "0") return
    if (button) await browser("click", "[data-slot=dialog-close-button]")
    else await browser("press", "Escape")
    await browser("wait", "--fn", "!document.querySelector('[data-testid=superagent-permissions]')")
    await browser("wait", "--fn", "document.activeElement?.getAttribute('data-testid') === 'superagent-permissions-trigger'")
  }
  async function openPermissions() {
    // Native Aether permission toasts can overlap the toolbar button. Dismiss
    // those notifications through their real controls before targeting it.
    while ((await browser("eval", "Array.from(document.querySelectorAll('[role=status] button')).some(button => button.textContent.trim()==='Dismiss')")).trim() === "true") {
      await browser("eval", "Array.from(document.querySelectorAll('[role=status] button')).find(button => button.textContent.trim()==='Dismiss')?.click()")
      await Bun.sleep(150)
    }
    await browser("wait", "--fn", "(()=>{const button=document.querySelector('[data-testid=superagent-permissions-trigger]');if(!button)return false;const rect=button.getBoundingClientRect();return button.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2))})()")
    await browser("click", "[data-testid=superagent-permissions-trigger]")
    await browser("wait", "[data-testid=superagent-permissions]")
    await browser("wait", "[role=dialog]")
    await browser("wait", "[data-component=dialog-overlay]")
    await browser("press", "Tab")
    assert.equal((await browser("eval", "document.querySelector('[role=dialog]')?.contains(document.activeElement)")).trim(), "true", "Native modal keeps keyboard focus inside")
  }
  async function workbench() {
    await browser("click", "[data-testid=superagent-entry]")
    await browser("wait", "[data-testid=superagent-permissions-trigger]")
    assert.equal((await browser("get", "count", "[data-testid=superagent-permissions]")).trim(), "0", "Polling never opens dialog")
    await openPermissions()
  }
  // Observe every inserted/changed native permission toast, including those
  // dismissed before the next browser command. Removed subtrees are inspected
  // as well, so a transient asked -> replied flash is not mistaken for success.
  async function watchPermissionToasts() {
    await browser("eval", `(()=>{window.__permissionToastObserver?.disconnect();window.__permissionToasts=[];const seen=new WeakSet();const record=node=>{if(!(node instanceof Element))return;const items=[...(node.matches('[data-component=toast]')?[node]:[]),...node.querySelectorAll('[data-component=toast]')];const parent=node.closest('[data-component=toast]');if(parent)items.push(parent);for(const item of items){if(seen.has(item)||!item.querySelector('[data-slot=toast-title]')?.textContent.includes('Permission required'))continue;seen.add(item);window.__permissionToasts.push({at:Date.now(),text:item.textContent});}};window.__permissionToastObserver=new MutationObserver(records=>{for(const change of records){record(change.target.nodeType===3?change.target.parentElement:change.target);for(const node of [...change.addedNodes,...change.removedNodes])record(node);}});window.__permissionToastObserver.observe(document.body,{subtree:true,childList:true,characterData:true});})()`)
  }
  async function toastEvidence(label: string) {
    const events = JSON.parse(await browser("eval", "JSON.stringify(window.__permissionToasts ?? [])"))
    // agent-browser prints JSON string results with quotes; normalize its value.
    const value = typeof events === "string" ? JSON.parse(events) : events
    receipt[label] = value
    await writeFile(path.join(directory, "toast-evidence.json"), JSON.stringify(receipt, null, 2))
    return value as { at: number; text: string }[]
  }
  async function masterSend(message: string) {
    await closePermissions()
    await browser("wait", "[data-testid=superagent-master]:not(:disabled)")
    await browser("click", "[data-testid=superagent-master]")
    await send(message)
  }
  const delivered = async () => (await stateRead()).native.outbox.filter((item) => item.kind === "answer" && item.state === "delivered").length
  await send("NATIVE_V2_REQUEST 请只读检查科研记录并说明进展。")
  await until(async () => (await permissions()).some((item) => item.requests.length > 0), "first actual read awaits permission")
  const first = (await permissions()).find((item) => item.requests.length > 0)!
  primaryTicket = first.ticket
  assert.equal(first.trusted, false)
  assert.equal(first.requests[0]!.permission, "external_read")
  await workbench()
  await browser("wait", `${task(first.ticket)} [data-testid=superagent-permission-once]`)
  assert.ok((await browser("get", "text", task(first.ticket))).includes(externalResearch))
  await browser("screenshot", path.join(directory, "permissions-pending.png"))
  await closePermissions(true)
  await Bun.sleep(1800)
  assert.equal((await browser("get", "count", "[data-testid=superagent-permissions]")).trim(), "0", "Pending permissions do not reopen closed modal")
  await browser("screenshot", path.join(directory, "permissions-compact.png"))
  await browser("eval", `window.__permissionWrites=[]; const permissionFetch=window.fetch; window.fetch=async(...args)=>{let body;try{body=JSON.parse(args[1]?.body ?? '{}')}catch{};const op=body?.native?.path;if(op==='/native/permissions' && window.__failPermissionReads)return new Response(JSON.stringify({error:'Fixture permissions read failure'}),{status:503,headers:{'Content-Type':'application/json'}});if(op==='/native/trust'){window.__permissionWrites.push(body.native.body);if(window.__rejectNextTrust){window.__rejectNextTrust=false;return new Response(JSON.stringify({error:'Fixture trust conflict'}),{status:409,headers:{'Content-Type':'application/json'}})}};return permissionFetch(...args)}`)
  await browser("eval", "window.__failPermissionReads=true")
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-permissions-trigger]')?.textContent.includes('状态未知')")
  await openPermissions()
  await browser("wait", "--text", "Fixture permissions read failure")
  await browser("eval", "window.__failPermissionReads=false")
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-permissions-trigger]')?.getAttribute('data-unknown') === 'false'")
  await browser("click", `${task(first.ticket)} [data-testid=superagent-permission-once]`)
  await until(async () => await delivered() === 1, "single allow lets actual read finish")
  assert.equal((await permissions()).find((item) => item.ticket === first.ticket)!.trusted, false)
  await watchPermissionToasts()
  await masterSend("NATIVE_V2_REQUEST SECOND_TASK REJECT_READ 独立任务，请检查同一文件。")
  await until(async () => (await permissions()).some((item) => item.ticket !== first.ticket && item.requests.length > 0), "second independent task asks separately")
  const second = (await permissions()).find((item) => item.ticket !== first.ticket && item.requests.length > 0)!
  await browser("wait", "--fn", "window.__permissionToasts.length > 0")
  assert.ok((await toastEvidence("untrustedToasts")).length > 0, "Untrusted independent task still produces a native permission toast")
  await workbench()
  await masterSend("NATIVE_V2_REQUEST FOLLOWUP TRUST_ACTIVE 已在运行的课题需读取两个独立目录。")
  await until(async () => !!(await permissions()).find((item) => item.ticket === first.ticket)!.requests.length, "first task active read pending before trust")
  await workbench()
  await browser("wait", `${task(first.ticket)} [data-testid=superagent-trust]:not(:disabled)`)
  await browser("click", `${task(first.ticket)} [data-testid=superagent-trust]`)
  await browser("wait", `${task(first.ticket)} [data-testid=superagent-trust-confirmation]`)
  assert.equal((await permissions()).find((item) => item.ticket === first.ticket)!.trusted, false, "First trust click never grants permissions")
  await browser("focus", `${task(first.ticket)} [data-testid=superagent-trust-confirm]`)
  await browser("eval", "window.__permissionFocus=document.activeElement;window.__permissionDialog=document.querySelector('[role=dialog]')")
  await Bun.sleep(1800)
  assert.equal((await browser("eval", "window.__permissionFocus===document.activeElement && window.__permissionDialog===document.querySelector('[role=dialog]')")).trim(), "true", "Poll preserves modal and confirmation focus")
  await browser("screenshot", path.join(directory, "permissions-confirm.png"))
  await browser("eval", "window.__rejectNextTrust=true")
  await browser("click", `${task(first.ticket)} [data-testid=superagent-trust-confirm]`)
  await browser("wait", "--text", "Fixture trust conflict")
  await browser("wait", "--fn", "document.activeElement?.getAttribute('data-slot') === 'dialog-close-button'")
  await closePermissions()
  await openPermissions()
  await browser("wait", "--text", "Fixture trust conflict")
  await Bun.sleep(1800)
  await browser("wait", "--text", "Fixture trust conflict")
  await browser("click", `${task(first.ticket)} [data-testid=superagent-trust]`)
  await browser("wait", `${task(first.ticket)} [data-testid=superagent-trust-confirm]`)
  const writesBefore = Number((await browser("eval", "window.__permissionWrites.length")).trim())
  await browser("eval", "const button=document.querySelector('[data-testid=superagent-trust-confirm]');button.click();button.click()")
  await until(async () => (await permissions()).find((item) => item.ticket === first.ticket)!.trusted, "task trust readback")
  assert.equal((await permissions()).find((item) => item.ticket === second.ticket)!.trusted, false)
  assert.ok((await permissions()).find((item) => item.ticket === second.ticket)!.requests.length > 0)
  assert.equal(Number((await browser("eval", "window.__permissionWrites.length")).trim()), writesBefore + 1, "Repeated click makes exactly one mutation")
  await until(() => !!releaseSecondRead, "worker reaches second read after trust")
  await closePermissions()
  await browser("reload")
  await browser("wait", "[data-testid=superagent-permissions-trigger]")
  await watchPermissionToasts()
  await browser("wait", "--fn", "document.querySelector('[data-testid=superagent-permissions-trigger]')?.getAttribute('data-unknown') === 'false'")
  await openPermissions()
  await browser("wait", `${task(first.ticket)}[data-trusted=true]`)
  await closePermissions()
  console.log(JSON.stringify({ stage: "cold-reload-ready", directory }))
  releaseSecondRead!()
  await until(async () => await delivered() === 2, "grant releases current pending and second read with dialog closed")
  assert.equal((await browser("get", "count", "[data-testid=superagent-permissions]")).trim(), "0", "Trusted sweep continues with modal closed")
  assert.ok(calls.some((call) => call.operation === "worker-second-read"))
  assert.deepEqual(await toastEvidence("trustedColdReloadToasts"), [], "Trusted same-run read must never flash a native permission toast after cold reload")
  await masterSend("NATIVE_V2_REQUEST FOLLOWUP 继续同一课题，确认受信任会话无需再次审批。")
  await until(async () => await delivered() === 3, "trusted next turn read completes without approval")
  assert.equal((await stateRead()).tickets.find((item) => item.id === first.ticket)!.session, first.session)
  assert.ok((await permissions()).find((item) => item.ticket === second.ticket)!.requests.length > 0, "Other task remains blocked after first task trust")
  await workbench()
  await browser("wait", `${task(second.ticket)} [data-testid=superagent-permission-reject]`)
  await browser("click", `${task(second.ticket)} [data-testid=superagent-permission-reject]`)
  await until(() => calls.some((call) => call.operation === "worker-rejected"), "real read receives rejection")
  await until(async () => !(await permissions()).find((item) => item.ticket === second.ticket)!.requests.length, "rejected request removed")
  await masterSend("NATIVE_V2_REQUEST FOLLOWUP HOLD_WORKER 正在执行的回合，撤销信任应中断。")
  await until(() => !!releaseWorker, "active trusted worker model request held")
  await workbench()
  await native("/native/settings", { enabled: false })
  await until(async () => !(await stateRead()).native.enabled, "coordinator disabled")
  await browser("wait", `${task(first.ticket)} [data-testid=superagent-revoke-trust]:not(:disabled)`)
  await browser("click", `${task(first.ticket)} [data-testid=superagent-revoke-trust]`)
  await browser("wait", `${task(first.ticket)} [data-testid=superagent-trust-confirmation]`)
  assert.equal((await permissions()).find((item) => item.ticket === first.ticket)!.trusted, true, "Revoke first click also needs confirmation")
  await browser("click", `${task(first.ticket)} [data-testid=superagent-trust-confirm]`)
  await until(async () => !(await permissions()).find((item) => item.ticket === first.ticket)!.trusted, "revoke succeeds while disabled")
  const firstTicket = (await stateRead()).tickets.find((item) => item.id === first.ticket)!
  const statuses = await fetch(`${apiUrl}/session/status?directory=${encodeURIComponent(firstTicket.directory)}`).then((response) => response.json()) as Record<string, { type: string }>
  assert.ok(!statuses[first.session] || statuses[first.session]!.type === "idle", "Active worker actually aborted before revoke acknowledgement")
  releaseWorker!()
  await until(async () => (await stateRead()).inputs.filter((input) => input.ticket === first.ticket).every((input) => ["done", "uncertain"].includes(input.state)), "aborted turn settles without claiming completion")
  const interrupted = (await stateRead()).inputs.find((input) => input.ticket === first.ticket && input.state === "uncertain")
  if (interrupted) {
    // Explicitly abandon the confirmed-idle interrupted turn, without replay or
    // mislabelling cancellation as a successful worker result.
    const dismissed = await fetch(`${panelUrl}/inputs/${interrupted.id}/dismiss`, { method: "POST", headers: { Authorization: `Bearer ${fixtureToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) })
    assert.equal(dismissed.status, 200, await dismissed.clone().text())
    assert.equal((await stateRead()).inputs.find((input) => input.id === interrupted.id)!.state, "cancelled")
    receipt.interruptedTurn = { input: interrupted.id, observed: "uncertain", operatorResolution: "cancelled after actual idle readback; no replay" }
  }
  await native("/native/settings", { enabled: true })
  await watchPermissionToasts()
  await masterSend("NATIVE_V2_REQUEST FOLLOWUP 撤销信任后重新检查，应恢复逐次审批。")
  await until(async () => !!(await permissions()).find((item) => item.ticket === first.ticket)!.requests.length, "revoked next turn asks again")
  await browser("wait", "--fn", "window.__permissionToasts.length > 0")
  assert.ok((await toastEvidence("revokedToasts")).length > 0, "Revocation restores native permission toasts on a new operation")
  await workbench()
  await browser("wait", `${task(first.ticket)} [data-testid=superagent-permission-once]`)
  await browser("screenshot", path.join(directory, "permissions-revoked.png"))
  await browser("set", "viewport", "390", "844")
  await browser("screenshot", path.join(directory, "permissions-mobile.png"))
  await browser("click", `${task(first.ticket)} [data-testid=superagent-permission-once]`)
  await until(async () => await delivered() === 4, "post-revoke single approval completes")
  assert.equal(await readFile(externalFile, "utf8"), externalEvidence + "\n")
  const final = await permissions()
  assert.ok(final.every((item) => !item.trusted && !item.requests.length))
  receipt = { ...receipt, passed: true, first, second, final, modelCalls: calls, checks: ["cold reload trusted same-run read never inserts a permission toast", "untrusted and revoked tasks retain native permission toasts", "compact trigger and no automatic modal", "Escape and close restore trigger focus", "poll preserves modal and confirmation focus", "read failure shows unknown", "mutation error persists across polling and reopen", "duplicate click sends one mutation", "closed dialog does not interrupt trusted sweep", "real read pending visible", "once approval", "two-step trust", "current pending and subsequent same-run read released", "active revoke abort confirmed idle", "trusted followup same session without prompt", "other task stays untrusted and pending", "real read rejection", "two-step revoke while disabled", "new turn after revoke asks again"] }
  console.log(JSON.stringify({ stage: "passed", directory }))
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
  receipt.inputTrace = await browser("eval", "window.__nativeInputEvents ?? []").catch(() => "unavailable")
  receipt.failureUrl = await browser("get", "url").catch(() => "unavailable")
  console.error(String(error))
  await browser("screenshot", path.join(directory, "failure.png")).catch(() => undefined)
  await browser("snapshot").then((x) => writeFile(path.join(directory, "failure-snapshot.txt"), x)).catch(() => undefined)
  process.exitCode = 1
} finally {
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2))
  releaseWorker?.()
  releaseSecondRead?.()
  // Optional inspection applies only to this isolated fixture.
  if ((receipt.passed && process.env.NATIVE_E2E_KEEP === "1") || (!receipt.passed && process.env.NATIVE_E2E_KEEP_FAILURE === "1")) {
    console.log(JSON.stringify({ stage: "holding", stopFile: path.join(directory, "stop") }))
    await until(async () => { try { await access(path.join(directory, "stop")); return true } catch { return false } }, "operator inspection", 1_800_000).catch(() => undefined)
  }
  await browser("close").catch(() => undefined)
  for (const child of children.reverse()) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(3000)]) }
  model.stop(true)
}
