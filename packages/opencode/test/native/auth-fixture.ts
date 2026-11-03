import { createInterface } from "node:readline"
import { appendFile } from "node:fs/promises"
import path from "node:path"

const cfg = await Bun.file(path.join(process.cwd(), "auth.json")).json()
const input = createInterface({ input: process.stdin })
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const complete = (success: boolean, login = "login") =>
  send({ method: "account/login/completed", params: { loginId: login, success, error: "fixture-private-secret" } })

for await (const line of input) {
  const message = JSON.parse(line)
  await appendFile(path.join(process.cwd(), "calls.jsonl"), JSON.stringify(message) + "\n")
  if (message.method === "initialize") {
    setTimeout(() => send({ id: message.id, result: { userAgent: "codex/0.164.0-test" } }), cfg.initDelay ?? 0)
    continue
  }
  if (message.method === "initialized") continue
  if (message.method === "account/login/start") {
    if (cfg.error) {
      send({ id: message.id, error: { code: -32601, message: "fixture-private-secret" } })
      continue
    }
    if (cfg.early) complete(true)
    setTimeout(() => {
      send({
        id: message.id,
        result:
          message.params.type === "chatgpt"
            ? {
                type: "chatgpt",
                loginId: "login",
                authUrl: cfg.url ?? "https://auth.openai.com/authorize?state=fixture",
              }
            : {
                type: "chatgptDeviceCode",
                loginId: "login",
                verificationUrl: cfg.url ?? "https://auth.openai.com/codex/device",
                userCode: "FIXT-URE",
              },
      })
    }, cfg.delay ?? 0)
    continue
  }
  if (message.method === "account/login/cancel") {
    send({ id: message.id, result: { status: "canceled" } })
    complete(false)
    continue
  }
  if (message.method === "test/complete") {
    send({ id: message.id, result: true })
    complete(message.params.success, message.params.login)
    continue
  }
  if (message.method === "test/exit") process.exit(9)
  send({ id: message.id, error: { code: -32601, message: "Unsupported fixture operation" } })
}
