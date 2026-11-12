import { test, expect } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

type Hooks = {
  config: (config: { default_agent?: string }) => Promise<void>
  "chat.message": (input: { sessionID: string; agent?: string }, output: { message: { agent: string } }) => Promise<void>
  "chat.params": (input: { sessionID: string; agent: unknown; message?: { id: string } }) => Promise<void>
  "tool.execute.before": (input: { sessionID: string; tool: string; callID: string }, output: { args: unknown }) => Promise<void>
}

async function plugin(target?: string, workspace?: string) {
  const sources = process.env.AETHER_SOURCE ? [path.resolve(process.env.AETHER_SOURCE)] : [
    path.resolve(import.meta.dir, "../../.."), path.resolve(import.meta.dir, "../../Aether"),
  ]
  const source = sources.map((root) => path.join(root, "packages/plugin/src/index.ts")).find((file) => existsSync(file))
  if (!source) throw new Error("Plugin guard tests need an Aether source checkout and installed dependencies. Run AETHER_SOURCE=/absolute/path/to/Aether bun test.")
  const directory = target ?? await mkdtemp(path.join(tmpdir(), "superagent-guard-"))
  const template = await readFile(path.join(import.meta.dir, "../integration/plugin/superagent.ts"), "utf8")
  const file = path.join(directory, "plugin.ts")
  await writeFile(file, template
    .replace("__SUPERAGENT_PLUGIN__", JSON.stringify(source))
    .replace("__SUPERAGENT_BRIDGE__", JSON.stringify(path.join(directory, "unused-bridge.json"))))
  // Exercise the installed plugin itself and real tool.schema implementation;
  // no model, coordinator, configuration read, or permission API is involved.
  const factory = (await import(file)).SuperagentPlugin as (context: { directory: string }) => Promise<Hooks>
  return factory({ directory: workspace ?? directory })
}

test("resolved primary role blocks direct tools even when the session policy would otherwise allow them", async () => {
  const hooks = await plugin()
  await hooks["chat.message"]({ sessionID: "main", agent: "build" }, { message: { agent: "superagent" } })
  let executed = 0
  const execute = async (tool: string) => {
    await hooks["tool.execute.before"]({ sessionID: "main", tool, callID: "call" }, { args: { sessionPermission: "full" } })
    executed++
  }
  for (const tool of ["read", "bash", "glob", "grep", "task", "webfetch", "mcp_external_tool", "superagent_report"])
    await expect(execute(tool)).rejects.toThrow("registered tasks")
  expect(executed).toBe(0)
  for (const tool of ["superagent_dispatch", "superagent_status", "superagent_stop", "question"]) await execute(tool)
  expect(executed).toBe(4)
})

test("actual Agent.Info and string roles update enforcement; workers and later build turns stay usable", async () => {
  const hooks = await plugin()
  const before = (sessionID: string, tool: string) => hooks["tool.execute.before"]({ sessionID, tool, callID: "call" }, { args: {} })
  await hooks["chat.params"]({ sessionID: "main", agent: { name: "superagent", permission: [{ action: "allow" }] } })
  await expect(before("main", "read")).rejects.toThrow("registered tasks")
  await hooks["chat.params"]({ sessionID: "worker", agent: { name: "superagent-worker" } })
  await before("worker", "read")
  await before("worker", "superagent_report")
  await before("ordinary", "bash")
  await hooks["chat.message"]({ sessionID: "main", agent: "superagent" }, { message: { agent: "build" } })
  await before("main", "read")
  await hooks["chat.params"]({ sessionID: "main", agent: "superagent" })
  await expect(before("main", "bash")).rejects.toThrow("registered tasks")
  await hooks["chat.params"]({ sessionID: "main", agent: { name: "build" } })
  await before("main", "bash")
})

test("primary preset denies general tools while keeping registered coordination and clarification available", async () => {
  const source = await readFile(path.join(import.meta.dir, "../integration/agents/superagent.md"), "utf8")
  const policy = source.split("---")[1]!
  expect(policy).toContain('"*": deny')
  for (const tool of ["superagent_dispatch", "superagent_status", "superagent_stop", "question"])
    expect(policy).toContain(`${tool}: allow`)
  expect(policy).toContain("superagent_report: deny")
  expect(source).toContain("opaque attachment ID")
})


