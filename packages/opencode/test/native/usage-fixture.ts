import { createInterface } from "node:readline"
import { appendFile } from "node:fs/promises"

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { id?: number; method?: string }
  await appendFile("calls.jsonl", JSON.stringify({ method: message.method }) + "\n")
  if (message.id === undefined) continue
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "codex_cli_rs/0.0.0-fixture" } }) + "\n")
    continue
  }
  const result = await Bun.file("response.json").json()
  process.stdout.write(JSON.stringify({ id: message.id, ...result }) + "\n")
}
