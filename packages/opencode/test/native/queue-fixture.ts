import readline from "node:readline"
import path from "node:path"

if (process.argv.includes("generate-json-schema")) process.exit(1)
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const line = readline.createInterface({ input: process.stdin })
let count = 0
for await (const text of line) {
  const request = JSON.parse(text)
  if (request.id === undefined) continue
  await Bun.write(path.join(process.cwd(), `call-${request.id}.json`), JSON.stringify(request))
  const reply = (result: unknown) => send({ id: request.id, result })
  if (request.method === "initialize") {
    reply({ userAgent: "codex/0.164.0", codexHome: process.cwd() })
    continue
  }
  if (request.method === "model/list") {
    reply({
      data: [{ id: "fixture", displayName: "Fixture", isDefault: true, supportedReasoningEfforts: [] }],
      nextCursor: null,
    })
    continue
  }
  if (request.method === "thread/loaded/list") {
    reply({ data: ["queue-thread"], nextCursor: null })
    continue
  }
  if (request.method === "thread/start" || request.method === "thread/resume" || request.method === "thread/read") {
    reply({ thread: { id: "queue-thread", status: { type: "idle" } }, model: "fixture" })
    continue
  }
  if (request.method === "turn/start") {
    const id = `turn-${++count}`
    const input = request.params.input.map((part: { text?: string }) => part.text ?? "").join("\n")
    await Bun.write(path.join(process.cwd(), `turn-${count}.json`), JSON.stringify({ input, params: request.params }))
    reply({ turn: { id } })
    send({ method: "turn/started", params: { threadId: "queue-thread", turn: { id } } })
    void (async () => {
      if (input === "wait") {
        for (
          let attempt = 0;
          attempt < 2_000 && !(await Bun.file(path.join(process.cwd(), "release")).exists());
          attempt++
        )
          await Bun.sleep(10)
      }
      send({
        method: "item/completed",
        params: {
          threadId: "queue-thread",
          turnId: id,
          item: { id: `answer-${id}`, type: "agentMessage", text: input },
        },
      })
      send({
        method: "turn/completed",
        params: {
          threadId: "queue-thread",
          turn: { id, status: input === "fail" ? "failed" : "completed", items: [] },
        },
      })
    })()
    continue
  }
  if (request.method === "turn/interrupt") {
    reply({})
    send({
      method: "turn/completed",
      params: { threadId: "queue-thread", turn: { id: request.params.turnId, status: "interrupted", items: [] } },
    })
    continue
  }
  send({ id: request.id, error: { code: -32601, message: "Unsupported fixture method" } })
}
