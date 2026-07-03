import { describe, expect, test } from "bun:test"
import { serverScopedKey, serverSessionKey } from "./server-scope"

describe("server scope helpers", () => {
  test("keeps unscoped keys unchanged without a server", () => {
    expect(serverScopedKey("/repo", undefined)).toBe("/repo")
    expect(serverSessionKey("ZGly", "ses_1", undefined)).toBe("ZGly/ses_1")
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
