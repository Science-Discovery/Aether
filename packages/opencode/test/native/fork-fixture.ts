import readline from "node:readline"
import path from "node:path"
import { appendFileSync } from "node:fs"

if (process.argv.includes("generate-json-schema")) {
  const out = process.argv[process.argv.indexOf("--out") + 1]
  const reviewer = { enum: ["user", "auto_review"] }
  await Bun.write(
    path.join(out, "ClientRequest.json"),
    JSON.stringify({
      oneOf: ["turn/start", "turn/steer", "thread/fork", "thread/goal/get"].map((method) => ({
        properties: { method: { const: method } },
      })),
    }),
  )
  for (const name of ["ThreadStartParams", "ThreadResumeParams", "TurnStartParams"])
    await Bun.write(
      path.join(out, "v2", `${name}.json`),
      JSON.stringify({ properties: { approvalsReviewer: reviewer } }),
    )
  await Bun.write(
    path.join(out, "v2", "ThreadForkParams.json"),
    JSON.stringify({
      required: ["threadId"],
      properties: {
        threadId: { type: "string" },
        lastTurnId: { type: ["string", "null"] },
        excludeTurns: { type: "boolean" },
        ...(process.argv.includes("--legacy") ? {} : { deferGoalContinuation: { type: "boolean" } }),
        approvalsReviewer: reviewer,
      },
    }),
  )
  await Bun.write(
    path.join(out, "v2", "TurnSteerParams.json"),
    JSON.stringify({
      required: ["threadId", "input", "expectedTurnId"],
      properties: {
        threadId: { type: "string" },
        expectedTurnId: { type: "string" },
        clientUserMessageId: { type: "string" },
        input: { type: "array", items: { properties: { type: { const: "text" }, text: { type: "string" } } } },
      },
    }),
  )
  process.exit(0)
}

type Item = { id: string; type: string; [key: string]: unknown }
type Turn = { id: string; status: string; itemsView: string; startedAt: number; completedAt?: number; items: Item[] }
type Thread = {
  id: string
  createdAt: number
  updatedAt: number
  cwd: string
  status: { type: string }
  forkedFromId?: string
  turns: Turn[]
}
const root = process.cwd()
const file = path.join(root, "fork-history.json")
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const read = async () =>
  (await Bun.file(file)
    .json()
    .catch(() => ({}))) as Record<string, Thread>
const notify = (method: string, params: unknown) => write({ method, params })
async function save(thread: Thread) {
  await Bun.write(file, JSON.stringify({ ...(await read()), [thread.id]: thread }))
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> }
  if (request.id === undefined) continue
  appendFileSync(path.join(root, "fork-calls.jsonl"), JSON.stringify(request) + "\n")
  const params = request.params ?? {}
  const reply = (result: unknown) => write({ id: request.id, result })
  const error = (message: string) => write({ id: request.id, error: { code: -32602, message } })
  const behavior = await Bun.file(path.join(root, "behavior"))
    .text()
    .catch(() => "")
  if (request.method === "initialize") {
    reply({ userAgent: "codex-fork-fixture/0.164.0", codexHome: root })
    continue
  }
  if (request.method === "model/list") {
    reply({
      data: [
        {
          id: "fixture",
          displayName: "Fixture",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "low" }],
          inputModalities: ["text", "image"],
        },
      ],
      nextCursor: null,
    })
    continue
  }
  const history = await read()
  if (request.method === "thread/start") {
    const id = `thread-${Object.keys(history).length + 1}`
    const thread: Thread = {
      id,
      createdAt: Date.now() / 1000,
      updatedAt: Date.now() / 1000,
      cwd: root,
      status: { type: "idle" },
      turns: [],
    }
    await save(thread)
    reply({ thread, model: "fixture" })
    continue
  }
  if (request.method === "thread/loaded/list") {
    reply({ data: Object.keys(history), nextCursor: null })
    continue
  }
  const thread = history[String(params.threadId)]
  if (!thread) {
    error("Unknown thread")
    continue
  }
  if (request.method === "thread/goal/get") {
    reply({
      goal:
        behavior === "goal" || (behavior === "goal-fork" && thread.forkedFromId)
          ? { status: "active", threadId: thread.id }
          : null,
    })
    continue
  }
  if (["thread/read", "thread/resume"].includes(request.method)) {
    reply({ thread: behavior === "busy" ? { ...thread, status: { type: "active" } } : thread, model: "fixture" })
    continue
  }
  if (request.method === "thread/turns/list") {
    reply({ data: thread.turns, nextCursor: null })
    continue
  }
  if (request.method === "thread/items/list") {
    reply({
      data: thread.turns
        .filter((turn) => !params.turnId || turn.id === params.turnId)
        .flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item }))),
      nextCursor: null,
    })
    continue
  }
  if (request.method === "thread/fork") {
    if (behavior === "drop") process.exit(0)
    if (behavior === "reject") {
      error("Fixture rejected the fork")
      continue
    }
    const child: Thread = {
      ...thread,
      id: `thread-${Object.keys(history).length + 1}`,
      forkedFromId: thread.id,
      turns: thread.turns.slice(
        0,
        behavior === "extra"
          ? thread.turns.length
          : thread.turns.findIndex((turn) => turn.id === params.lastTurnId) + 1,
      ),
    }
    if (behavior === "missing") child.turns = child.turns.slice(1)
    if (behavior === "changed") {
      child.turns = structuredClone(child.turns)
      child.turns[0].items[1].text = "Changed native output with the same item identity"
    }
    await save(child)
    reply({ thread: child, model: "fixture" })
    continue
  }
  if (request.method === "turn/start") {
    const turn: Turn = {
      id: `${thread.id}-turn-${thread.turns.length + 1}`,
      status: "completed",
      itemsView: "full",
      startedAt: Date.now() / 1000,
      completedAt: Date.now() / 1000,
      items: [
        {
          id: `input-${params.clientUserMessageId}`,
          type: "userMessage",
          clientId: params.clientUserMessageId,
          content: params.input,
        },
        {
          id: `reply-${params.clientUserMessageId}`,
          type: "agentMessage",
          text: "Fixture response",
          phase: "final_answer",
        },
      ],
    }
    thread.turns.push(turn)
    thread.updatedAt = turn.completedAt!
    await save(thread)
    reply({ turn: { id: turn.id } })
    notify("turn/started", { threadId: thread.id, turn: { id: turn.id } })
    for (const item of turn.items) notify("item/completed", { threadId: thread.id, turnId: turn.id, item })
    notify("turn/completed", { threadId: thread.id, turn: { ...turn, error: null } })
    continue
  }
  error("Unsupported fixture method")
}
