import { createInterface } from "node:readline"
import path from "node:path"

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id?: number; method: string; params?: { threadId?: string } }
  if (request.id === undefined) continue
  const mode = await Bun.file(path.join(process.cwd(), "ownership-mode"))
    .text()
    .catch(() => "idle")
  const reply = (result: unknown) => process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n")
  if (request.method === "initialize") {
    reply({ userAgent: "ownership-fixture/0.164.0", codexHome: process.cwd() })
    continue
  }
  if (request.method === "thread/loaded/list") {
    reply({ data: mode === "cursor" ? [] : ["thread", "child"], nextCursor: mode === "cursor" ? "repeated" : null })
    continue
  }
  if (request.method === "thread/goal/get") {
    reply({ goal: mode === "goal" ? { status: "active" } : null })
    continue
  }
  if (request.method === "thread/read") {
    reply({
      thread: {
        id: request.params?.threadId,
        status: { type: mode === "child" && request.params?.threadId === "child" ? "active" : "idle" },
      },
    })
    continue
  }
  process.stdout.write(
    JSON.stringify({ id: request.id, error: { code: -32601, message: "Unsupported method" } }) + "\n",
  )
}
