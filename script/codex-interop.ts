#!/usr/bin/env bun
// Exercises an installed Codex against a local Responses fixture, never a real account.
import assert from "node:assert/strict"
import { mkdtemp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

type Object = Record<string, unknown>
type Packet = { id?: number; method?: string; params?: Object; result?: Object; error?: unknown }
const deadline = Date.now() + 120_000

function object(value: unknown): Object {
  assert(value && typeof value === "object" && !Array.isArray(value), "Expected an object")
  return value as Object
}

function array(value: unknown): Object[] {
  assert(Array.isArray(value), "Expected an array")
  return value.map(object)
}

function string(value: unknown): string {
  assert.equal(typeof value, "string")
  return value as string
}

async function until(check: () => boolean, label: string, timeout = 20_000) {
  const limit = Math.min(deadline, Date.now() + timeout)
  while (!check()) {
    assert(Date.now() < limit, `Timed out: ${label}`)
    await Bun.sleep(25)
  }
}

async function bounded<T>(promise: Promise<T>, label: string, timeout = 20_000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function rpc(write: (packet: Packet) => void, log: (packet: Packet, direction: string) => void) {
  let sequence = 0
  const pending = new Map<number, { resolve: (value: Object) => void; reject: (error: Error) => void }>()
  const events: Packet[] = []
  const send = (packet: Packet) => {
    log(packet, "sent")
    write(packet)
  }
  return {
    events,
    receive(packet: Packet) {
      log(packet, "received")
      if (packet.method) {
        events.push(packet)
        // The fixture never requests tools. Fail closed if Codex requests a client capability.
        if (packet.id !== undefined) send({ id: packet.id, error: { code: -32601, message: "Probe has no tools" } })
        return
      }
      if (packet.id === undefined) return
      const waiter = pending.get(packet.id)
      pending.delete(packet.id)
      if (packet.error) {
        waiter?.reject(new Error(JSON.stringify(packet.error)))
        return
      }
      waiter?.resolve(object(packet.result))
    },
    async call(method: string, params: Object = {}) {
      assert(Date.now() < deadline, "Probe exceeded its overall deadline")
      const id = ++sequence
      try {
        return await bounded(
          new Promise<Object>((resolve, reject) => {
            pending.set(id, { resolve, reject })
            send({ id, method, params })
          }),
          `RPC ${method}`,
          Math.min(20_000, deadline - Date.now()),
        )
      } finally {
        pending.delete(id)
      }
    },
    notify(method: string) {
      send({ method })
    },
  }
}

assert(process.argv[2], "Usage: bun script/codex-interop.ts <absolute Codex executable>")
const executable = string(process.argv[2])
assert(path.isAbsolute(executable), "Usage: bun script/codex-interop.ts <absolute Codex executable>")
const root = await mkdtemp(path.join(tmpdir(), "aether-codex-interop-run-"))
const home = path.join(root, "home")
const project = path.join(root, "project")
await Promise.all([mkdir(home), mkdir(project)])
console.log(`Evidence: ${root}`)

// Only operating-system variables are inherited. In particular, no account keys or Codex settings.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP)$/i.test(key)),
)
Object.assign(env, {
  CODEX_HOME: home,
  HOME: home,
  USERPROFILE: home,
  APPDATA: home,
  LOCALAPPDATA: home,
  XDG_CONFIG_HOME: home,
  XDG_DATA_HOME: home,
})

const requests: Object[] = []
const logs: Object[] = []
const checks: Object[] = []
let held = false
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") {
      return new Response("Unknown fixture endpoint", { status: 404 })
    }
    assert(!request.headers.has("authorization"), "Isolated provider must not send credentials")
    const body = object(await request.json())
    requests.push(body)
    const id = `resp_fixture_${requests.length}`
    const text = `Local fixture response ${requests.length}.`
    const item = {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }
    const response = {
      id,
      object: "response",
      model: body.model,
      output: [item],
      status: "completed",
      usage: { input_tokens: 40, output_tokens: 8, total_tokens: 48, input_tokens_details: { cached_tokens: 0 } },
    }
    return new Response(
      new ReadableStream({
        async start(controller) {
          let sequence = 0
          const event = (type: string, data: Object) =>
            controller.enqueue(
              new TextEncoder().encode(
                `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`,
              ),
            )
          event("response.created", { response: { ...response, status: "in_progress", output: [] } })
          event("response.output_item.added", {
            output_index: 0,
            item: { ...item, status: "in_progress", content: [] },
          })
          event("response.content_part.added", {
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          })
          event("response.output_text.delta", {
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            delta: "Local fixture ",
          })
          await until(() => !held, "release fixture response")
          event("response.output_text.delta", {
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            delta: text.slice(14),
          })
          event("response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text })
          event("response.content_part.done", {
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            part: item.content[0],
          })
          event("response.output_item.done", { output_index: 0, item })
          event("response.completed", { response })
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})

const children: Bun.Subprocess[] = []
const sockets: WebSocket[] = []
const readers: Promise<unknown>[] = []
const diagnostics = new Map<string, string>()

function track(promise: Promise<unknown>) {
  readers.push(
    promise.catch((error) => {
      checks.push({ check: "reader_failure", error: String(error) })
      process.exitCode = 1
    }),
  )
}

function launch(name: string, args = ["app-server"]) {
  const child = Bun.spawn([executable, ...args], {
    cwd: project,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  children.push(child)
  track(
    (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of child.stderr) {
        diagnostics.set(name, (diagnostics.get(name) ?? "") + decoder.decode(chunk, { stream: true }))
      }
      await Bun.write(path.join(root, `${name}.stderr.txt`), diagnostics.get(name) ?? "")
    })(),
  )
  return child
}

async function stdio(name: string) {
  const child = launch(name)
  const client = rpc(
    (packet) => {
      child.stdin.write(JSON.stringify(packet) + "\n")
    },
    (packet, direction) => logs.push({ client: name, direction, packet }),
  )
  track(
    (async () => {
      const decoder = new TextDecoder()
      let buffer = ""
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        lines.filter(Boolean).forEach((line) => client.receive(JSON.parse(line)))
      }
    })(),
  )
  await initialize(client)
  return client
}

async function initialize(client: ReturnType<typeof rpc>) {
  const result = await client.call("initialize", {
    clientInfo: { name: "aether_interop_probe", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  })
  assert.equal(path.resolve(string(result.codexHome)), path.resolve(home), "Connected to an unexpected Codex home")
  client.notify("initialized")
}

async function websocket(name: string, url: string, token: string) {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
  sockets.push(socket)
  const client = rpc(
    (packet) => socket.send(JSON.stringify(packet)),
    (packet, direction) => logs.push({ client: name, direction, packet }),
  )
  socket.addEventListener("message", (event) => client.receive(JSON.parse(String(event.data))))
  await until(() => socket.readyState !== WebSocket.CONNECTING, `WebSocket connection ${name}`)
  assert.equal(socket.readyState, WebSocket.OPEN, `WebSocket failed: ${name}`)
  await initialize(client)
  return Object.assign(client, { close: () => socket.close() })
}

function deltas(client: ReturnType<typeof rpc>, turn: string) {
  return client.events.filter((event) => event.method === "item/agentMessage/delta" && event.params?.turnId === turn)
}

async function complete(client: ReturnType<typeof rpc>, turn: string) {
  await until(
    () => client.events.some((event) => event.method === "turn/completed" && object(event.params?.turn).id === turn),
    `turn ${turn}`,
  )
  const event = client.events.find(
    (event) => event.method === "turn/completed" && object(event.params?.turn).id === turn,
  )!
  assert.equal(object(event.params?.turn).status, "completed", JSON.stringify(event))
}

async function pages(client: ReturnType<typeof rpc>, method: string, params: Object) {
  const turns: Object[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    assert(cursors.size < 100, "Probe history exceeded its bounded page count")
    const page = await client.call(method, { ...params, limit: 1, sortDirection: "asc", ...(cursor ? { cursor } : {}) })
    turns.push(...array(page.data))
    cursor = page.nextCursor ? string(page.nextCursor) : undefined
    if (cursor) {
      assert(!cursors.has(cursor), "Repeated pagination cursor")
      cursors.add(cursor)
    }
  } while (cursor)
  return turns
}

function history(client: ReturnType<typeof rpc>, thread: string) {
  return pages(client, "thread/turns/list", { threadId: thread, itemsView: "full" })
}

try {
  await Bun.write(
    path.join(home, "config.toml"),
    `model_provider = "aether-interop"
model = "gpt-5.1-codex"
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.aether-interop]
name = "Local interop fixture"
base_url = "http://127.0.0.1:${fixture.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`,
  )
  const version = launch("version", ["--version"])
  const installed = (await bounded(new Response(version.stdout).text(), "version output")).trim()
  assert.equal(await bounded(version.exited, "version exit"), 0)
  checks.push({ check: "version", value: installed })
  const owner = await stdio("owner")
  const started = await owner.call("thread/start", {
    cwd: project,
    approvalPolicy: "never",
    sandbox: "read-only",
    historyMode: "paginated",
    serviceName: "aether-interop",
  })
  const thread = string(object(started.thread).id)
  const first = await owner.call("turn/start", {
    threadId: thread,
    clientUserMessageId: "aether-probe-first",
    input: [{ type: "text", text: "Synthetic first message." }],
  })
  const firstid = string(object(first.turn).id)
  await complete(owner, firstid)
  const saved = await history(owner, thread)
  assert.equal(saved.length, 1)
  const record = saved[0]
  assert(record)
  assert.equal(record.id, firstid)
  assert(array(record.items).some((item) => item.type === "agentMessage" && item.text === "Local fixture response 1."))
  assert(array(record.items).some((item) => item.type === "userMessage" && item.clientId === "aether-probe-first"))
  checks.push({
    check: "native_persisted_history",
    passed: true,
    thread,
    turn: firstid,
    clientUserMessageIdReturned: true,
  })

  const reader = await stdio("reader")
  const persisted = await history(reader, thread)
  assert.deepEqual(persisted, saved)
  checks.push({ check: "independent_process_history", passed: true })

  held = true
  const second = await owner.call("turn/start", {
    threadId: thread,
    input: [{ type: "text", text: "Synthetic second message." }],
  })
  const secondid = string(object(second.turn).id)
  await until(() => deltas(owner, secondid).length > 0, "owner starts streaming")
  const external = await reader.call("thread/read", { threadId: thread })
  const active = await history(reader, thread)
  const local = await owner.call("thread/read", { threadId: thread })
  checks.push({
    check: "independent_process_during_turn",
    ownerStatus: object(local.thread).status,
    readerStatus: object(external.thread).status,
    turns: active.map((turn) => ({ id: turn.id, status: turn.status, items: turn.items })),
    receivedDeltas: deltas(reader, secondid).length,
  })
  held = false
  await complete(owner, secondid)
  const finished = await history(owner, thread)
  assert.equal(finished.length, 2)
  assert.deepEqual(await history(reader, thread), finished)
  checks.push({ check: "pagination_after_external_completion", passed: true })
  const items = await pages(reader, "thread/items/list", { threadId: thread })
  assert.deepEqual(
    items.map((entry) => entry.item),
    finished.flatMap((turn) => array(turn.items)),
  )
  checks.push({ check: "item_pagination_identity", passed: true, items: items.length })

  const legacy = await owner.call("thread/start", {
    cwd: project,
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "read-only",
    historyMode: "legacy",
  })
  assert.equal(legacy.approvalsReviewer, "auto_review")
  const legacyid = string(object(legacy.thread).id)
  const legacyturn = await owner.call("turn/start", {
    threadId: legacyid,
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    input: [{ type: "text", text: "Synthetic legacy-history message, no tools." }],
  })
  await complete(owner, string(object(legacyturn.turn).id))
  const legacyhistory = await history(reader, legacyid)
  assert.equal(legacyhistory.length, 1)
  assert(legacyhistory[0])
  assert(array(legacyhistory[0].items).some((item) => item.type === "agentMessage"))
  checks.push({ check: "legacy_thread_pagination", passed: true })
  checks.push({ check: "auto_review_parameter_accepted", passed: true, reviewerExecutionTested: false })

  // Let the OS allocate the port; use only the endpoint printed by our own child.
  const token = crypto.randomUUID()
  const digest = new Bun.CryptoHasher("sha256").update(token).digest("hex")
  const server = launch("websocket", [
    "app-server",
    "--listen",
    "ws://127.0.0.1:0",
    "--ws-auth",
    "capability-token",
    "--ws-token-sha256",
    digest,
  ])
  track(new Response(server.stdout).text().then((text) => Bun.write(path.join(root, "websocket.stdout.txt"), text)))
  await until(() => {
    assert.equal(server.exitCode, null, "WebSocket child exited before listening")
    return /listening on: ws:\/\/127\.0\.0\.1:\d+/.test(diagnostics.get("websocket") ?? "")
  }, "owned WebSocket endpoint")
  const url = string(diagnostics.get("websocket")?.match(/listening on: (ws:\/\/127\.0\.0\.1:\d+)/)?.[1])
  let ready = false
  const deadline = Date.now() + 20_000
  while (!ready) {
    assert.equal(server.exitCode, null, "WebSocket child exited before becoming ready")
    ready = await fetch(url.replace("ws:", "http:") + "/readyz", { signal: AbortSignal.timeout(500) })
      .then((response) => response.ok)
      .catch(() => false)
    assert(Date.now() < deadline, "WebSocket server did not become ready")
    if (!ready) await Bun.sleep(100)
  }
  const primary = await websocket("primary", url, token)
  const follower = await websocket("follower", url, token)
  const created = await primary.call("thread/start", {
    cwd: project,
    approvalPolicy: "never",
    sandbox: "read-only",
    historyMode: "paginated",
  })
  const shared = string(object(created.thread).id)
  // New threads have no persisted rollout until their first turn.
  const seed = await primary.call("turn/start", {
    threadId: shared,
    input: [{ type: "text", text: "Synthetic seed message." }],
  })
  await complete(primary, string(object(seed.turn).id))
  await follower.call("thread/resume", { threadId: shared, excludeTurns: true })
  held = true
  const next = await primary.call("turn/start", {
    threadId: shared,
    input: [{ type: "text", text: "Synthetic shared-stream message." }],
  })
  const turn = string(object(next.turn).id)
  await until(
    () => deltas(primary, turn).length > 0 && deltas(follower, turn).length > 0,
    "both clients receive stream",
  )
  held = false
  await Promise.all([complete(primary, turn), complete(follower, turn)])
  assert.deepEqual(deltas(follower, turn), deltas(primary, turn))
  checks.push({ check: "same_server_two_clients_stream", passed: true, deltas: deltas(primary, turn).length })
  follower.close()
  const reconnected = await websocket("reconnected", url, token)
  await reconnected.call("thread/resume", { threadId: shared, excludeTurns: true })
  assert.deepEqual(await history(reconnected, shared), await history(primary, shared))
  checks.push({ check: "reconnect_history_identity", passed: true })
  checks.push({
    check: "desktop_ipc",
    tested: false,
    reason: "Private owner/follower IPC is separate from this isolated public app-server.",
  })
  assert.equal(requests.length, 5, "Unexpected model requests; this probe only sends five synthetic turns")
  console.log(JSON.stringify(checks, null, 2))
} catch (error) {
  checks.push({ check: "failure", error: String(error) })
  process.exitCode = 1
  console.error(error)
} finally {
  held = false
  sockets.forEach((socket) => socket.close())
  children.forEach((child) => {
    if (child.exitCode === null) child.kill()
  })
  await bounded(
    Promise.all([...children.map((child) => child.exited), ...readers]),
    "owned process cleanup",
    5000,
  ).catch((error) => {
    checks.push({ check: "cleanup_failure", error: String(error) })
    process.exitCode = 1
  })
  fixture.stop(true)
  await Promise.all([
    Bun.write(
      path.join(root, "report.json"),
      JSON.stringify(
        {
          checks,
          fixtureRequests: requests.length,
          isolation: {
            home,
            project,
            environment: "OS allowlist; no account keys inherited",
            provider: "loopback Responses fixture; Authorization header forbidden",
            desktopIpcConnected: false,
          },
          children: children.map((child) => ({
            pid: child.pid,
            exitCode: child.exitCode,
            signalCode: child.signalCode,
          })),
        },
        null,
        2,
      ),
    ),
    Bun.write(path.join(root, "protocol.jsonl"), logs.map((entry) => JSON.stringify(entry)).join("\n")),
    Bun.write(path.join(root, "requests.json"), JSON.stringify(requests, null, 2)),
  ])
}
