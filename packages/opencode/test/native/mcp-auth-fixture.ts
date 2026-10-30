import { createInterface } from "node:readline"
import { appendFile } from "node:fs/promises"
import path from "node:path"

const cfg = (await Bun.file(path.join(process.cwd(), "mcp.json")).json()) as {
  early?: boolean
  legacy?: boolean
  delay?: number
  initDelay?: number
  url?: string
  auth?: string
  error?: boolean
  duplicate?: boolean
}
const input = createInterface({ input: process.stdin })
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
const complete = (params: { success: boolean; login?: string; name?: string; thread?: string }) =>
  send({
    method: "mcpServer/oauthLogin/completed",
    params: {
      name: params.name ?? "papers",
      success: params.success,
      loginId: cfg.legacy ? undefined : (params.login ?? "login"),
      threadId: params.thread,
      error: "fixture-private-secret",
    },
  })

for await (const line of input) {
  const message = JSON.parse(line) as {
    id: number
    method: string
    params: { success: boolean; login?: string; name?: string; thread?: string }
  }
  await appendFile(path.join(process.cwd(), "calls.jsonl"), JSON.stringify(message) + "\n")
  if (message.method === "initialize") {
    setTimeout(
      () => send({ id: message.id, result: { userAgent: "codex/0.164.0-test", codexHome: "fixture-home" } }),
      cfg.initDelay ?? 0,
    )
    continue
  }
  if (message.method === "initialized") continue
  if (message.method === "mcpServerStatus/list") {
    send({
      id: message.id,
      result: { data: [{ name: "papers", authStatus: cfg.auth ?? "notLoggedIn", tools: {} }], nextCursor: null },
    })
    continue
  }
  if (message.method === "mcpServer/oauth/login") {
    if (cfg.error) {
      send({ id: message.id, error: { code: -32601, message: "fixture-private-secret" } })
      continue
    }
    if (cfg.early) complete({ success: true })
    setTimeout(
      () =>
        send({
          id: message.id,
          result: {
            authorizationUrl: cfg.url ?? "https://example.com/oauth/authorize?state=fixture",
            loginId: cfg.legacy ? undefined : "login",
          },
        }),
      cfg.delay ?? 0,
    )
    continue
  }
  if (message.method === "test/complete") {
    send({ id: message.id, result: true })
    complete(message.params)
    if (cfg.duplicate) complete(message.params)
    continue
  }
  if (message.method === "test/exit") process.exit(9)
  send({ id: message.id, error: { code: -32601, message: "Unsupported fixture operation" } })
}
