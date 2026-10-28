import { createInterface } from "node:readline"
import { appendFileSync } from "node:fs"
import path from "node:path"

const root = process.argv[2]
const cfg = (await Bun.file(path.join(root, "scenario.json")).json()) as { mode: string; start?: string }
if (process.argv.includes("generate-json-schema")) {
  const out = process.argv[process.argv.indexOf("--out") + 1]
  const modes = { type: "string", enum: ["default", "plan"] }
  const docs = {
    "ClientRequest.json": {
      oneOf: ["turn/start", "turn/steer", "collaborationMode/list"].map((method) => ({
        properties: { method: { const: method } },
      })),
    },
    "v2/TurnSteerParams.json": {
      required: ["threadId", "input", "expectedTurnId"],
      properties: {
        threadId: { type: "string" },
        expectedTurnId: { type: "string" },
        clientUserMessageId: { type: ["string", "null"] },
        input: { type: "array", items: { properties: { type: { const: "text" }, text: { type: "string" } } } },
      },
    },
    "v2/TurnStartParams.json": {
      properties: {
        collaborationMode: {
          properties: {
            mode: modes,
            settings: {
              properties: {
                model: { type: "string" },
                reasoning_effort: { type: ["string", "null"] },
                developer_instructions: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
    "v2/CollaborationModeListResponse.json": {
      properties: { data: { type: "array", items: { properties: { name: { type: "string" }, mode: modes } } } },
    },
  }
  for (const [file, doc] of Object.entries(docs)) await Bun.write(path.join(out, file), JSON.stringify(doc))
  process.exit(0)
}
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const pending: { id: string | number; turn: unknown }[] = []
let count = 0
let turn = "turn"
function complete() {
  write({
    method: "item/completed",
    params: {
      threadId: "thread",
      turnId: turn,
      item: { id: "answer", type: "agentMessage", text: "Native answer", phase: "final_answer" },
    },
  })
  write({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: turn, status: "completed", items: [], error: null } },
  })
}
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line) as { id: string | number; method: string; params?: Record<string, unknown> }
  appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(value) + "\n")
  const params = value.params ?? {}
  const respond = (result: unknown) => write({ id: value.id, result })
  if (value.method === "initialized") continue
  if (value.method === "initialize") {
    respond({ userAgent: "codex-interaction-fixture/1.0.0" })
    continue
  }
  if (value.method === "model/list") {
    respond({
      data: [
        {
          id: "native-model",
          displayName: "Native model",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          defaultReasoningEffort: "high",
        },
      ],
      nextCursor: null,
    })
    continue
  }
  if (value.method === "collaborationMode/list") {
    respond({
      data: ["default", "plan"].map((mode) => ({ name: mode, mode, model: "preset-model", reasoning_effort: "high" })),
    })
    continue
  }
  if (["thread/start", "thread/read", "thread/resume"].includes(value.method)) {
    respond({ thread: { id: "thread", status: { type: "idle" }, turns: [] } })
    continue
  }
  if (value.method === "thread/loaded/list") {
    respond({ data: ["thread"], nextCursor: null })
    continue
  }
  if (value.method === "turn/start") {
    if (cfg.mode === "drop") process.exit(0)
    turn = `turn-${++count}`
    respond({ turn: { id: turn } })
    write({ method: "turn/started", params: { threadId: "thread", turn: { id: turn } } })
    if (cfg.start === "steer")
      write({
        method: "item/agentMessage/delta",
        params: { threadId: "thread", turnId: turn, itemId: "before", delta: "Partial answer before steering" },
      })
    if (cfg.start === "complete") complete()
    continue
  }
  if (value.method === "turn/steer") {
    if (cfg.mode === "reject") {
      write({ id: value.id, error: { code: -32602, message: "The expected turn ended" } })
      continue
    }
    if (cfg.mode === "exit") process.exit(0)
    if (cfg.mode === "hold") {
      pending.push({ id: value.id, turn: params.expectedTurnId })
      continue
    }
    if (cfg.start === "steer")
      write({
        method: "item/completed",
        params: {
          threadId: "thread",
          turnId: turn,
          item: { id: "steer", type: "userMessage", clientId: params.clientUserMessageId, content: params.input },
        },
      })
    respond({ turnId: cfg.mode === "wrong" ? "another-turn" : params.expectedTurnId })
    if (cfg.start === "steer") complete()
    continue
  }
  if (value.method === "release") {
    for (const value of pending.splice(0)) write({ id: value.id, result: { turnId: value.turn } })
    respond({})
    continue
  }
  if (value.method === "count") {
    respond(pending.length)
    continue
  }
  respond({})
}
