import readline from "node:readline"
import path from "node:path"
import { appendFileSync } from "node:fs"

if (process.argv.includes("generate-json-schema")) {
  const out = process.argv[process.argv.indexOf("--out") + 1]
  await Bun.write(
    path.join(out, "ClientRequest.json"),
    JSON.stringify({
      oneOf: ["turn/start", "turn/steer"].map((method) => ({ properties: { method: { const: method } } })),
    }),
  )
  await Bun.write(
    path.join(out, "v2/TurnSteerParams.json"),
    JSON.stringify({
      required: ["threadId", "expectedTurnId", "input"],
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
const root = process.cwd()
const file = path.join(root, "history.json")
const prior = (await Bun.file(file)
  .json()
  .catch(() => undefined)) as
  | { thread: { id: string; createdAt: number; updatedAt: number; status: { type: string } }; turns: Turn[] }
  | undefined
const history = prior ?? {
  thread: {
    id: "answers-thread",
    createdAt: Date.now() / 1000,
    updatedAt: Date.now() / 1000,
    status: { type: "idle" },
  },
  turns: [],
}
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const save = () => Bun.write(file, JSON.stringify(history))
const notify = (method: string, params: Record<string, unknown>) =>
  write({ method, params: { threadId: history.thread.id, ...params } })
async function item(turn: Turn, value: Item) {
  turn.items.push(value)
  await save()
  notify("item/completed", { turnId: turn.id, item: value })
}
async function complete(turn: Turn, status = "completed") {
  if (turn.status !== "inProgress") return
  turn.status = status
  turn.completedAt = Date.now() / 1000
  history.thread.updatedAt = turn.completedAt
  history.thread.status.type = "idle"
  await save()
  notify("turn/completed", { turn: { ...turn, error: null } })
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> }
  if (request.id === undefined) continue
  appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(request) + "\n")
  const params = request.params ?? {}
  const reply = (result: unknown) => write({ id: request.id, result })
  if (request.method === "initialize") {
    reply({ userAgent: "codex-answers-fixture/0.164.0", codexHome: root })
    continue
  }
  if (request.method === "model/list") {
    reply({
      data: [{ id: "fixture", displayName: "Fixture", isDefault: true, supportedReasoningEfforts: [] }],
      nextCursor: null,
    })
    continue
  }
  if (["thread/start", "thread/read", "thread/resume"].includes(request.method)) {
    reply({ thread: { ...history.thread, turns: history.turns } })
    continue
  }
  if (request.method === "thread/loaded/list") {
    reply({ data: [history.thread.id], nextCursor: null })
    continue
  }
  if (request.method === "thread/turns/list") {
    reply({ data: history.turns, nextCursor: null })
    continue
  }
  if (request.method === "thread/items/list") {
    reply({
      data: history.turns
        .filter((turn) => !params.turnId || params.turnId === turn.id)
        .flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item }))),
      nextCursor: null,
    })
    continue
  }
  if (request.method === "turn/interrupt") {
    reply({})
    const turn = history.turns.find((turn) => turn.id === params.turnId)
    if (turn) await complete(turn, "interrupted")
    continue
  }
  if (request.method !== "turn/start" && request.method !== "turn/steer") {
    write({ id: request.id, error: { code: -32601, message: "Unsupported fixture method" } })
    continue
  }
  const input = (params.input as { type: string; text?: string }[]).map((part) => part.text ?? "").join("\n")
  const answer = input.startsWith("<send_user_message_question_reply>")
  const behavior = await Bun.file(path.join(root, "behavior"))
    .text()
    .catch(() => "accept")
  if (answer && behavior === "drop") process.exit(0)
  if (request.method === "turn/steer") {
    const turn = history.turns.find((turn) => turn.id === params.expectedTurnId && turn.status === "inProgress")
    if (!turn) {
      write({ id: request.id, error: { code: -32602, message: "Expected turn is inactive" } })
      continue
    }
    await item(turn, {
      id: `input-${params.clientUserMessageId}`,
      type: "userMessage",
      clientId: params.clientUserMessageId,
      content: params.input,
    })
    reply({ turnId: turn.id })
    continue
  }
  const turn: Turn = {
    id: `turn-${history.turns.length + 1}`,
    status: "inProgress",
    itemsView: "full",
    startedAt: Date.now() / 1000,
    items: [],
  }
  history.turns.push(turn)
  history.thread.status.type = "active"
  await save()
  reply({ turn: { id: turn.id } })
  notify("turn/started", { turn: { id: turn.id } })
  await item(turn, {
    id: `input-${params.clientUserMessageId}`,
    type: "userMessage",
    clientId: params.clientUserMessageId,
    content: params.input,
  })
  if (input.startsWith("ask")) {
    const questions =
      input === "ask-four"
        ? Array.from({ length: 4 }, (_, index) => ({ title: `Question ${index}`, options: null }))
        : [
            { title: "Choose a style", options: ["Brief", "Detailed"] },
            { title: "Any notes?", options: null },
          ]
    await item(turn, {
      id: `question-${turn.id}`,
      type: "agentMessage",
      delivery: "async",
      phase: "final_answer",
      text: "Please choose a style and provide any notes.",
      questions,
    })
  } else
    await item(turn, { id: `answer-${turn.id}`, type: "agentMessage", phase: "final_answer", text: "Answer received." })
  if (input === "ask-active") {
    void (async () => {
      for (
        let attempt = 0;
        attempt < 2_000 && turn.status === "inProgress" && !(await Bun.file(path.join(root, "release")).exists());
        attempt++
      )
        await Bun.sleep(10)
      await complete(turn)
    })()
    continue
  }
  await complete(turn)
}
