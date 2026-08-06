import { describe, expect, test } from "bun:test"
import { isLocalServerKey, serverScopedKey, serverSessionKey } from "./server-scope"

describe("server scope helpers", () => {
  test("keeps unscoped keys unchanged without a server", () => {
    expect(serverScopedKey("/repo", undefined)).toBe("/repo")
    expect(serverSessionKey("ZGly", "ses_1", undefined)).toBe("ZGly/ses_1")
  })

  test("treats local backends as unscoped storage", () => {
    expect(isLocalServerKey(undefined)).toBe(true)
    expect(isLocalServerKey("sidecar")).toBe(true)
    expect(isLocalServerKey("http://localhost:4096")).toBe(true)
    expect(isLocalServerKey("http://127.0.0.1:4096")).toBe(true)
    expect(serverScopedKey("/repo", "http://localhost:4096")).toBe("/repo")
    expect(serverSessionKey("ZGly", "ses_1", "http://127.0.0.1:4096")).toBe("ZGly/ses_1")
  })

  test("scopes generic storage keys by server", () => {
    const a = serverScopedKey("/repo", "http://one.example")
    const b = serverScopedKey("/repo", "http://two.example")

    expect(a).not.toBe(b)
    expect(a).toStartWith("/repo\nserver:")
  })

  test("keeps session key directory in the first slash segment", () => {
    const key = serverSessionKey("ZGly", "ses_1", "http://one.example")

    expect(key.split("/")[0]).toBe("ZGly")
    expect(key.split("/")[1]).toBe("ses_1")
    expect(key).toContain("//server:")
  })
})