test("primary observation uses the private transport once per persisted user turn without impersonating a tool", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "superagent-observe-"))
  const token = "isolated-observer-test-token"
  await writeFile(path.join(directory, "token"), token)
  await writeFile(path.join(directory, "unused-bridge.json"), JSON.stringify({ url: "http://127.0.0.1:1", tokenFile: path.join(directory, "token") }))
  const calls: { name: string; args: unknown; context: { sessionID: string; messageID: string; directory: string; agent: string; callID?: string } }[] = []
  const server = Bun.serve({ unix: path.join(directory, "control.sock"), async fetch(request) {
    expect(request.headers.get("Authorization")).toBe(`Bearer ${token}`)
    expect(new URL(request.url).pathname).toBe("/native/tool")
    calls.push(await request.json() as typeof calls[number])
    return Response.json(true)
  } })
  try {
    const hooks = await plugin(directory)
    await hooks["chat.params"]({ sessionID: "main", agent: { name: "superagent" }, message: { id: "msg_user1" } })
    await hooks["chat.params"]({ sessionID: "main", agent: "superagent", message: { id: "msg_user1" } })
    await hooks["chat.params"]({ sessionID: "worker", agent: "superagent-worker", message: { id: "msg_worker" } })
    await hooks["chat.params"]({ sessionID: "ordinary", agent: "build", message: { id: "msg_build" } })
    await hooks["chat.params"]({ sessionID: "main", agent: "superagent", message: { id: "msg_user2" } })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ name: "observe", args: {}, context: { sessionID: "main", messageID: "msg_user1", directory, agent: "superagent" } })
    expect(calls[1]?.context.messageID).toBe("msg_user2")
  } finally { server.stop(true) }
})

test("an unresponsive optional observer is bounded and cannot break the primary tool guard", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "superagent-observe-timeout-"))
  await writeFile(path.join(directory, "token"), "fixture")
  await writeFile(path.join(directory, "unused-bridge.json"), JSON.stringify({ url: "http://127.0.0.1:1", tokenFile: path.join(directory, "token") }))
  let release = () => {}
  const server = Bun.serve({ unix: path.join(directory, "control.sock"), fetch: () => new Promise<Response>((resolve) => { release = () => resolve(Response.json(true)) }) })
  try {
    const hooks = await plugin(directory)
    const start = Date.now()
    await hooks["chat.params"]({ sessionID: "main", agent: "superagent", message: { id: "msg_user" } })
    expect(Date.now() - start).toBeLessThan(2800)
    await expect(hooks["tool.execute.before"]({ sessionID: "main", tool: "read", callID: "call" }, { args: {} })).rejects.toThrow("registered tasks")
  } finally { release(); server.stop(true) }
}, 6000)

test("the default role follows a registered custom master directory only", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "superagent-master-"))
  const master = path.join(directory, "custom", "native-master", "v05")
  const other = path.join(directory, "other", "native-master", "v05")
  await writeFile(path.join(directory, "token"), "fixture-token")
  await writeFile(path.join(directory, "unused-bridge.json"), JSON.stringify({
    url: "http://127.0.0.1:1", tokenFile: path.join(directory, "token"),
  }))
  const server = Bun.serve({ unix: path.join(directory, "control.sock"), async fetch(request) {
    expect(request.headers.get("Authorization")).toBe("Bearer fixture-token")
    const body = await request.json()
    expect(body.name).toBe("owns_directory")
    return Response.json(body.context.directory === master)
  } })
  try {
    const accepted = {}
    const ignored = {}
    await (await plugin(directory, master)).config(accepted)
    const hooks = await plugin(directory, other)
    await hooks.config(ignored)
    expect(accepted).toEqual({ default_agent: "superagent" })
    expect(ignored).toEqual({})
  } finally { server.stop(true) }
})
