import { describe, expect, test } from "bun:test"
import { ServerConnection, serverName } from "./server"

describe("ServerConnection ssh identity", () => {
  test("keys ssh connections by immutable id", () => {
    const conn: ServerConnection.Ssh = {
      type: "ssh",
      id: "host-1",
      host: "user@example.com",
      command: "ssh user@example.com",
      installDir: "~/.opencode/bin",
      http: { url: "http://127.0.0.1:43001" },
    }

    expect(ServerConnection.key(conn)).toBe(ServerConnection.Key.make("ssh:host-1"))
  })

  test("shows host for ssh entries without displayName", () => {
    const conn: ServerConnection.Ssh = {
      type: "ssh",
      id: "host-1",
      host: "user@example.com",
      command: "ssh user@example.com",
      installDir: "~/.opencode/bin",
      http: { url: "" },
    }

    expect(serverName(conn)).toBe("user@example.com")
  })
})
