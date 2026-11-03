import { createInterface } from "node:readline"
import { appendFile } from "node:fs/promises"
import path from "node:path"

if (process.argv.includes("generate-json-schema")) {
  const out = process.argv[process.argv.indexOf("--out") + 1]
  const thread = {
    properties: {
      dynamicTools: {
        type: ["array", "null"],
        items: {
          properties: {
            type: { enum: ["function"] },
            name: { type: "string" },
            description: { type: "string" },
            inputSchema: true,
          },
        },
      },
    },
  }
  const callbacks = {
    oneOf: [
      {
        properties: {
          method: { enum: ["item/tool/call"] },
          params: {
            properties: {
              threadId: { type: "string" },
              turnId: { type: "string" },
              callId: { type: "string" },
              tool: { type: "string" },
              arguments: true,
            },
          },
        },
      },
    ],
  }
  await Bun.write(path.join(out, "v2/ThreadStartParams.json"), JSON.stringify(thread))
  await Bun.write(path.join(out, "ServerRequest.json"), JSON.stringify(callbacks))
  for (const file of [
    "ClientRequest.json",
    "v2/TurnStartParams.json",
    "v2/TurnSteerParams.json",
    "v2/CollaborationModeListResponse.json",
  ])
    await Bun.write(path.join(out, file), "{}")
  process.exit(0)
}
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 1.0.0\n")
  process.exit(0)
}

type Turn = {
  id: string
  status: string
  itemsView: string
  startedAt: number
  completedAt?: number
  items: Record<string, unknown>[]
}
type Thread = {
  id: string
  sessionId: string
  parentThreadId: null
  createdAt: number
  updatedAt: number
  status: { type: string }
  turns: Turn[]
  dynamicTools: unknown[]
}
const root = process.cwd()
const file = path.join(root, "research-journal.json")
const threads: Record<string, Thread> = (await Bun.file(file).exists()) ? await Bun.file(file).json() : {}
const pending = new Map<string, { thread: string; turn: string; tool: string }>()
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const notify = (method: string, params: unknown) => write({ method, params })
const save = () => Bun.write(file, JSON.stringify(threads))

function ask(thread: string, turn: string, tool: string) {
  const id = `${tool}-${turn}`
  pending.set(id, { thread, turn, tool })
  notify("item/started", {
    threadId: thread,
    turnId: turn,
    item: { id, type: "dynamicToolCall", tool, arguments: { query: "Corpus" }, status: "inProgress" },
  })
  write({
    id,
    method: "item/tool/call",
    params: { threadId: thread, turnId: turn, callId: id, namespace: null, tool, arguments: { query: "Corpus" } },
  })
}

for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line) as {
    id?: string | number
    method?: string
    params?: Record<string, unknown>
    result?: unknown
    error?: unknown
  }
  await appendFile(path.join(root, "research-calls.jsonl"), JSON.stringify({ ...value, pid: process.pid }) + "\n")
  if (!value.method) {
    const item = pending.get(String(value.id))
    if (!item) continue
    pending.delete(String(value.id))
    const thread = threads[item.thread]
    const turn = thread.turns.find((turn) => turn.id === item.turn)!
    const tool = {
      id: String(value.id),
      type: "dynamicToolCall",
      tool: item.tool,
      arguments: { query: "Corpus" },
      status: "completed",
      result: value.result ?? value.error,
    }
    turn.items.push(tool)
    notify("item/completed", { threadId: thread.id, turnId: turn.id, item: tool })
    if (item.tool === "aether_session_search") {
      ask(thread.id, turn.id, "aether_knowledge_search")
      continue
    }
    const answer = {
      id: `answer-${turn.id}`,
      type: "agentMessage",
      text: "Research tools completed",
      phase: "final_answer",
    }
    turn.items.push(answer)
    turn.status = "completed"
    turn.completedAt = Date.now() / 1000
    thread.updatedAt = turn.completedAt
    thread.status.type = "idle"
    await save()
    notify("item/completed", { threadId: thread.id, turnId: turn.id, item: answer })
    notify("turn/completed", { threadId: thread.id, turn })
    continue
  }
  const params = value.params ?? {}
  const respond = (result: unknown) => write({ id: value.id, result })
  if (value.method === "initialize") {
    respond({ userAgent: "codex-fixture/1.0.0", codexHome: path.join(root, "codex-home") })
    continue
  }
  if (value.method === "initialized") continue
  if (value.method === "model/list") {
    respond({
      data: [
        {
          id: "native-model",
          model: "native-model",
          displayName: "Fixture",
          isDefault: true,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ["text"],
        },
      ],
      nextCursor: null,
    })
    continue
  }
  if (value.method === "thread/start") {
    const id = crypto.randomUUID()
    threads[id] = {
      id,
      sessionId: "research-fixture",
      parentThreadId: null,
      createdAt: Date.now() / 1000,
      updatedAt: Date.now() / 1000,
      status: { type: "idle" },
      turns: [],
      dynamicTools: Array.isArray(params.dynamicTools) ? params.dynamicTools : [],
    }
    await save()
    respond({ thread: threads[id] })
    continue
  }
  if (value.method === "thread/resume" || value.method === "thread/read") {
    const thread = threads[String(params.threadId)]
    if (!thread) {
      write({ id: value.id, error: { code: -32000, message: "Missing fixture thread" } })
      continue
    }
    respond({ thread })
    continue
  }
  if (value.method === "thread/turns/list") {
    respond({ data: threads[String(params.threadId)]?.turns ?? [], nextCursor: null })
    continue
  }
  if (value.method === "thread/loaded/list") {
    respond({ data: Object.keys(threads), nextCursor: null })
    continue
  }
  if (value.method === "turn/start") {
    const thread = threads[String(params.threadId)]
    const turn: Turn = {
      id: crypto.randomUUID(),
      status: "inProgress",
      itemsView: "full",
      startedAt: Date.now() / 1000,
      items: [
        {
          id: `user-${params.clientUserMessageId}`,
          type: "userMessage",
          clientId: params.clientUserMessageId,
          content: params.input,
        },
      ],
    }
    thread.turns.push(turn)
    thread.status.type = "active"
    await save()
    notify("turn/started", { threadId: thread.id, turn })
    respond({ turn: { id: turn.id } })
    ask(thread.id, turn.id, "aether_session_search")
    continue
  }
  if (value.method === "turn/interrupt") {
    respond({})
    continue
  }
  write({ id: value.id, error: { code: -32601, message: "Unknown fixture method" } })
}
