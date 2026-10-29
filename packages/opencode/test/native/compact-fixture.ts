import readline from "node:readline"
import path from "node:path"
import { appendFileSync } from "node:fs"

const root = process.cwd()
const file = path.join(root, "compact-history.json")
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const notify = (method: string, params: unknown) => write({ method, params })
type Turn = {
  id: string
  status: string
  itemsView: string
  items: { id: string; type: string; [key: string]: unknown }[]
}
type Thread = { id: string; createdAt: number; updatedAt: number; status: { type: string }; turns: Turn[] }

for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> }
  if (request.id === undefined) continue
  appendFileSync(path.join(root, "compact-calls.jsonl"), JSON.stringify(request) + "\n")
  const reply = (result: unknown) => write({ id: request.id, result })
  const params = request.params ?? {}
  if (request.method === "initialize") {
    reply({ userAgent: "codex/0.164.0", codexHome: path.join(root, "codex-home") })
    continue
  }
  const thread = (await Bun.file(file).json()) as Thread
  if (request.method === "thread/read" || request.method === "thread/resume") {
    reply({ thread: { ...thread, status: { type: "idle" }, turns: [] } })
    continue
  }
  if (request.method === "thread/turns/list") {
    reply({ data: thread.turns, nextCursor: null })
    continue
  }
  if (request.method === "thread/items/list") {
    reply({ data: thread.turns.find((turn) => turn.id === params.turnId)?.items ?? [], nextCursor: null })
    continue
  }
  if (request.method === "thread/goal/get") {
    reply({ goal: null })
    continue
  }
  if (request.method === "thread/compact/start") {
    const behavior = await Bun.file(path.join(root, "behavior"))
      .text()
      .catch(() => "")
    if (behavior === "unsupported") {
      write({ id: request.id, error: { code: -32601, message: "Method not found" } })
      continue
    }
    if (behavior === "disconnect") process.exit(0)
    if (behavior === "ack-disconnect") {
      reply({})
      process.exit(0)
    }
    const turn: Turn = {
      id: `compact-${thread.turns.length}`,
      status: "completed",
      itemsView: "full",
      items: [{ id: `item-${thread.turns.length}`, type: "contextCompaction" }],
    }
    if (behavior === "lost") {
      await Bun.write(
        file,
        JSON.stringify({ ...thread, updatedAt: thread.updatedAt + 1, turns: [...thread.turns, turn] }),
      )
      process.exit(0)
    }
    reply({})
    notify("turn/started", { threadId: thread.id, turn: { ...turn, status: "inProgress" } })
    if (behavior === "delayed") {
      for (let count = 0; count < 200; count++) {
        if (await Bun.file(path.join(root, "continue")).exists()) break
        await Bun.sleep(20)
      }
    }
    notify("item/completed", { threadId: thread.id, turnId: turn.id, item: turn.items[0] })
    await Bun.write(
      file,
      JSON.stringify({ ...thread, updatedAt: thread.updatedAt + 1, turns: [...thread.turns, turn] }),
    )
    notify("thread/tokenUsage/updated", {
      threadId: thread.id,
      tokenUsage: { last: { inputTokens: 100, totalTokens: 110 }, modelContextWindow: 10000 },
    })
    notify("turn/completed", { threadId: thread.id, turn })
    continue
  }
  write({ id: request.id, error: { code: -32601, message: `Unsupported method: ${request.method}` } })
}
