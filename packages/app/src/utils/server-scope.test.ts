import { describe, expect, test } from "bun:test"
import { isLocalServerKey, serverHash } from "./server-scope"

describe("isLocalServerKey", () => {
  test("treats missing and sidecar keys as local", () => {
    expect(isLocalServerKey(undefined)).toBe(true)
    expect(isLocalServerKey("sidecar")).toBe(true)
  })

  test("treats loopback urls as local", () => {
    expect(isLocalServerKey("http://localhost:4096")).toBe(true)
    expect(isLocalServerKey("http://127.0.0.1:4096")).toBe(true)
  })

  test("treats remote urls and tunnels as non-local", () => {
    expect(isLocalServerKey("http://one.example")).toBe(false)
    expect(isLocalServerKey("https://gpu.lab.dev:4096")).toBe(false)
    expect(isLocalServerKey("ssh:box")).toBe(false)
  })
})

describe("serverHash", () => {
  test("keeps local keys unscoped", () => {
    expect(serverHash(undefined)).toBeUndefined()
    expect(serverHash("sidecar")).toBeUndefined()
    expect(serverHash("http://localhost:4096")).toBeUndefined()
  })

  test("returns a stable hash for remote keys", () => {
    const first = serverHash("http://one.example")
    const second = serverHash("http://one.example")
    expect(first).toBeTruthy()
    expect(first).toBe(second)
    expect(serverHash("http://two.example")).not.toBe(first)
  })
})
