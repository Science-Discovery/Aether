// Run from packages/opencode: bun ../../.aether/workflow/loca/check-aether.js
import { mkdtemp, mkdir, cp, symlink, writeFile, chmod, rm, realpath } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import assert from "node:assert/strict"

const root = path.resolve(import.meta.dir, "../../..")
const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "loca-native-")))
const project = path.join(dir, "project")
await mkdir(project)
Object.assign(process.env, {
  XDG_DATA_HOME: path.join(dir, "data"),
  XDG_CACHE_HOME: path.join(dir, "cache"),
  XDG_CONFIG_HOME: path.join(dir, "config"),
  XDG_STATE_HOME: path.join(dir, "state"),
  OPENCODE_TEST_HOME: path.join(dir, "home"),
  OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(dir, "managed"),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_SHARE: "true",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
  OPENCODE_MODELS_PATH: path.join(root, "packages/opencode/test/tool/fixtures/models-api.json"),
})
await Promise.all(["home", "managed", "config"].map((name) => mkdir(path.join(dir, name))))
await cp(path.join(root, ".aether"), path.join(project, ".aether"), {
  recursive: true,
  filter: (file) => {
    const relative = path.relative(path.join(root, ".aether"), file)
    return (
      !relative ||
      (/^(plugins|agent|command|skills|workflow)(\/|$)/.test(relative) &&
        !relative.includes(".runtime") &&
        !relative.includes("results") &&
        !relative.includes("node_modules"))
    )
  },
})
await symlink(path.join(root, "node_modules"), path.join(project, ".aether/node_modules"))
await writeFile(path.join(project, "AGENTS.md"), "Ambient instruction canary: LOCA_SHOULD_NOT_SEE_THIS_AS_EVIDENCE\n")
const requests = []
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const body = await request.json()
    requests.push(body)
    const structured = body.tools?.some((tool) => tool.function?.name === "StructuredOutput")
    const packet = structured
      ? JSON.parse(body.messages.find((message) => message.role === "user").content).packet
      : null
    const value = structured
      ? {
          verdict: "pass",
          checks: ["intent", "criteria", "retention", "testability"].map((id) => ({
            id,
            status: "pass",
            reason: "Native protocol fixture",
            evidence: [packet.assets[0].id],
          })),
          findings: [],
        }
      : null
    const chunks = structured
      ? [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "fixture-call",
                      type: "function",
                      function: { name: "StructuredOutput", arguments: JSON.stringify(value) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]
      : [
          { choices: [{ index: 0, delta: { role: "assistant", content: "LOCA fixture" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]
    return new Response(
      chunks
        .map(
          (chunk) =>
            `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", ...chunk })}\n\n`,
        )
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
await writeFile(
  path.join(project, ".aether/aether.json"),
  JSON.stringify({
    model: "loca-fixture/fixture",
    small_model: "loca-fixture/fixture",
    memory: { enabled: false },
    skills: { evolution_enabled: false },
    snapshot: false,
    provider: {
      "loca-fixture": {
        npm: "@ai-sdk/openai-compatible",
        name: "LOCA fixture",
        options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture" },
        models: { fixture: { name: "Fixture", limit: { context: 200000, output: 20000 } } },
      },
    },
  }),
)
// Prevent the core loader's optional dependency installer from contacting a package registry.
await chmod(path.join(project, ".aether"), 0o555)
await Bun.$`git init -q ${project}`.quiet()
const { Instance } = await import(path.join(root, "packages/opencode/src/project/instance.ts"))
const { Config } = await import(path.join(root, "packages/opencode/src/config/config.ts"))
const { Plugin } = await import(path.join(root, "packages/opencode/src/plugin/index.ts"))
const { Session } = await import(path.join(root, "packages/opencode/src/session/index.ts"))
const { engines } = await import(path.join(project, ".aether/workflow/loca/engine.js"))
const { review } = await import(path.join(project, ".aether/workflow/loca/schema.js"))
await Instance.provide({
  directory: project,
  fn: async () => {
    const config = await Config.get()
    assert.equal(config.agent.loca.mode, "primary")
    assert.equal(config.agent["loca-reasoning"].hidden, true)
    assert.equal(config.command.loca.agent, "loca")
    assert(config.plugin.some((file) => file.endsWith("/plugins/loca.js")))
    const hooks = await Plugin.list()
    assert(hooks.some((hook) => hook.tool?.loca))
    const parent = await Session.create({ title: "LOCA native fixture" })
    const cfg = await Bun.file(path.join(project, ".aether/workflow/loca/workflow.json")).json()
    // The same exported plugin module owns all contexts. Expose no special production testing hooks.
    const bridge = hooks.find((hook) => hook.tool?.loca)
    const output = {
      message: { id: "fixture-human", agent: "loca" },
      parts: [{ type: "text", text: "A native loader probe" }],
    }
    await bridge["chat.message"](
      { sessionID: parent.id, agent: "loca", model: { providerID: "loca-fixture", modelID: "fixture" } },
      output,
    )
    assert.equal(output.message.agent, "loca")
    await bridge["command.execute.before"]({ command: "loca-status", sessionID: parent.id, arguments: "" })
    await bridge["chat.message"](
      { sessionID: parent.id, agent: "loca" },
      { message: { id: "fixture-status", agent: "loca" }, parts: [] },
    )
    const status = await bridge.tool.loca.execute({}, { sessionID: parent.id, abort: new AbortController().signal })
    assert(status.includes("LOCA"))
    await assert.rejects(bridge["tool.execute.before"]({ sessionID: parent.id, tool: "bash", callID: "forbidden" }))
    const engine = engines.get(project)
    const session = await Session.create({ title: "LOCA real child session" })
    const run = engine.store.create(session.id)
    run.model = { providerID: "loca-fixture", modelID: "fixture" }
    const asset = engine.store.put(run, "input", "goal.txt", "Check fixture")
    engine.active.set(session.id, { controller: new AbortController() })
    const result = await engine.runner.call(run, "fidelity", engine.packet(run, {}, [asset.id]), (value) =>
      review(value, cfg.checks.contract),
    )
    assert.equal(result.value.verdict, "pass")
    assert.equal(engine.store.jobs(run)[0].status, "accepted")
    assert(requests.some((body) => body.tools?.some((tool) => tool.function?.name === "StructuredOutput")))
    const body = requests.find((body) => body.tools?.some((tool) => tool.function?.name === "StructuredOutput"))
    assert(!JSON.stringify(body.messages).includes("LOCA_SHOULD_NOT_SEE_THIS_AS_EVIDENCE"))
    await Promise.all(engine.store.jobs(run).map((job) => chmod(path.join(job.directory, ".aether"), 0o755)))
    engine.store.db.close()
  },
}).finally(async () => {
  await Instance.disposeAll()
  server.stop(true)
  await chmod(path.join(project, ".aether"), 0o755)
  await rm(dir, { recursive: true, force: true })
})
console.log(
  "Aether native loader, plugin tools, child-session SDK and structured output verified using a local scripted provider.",
)
