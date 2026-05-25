import { describe, expect, test } from "bun:test"
import { bootstrapSsh } from "./remote-ssh"

describe("bootstrapSsh", () => {
  test("sends ssh password in bootstrap payload", async () => {
    let body = ""
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body ?? "")
      return new Response(
        JSON.stringify({
          savedHostID: "saved-1",
          runtimeID: "run-1",
          endpoint: { url: "http://127.0.0.1:14096" },
          version: { chosen: "1.0.0", source: "exact" },
          landing: {
            rootDirectory: "/tmp/root",
            directory: "/tmp/root",
            sessionID: null,
            workspaceID: null,
          },
          logs: [],
          reused: false,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }) as unknown as typeof globalThis.fetch
    const prev = globalThis.fetch
    globalThis.fetch = fetch

    await bootstrapSsh(
      { url: "http://localhost:4096" },
      {
        savedHostID: "saved-1",
        host: "box",
        command: "ssh user@box",
        installDir: "~/.aether/bin",
        password: "secret",
      },
    ).finally(() => {
      globalThis.fetch = prev
    })

    expect(JSON.parse(body)).toMatchObject({
      savedHostID: "saved-1",
      host: "box",
      command: "ssh user@box",
      installDir: "~/.aether/bin",
      password: "secret",
    })
  })
})
