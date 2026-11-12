import { homedir } from "node:os"
// Opt-in integration: real upstream Aether, isolated state, deterministic local
// model transport. This verifies API/tool contracts, not model intelligence.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { Aether } from "../src/aether"
import { Store } from "../src/store"
import { Engine } from "../src/engine"
import { git } from "../src/workspace"

const upstream = path.resolve(process.argv[2] ?? "../Aether")
const root = process.env.SUPERAGENT_TEST_ROOT ?? path.join(homedir(), "data/aether-superagent-tests")
await mkdir(root, { recursive: true })
const directory = await mkdtemp(path.join(root, "real-aether-"))
const repo = path.join(directory, "repo")
await mkdir(repo)
await git(repo, "init")
await git(repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "fixture")
const calls: { tools: string[]; router: boolean }[] = []
const model = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const body = await request.json() as { stream?: boolean; tools?: { function: { name: string } }[] }
    const tools = (body.tools ?? []).map((tool) => tool.function.name)
    const router = tools.includes("StructuredOutput")
    calls.push({ tools, router })
    const delta = router ? {
      tool_calls: [{ index: 0, id: "call_route", type: "function", function: { name: "StructuredOutput", arguments: JSON.stringify({ action: "create", ticket: "", title: "Fixture task", text: "Create an independent task." }) } }],
    } : { content: "Fixture worker completed this turn." }
    if (!body.stream) return Response.json({
      id: "fixture", object: "chat.completion", created: 1, model: "tiny",
      choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason: router ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", created: 1, model: "tiny",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
    return new Response(chunk(delta, null) + chunk({}, router ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    })
  },
})
const config = {
  enabled_providers: ["fixture"], model: "fixture/tiny", small_model: "fixture/tiny",
  provider: { fixture: {
    name: "Local fixture", npm: "@ai-sdk/openai-compatible", env: [],
    options: { apiKey: "fixture-only", baseURL: `${model.url.origin}/v1` },
    models: { tiny: { name: "Tiny", tool_call: true, limit: { context: 100_000, output: 2000 } } },
  } },
  agent: { build: { steps: 2 } },
}
const log = Bun.file(path.join(directory, "aether.log"))
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reservation.port!
reservation.stop(true)
const child = Bun.spawn([process.execPath, "run", "--conditions=browser", path.join(upstream, "packages/opencode/src/index.ts"), "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: path.join(upstream, "packages/opencode"),
  env: {
    PATH: process.env.PATH, LANG: "C.UTF-8",
    XDG_DATA_HOME: path.join(directory, "data"), XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_CACHE_HOME: path.join(directory, "cache"), XDG_STATE_HOME: path.join(directory, "xdg-state"),
    OPENCODE_TEST_HOME: path.join(directory, "home"), OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_BACKGROUND_SERVICES: "false", OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_CHANNEL: "superagent-smoke", OPENCODE_SERVER_PASSWORD: "fixture-password",
    TMPDIR: directory,
  },
  stdout: log, stderr: log,
})
let store: Store | undefined
try {
  let url = ""
  for (let i = 0; i < 120; i++) {
    url = (await log.text()).match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? ""
    if (url) break
    if (child.exitCode !== null) throw new Error(`Aether exited ${child.exitCode}: ${await log.text()}`)
    await Bun.sleep(500)
  }
  assert.ok(url, `Aether startup timed out; inspect ${log.name}`)
  const state = path.join(directory, "coordinator")
  await mkdir(state)
  store = new Store(path.join(state, "superagent.db"))
  const aether = new Aether(url, `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`, 60_000)
  const engine = new Engine(store, aether, { repo, state, base: await git(repo, "rev-parse", "HEAD"), workers: 2, model: { providerID: "fixture", modelID: "tiny" } })
  const input = engine.submit("route-1", "Please inspect this repository and report a result.")
  engine.tick()
  await Promise.all(engine.active.values())
  assert.equal(store.input(input.id)?.state, "done", JSON.stringify(store.input(input.id)))
  assert.equal(store.tickets().length, 1)
  engine.tick()
  await Promise.all(engine.active.values())
  const ticket = store.tickets()[0]!
  assert.equal(ticket.state, "waiting", JSON.stringify(ticket))
  assert.equal(ticket.result, "Fixture worker completed this turn.")
  const followup = engine.submit("followup-1", "Continue the same task with this new fact.", ticket.id)
  engine.tick()
  await Promise.all(engine.active.values())
  assert.equal(store.input(followup.id)?.state, "done", JSON.stringify(store.input(followup.id)))
  assert.equal(store.ticket(ticket.id)?.session, ticket.session)
  const history = await aether.request<{ info: { role: string } }[]>(ticket.directory, `/session/${ticket.session}/message`)
  assert.equal(history.filter((x) => x.info.role === "user").length, 2)
  assert.ok(calls.some((x) => x.router))
  assert.ok(calls.filter((x) => x.router).every((x) => x.tools.length === 1 && x.tools[0] === "StructuredOutput"))
  const receipt = { passed: true, upstream, head: await git(upstream, "rev-parse", "HEAD"), directory,
    checks: ["real Aether startup", "router restricted to StructuredOutput", "structured route", "worker in separate worktree", "worker result", "followup in same session", "two persisted user messages"],
    model: "local deterministic HTTP fixture; no real model used", calls, ticket: store.ticket(ticket.id), inputs: store.inputs() }
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ passed: true, directory, checks: receipt.checks, head: receipt.head }, null, 2))
} finally {
  child.kill("SIGTERM")
  await child.exited
  model.stop(true)
  store?.db.close()
}
