import readline from "node:readline"
import path from "node:path"
import { appendFileSync } from "node:fs"

type Thread = {
  id: string
  name: string
  turns: unknown[]
  [key: string]: unknown
}
const root = process.cwd()
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> }
  if (request.id === undefined) continue
  appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(request) + "\n")
  const params = request.params ?? {}
  const reply = (result: unknown) => write({ id: request.id, result })
  if (request.method === "initialize") {
    reply({
      userAgent: "codex-chats-fixture/0.164.0",
      codexHome: await Bun.file(path.join(root, "home"))
        .text()
        .catch(() => root),
    })
    continue
  }
  const threads = (await Bun.file(path.join(root, "chats.json")).json()) as Record<string, Thread>
  if (request.method === "thread/list") {
    const data = Object.values(threads).filter(
      (thread) => !params.searchTerm || thread.name.includes(String(params.searchTerm)),
    )
    const offset = Number(params.cursor ?? 0)
    reply({ data: data.slice(offset, offset + 2), nextCursor: offset + 2 < data.length ? String(offset + 2) : null })
    continue
  }
  const thread = threads[String(params.threadId)]
  if (!thread) {
    write({ id: request.id, error: { code: -32602, message: "Thread does not exist" } })
    continue
  }
  if (request.method === "thread/read") reply({ thread: { ...thread, turns: [] } })
  else if (request.method === "thread/turns/list") reply({ data: thread.turns, nextCursor: null })
  else if (request.method === "thread/goal/get") reply({ goal: thread.goal ?? null })
  else write({ id: request.id, error: { code: -32601, message: `Forbidden fixture method ${request.method}` } })
}
