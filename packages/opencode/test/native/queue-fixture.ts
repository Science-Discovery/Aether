import readline from "node:readline"
import path from "node:path"

if (process.argv.includes("generate-json-schema")) {
  const out = process.argv[process.argv.indexOf("--out") + 1]
  await Bun.write(
    path.join(out, "ClientRequest.json"),
    JSON.stringify({
      oneOf: ["turn/steer", "turn/start"].map((method) => ({ properties: { method: { const: method } } })),
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
      data: [
        {
          id: "fixture",
          displayName: "Fixture",
          isDefault: true,
          supportedReasoningEfforts: [],
          inputModalities: (await Bun.file(path.join(process.cwd(), "text-only")).exists())
            ? ["text"]
            : ["text", "image"],
        },
      ],
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
  if (request.method === "turn/steer") {
    const input = request.params.input.map((part: { text?: string }) => part.text ?? "").join("\n")
    await Bun.write(
      path.join(process.cwd(), `steer-${request.params.clientUserMessageId}.json`),
      JSON.stringify(request.params),
    )
    if (input === "reject") {
      send({ id: request.id, error: { code: -32602, message: "The expected turn ended" } })
      continue
    }
    if (input === "disconnect") process.exit(0)
    void (async () => {
      if (input === "hold-steer") {
        for (
          let attempt = 0;
          attempt < 2_000 && !(await Bun.file(path.join(process.cwd(), "steer-release")).exists());
          attempt++
        )
          await Bun.sleep(10)
      }
      reply({ turnId: request.params.expectedTurnId })
    })()
    continue
  }
  send({ id: request.id, error: { code: -32601, message: "Unsupported fixture method" } })
}
