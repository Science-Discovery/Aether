import { createInterface } from "node:readline"
import { spawn } from "node:child_process"

if (process.argv[2] === "leaf") {
  setInterval(() => undefined, 1_000)
  await new Promise(() => undefined)
}

const input = createInterface({ input: process.stdin })
const approvals = new Map<string | number, number>()
let initialized = false
let initializes = 0

function send(value: unknown) {
  process.stdout.write(JSON.stringify(value) + "\n")
}

for await (const line of input) {
  const message = JSON.parse(line)
  if (!message.method) {
    const id = approvals.get(message.id)
    if (id !== undefined) send({ id, result: message.result ?? message.error })
    continue
  }
  if (message.method === "initialize") {
    initializes++
    send({ id: message.id, result: { userAgent: "codex_cli_rs/0.164.0-test" } })
    continue
  }
  if (message.method === "info") {
    send({ id: message.id, result: { pid: process.pid, initializes } })
    continue
  }
  if (message.method === "notify") {
    send(message.params)
    send({ id: message.id, result: true })
    continue
  }
  if (message.method === "initialized") {
    initialized = true
    continue
  }
  if (message.method === "model/list") {
    if (!initialized) {
      send({ id: message.id, error: { code: -32000, message: "Not initialized" } })
      continue
    }
    const next = message.params?.cursor === "next"
    send({
      id: message.id,
      result: {
        data: [
          {
            id: next ? "alias-2" : "alias-1",
            model: next ? "model-2" : "model-1",
            displayName: next ? "Second" : "First",
            isDefault: !next,
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            defaultReasoningEffort: "high",
            inputModalities: next ? ["text"] : ["text", "image"],
          },
        ],
        nextCursor: next ? null : "next",
      },
    })
    continue
  }
  if (message.method === "echo") {
    setTimeout(() => send({ id: message.id, result: message.params?.value }), message.params?.delay ?? 0)
    continue
  }
  if (message.method === "split") {
    const bytes = Buffer.from(JSON.stringify({ id: message.id, result: "中文🙂" }) + "\n")
    const index = bytes.indexOf(Buffer.from("中")) + 1
    process.stdout.write(bytes.subarray(0, index))
    setTimeout(() => process.stdout.write(bytes.subarray(index)), 5)
    continue
  }
  if (message.method === "ask") {
    approvals.set("approval", message.id)
    send({ id: "approval", method: "item/commandExecution/requestApproval", params: { command: "test" } })
    send({ method: "notice", params: { value: "during approval" } })
    continue
  }
  if (message.method === "withdraw") {
    send({ id: "withdrawn", method: "approval", params: { threadId: "thread", name: "withdrawn" } })
    send({ id: "remaining", method: "approval", params: { threadId: "thread", name: "remaining" } })
    send({ id: message.id, result: true })
    continue
  }
  if (message.method === "resolve-first") {
    send({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: "withdrawn" } })
    send({ id: message.id, result: true })
    continue
  }
  if (message.method === "notifications") {
    send({ method: "notice", params: 1 })
    send({ method: "notice", params: 2 })
    send({ id: message.id, result: true })
    continue
  }
  if (message.method === "final") {
    send({ method: "notice", params: "final" })
    process.exit(0)
  }
  if (message.method === "exit") process.exit(9)
  if (message.method === "invalid") {
    process.stdout.write("private-token-do-not-display\n")
    continue
  }
  if (message.method === "oversize") {
    process.stdout.write("x".repeat(8 * 1024 * 1024 + 1))
    continue
  }
  if (message.method === "descendant") {
    const child = spawn(process.execPath, [import.meta.filename, "leaf"], { stdio: "ignore", windowsHide: true })
    send({ id: message.id, result: child.pid })
    continue
  }
  if (message.method === "wait") continue
  send({ id: message.id, error: { code: -32601, message: "Unknown method" } })
}
