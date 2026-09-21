import { describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const app = {
  isPackaged: false,
  getPath: () => tmpdir(),
  getVersion: () => "0.0.0",
  setAppLogsPath: () => undefined,
  setName: () => undefined,
  setPath: () => undefined,
}

mock.module("electron", () => ({
  default: { app },
  app,
}))

type Presence = typeof import("./presence")

let presence: Presence

describe("desktop presence scan", () => {
  test("parse accepts valid and rejects malformed payloads", async () => {
    presence = await import("./presence")
    const { parse } = presence

    const sibling = {
      pid: 4242,
      channel: "prod",
      kind: "desktop" as const,
      clients: { desktop: 1, web: 0 },
    }
    expect(parse(sibling)).toEqual(sibling)
    expect(parse(null)).toBeNull()
    expect(parse({ pid: 1, channel: "prod", kind: "web" })).toBeNull()
    expect(parse({ pid: 1, channel: 2, kind: "web", clients: { desktop: 0, web: 1 } })).toBeNull()
  })

  test("ports includes the base range and serve-port files", async () => {
    presence = await import("./presence")
    const { ports } = presence

    const root = mkdtempSync(join(tmpdir(), "aether-presence-"))
    try {
      mkdirSync(join(root, "prod"), { recursive: true })
      writeFileSync(join(root, "prod", "serve-port"), "20901")
      writeFileSync(join(root, "serve-port"), "not-a-port")
      const found = ports(root)
      expect(found).toContain(19527)
      expect(found).toContain(19531)
      expect(found).toContain(20901)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("conflict aggregates probed siblings, deduped by pid", async () => {
    presence = await import("./presence")
    const { conflict, detail } = presence

    const sibling = {
      pid: 4242,
      channel: "prod",
      kind: "desktop" as const,
      clients: { desktop: 1, web: 0 },
    }
    const other = {
      pid: 4243,
      channel: "local",
      kind: "web" as const,
      clients: { desktop: 0, web: 2 },
    }

    const root = mkdtempSync(join(tmpdir(), "aether-presence-"))
    try {
      mkdirSync(join(root, "local"), { recursive: true })
      writeFileSync(join(root, "local", "serve-port"), "20911")
      writeFileSync(join(root, "serve-port"), "20912")
      mkdirSync(join(root, "beta"), { recursive: true })
      writeFileSync(join(root, "beta", "serve-port"), "20913")

      const impl = (port: number) => {
        if (port === 20911) return Promise.resolve(sibling)
        if (port === 20912) return Promise.resolve({ ...sibling, pid: 4242, channel: "dup" })
        if (port === 20913) return Promise.resolve(other)
        return Promise.resolve(null)
      }

      const found = await conflict({ root, probe: impl })
      expect(found).toHaveLength(2)
      expect(detail(found)).toBe(
        "the web version (browser) and another desktop app currently connected. Only one app can be connected at a time.",
      )
      expect(detail([other])).toBe(
        "the web version (browser) currently connected. Only one app can be connected at a time.",
      )
      expect(detail([sibling])).toBe(
        "another desktop app currently connected. Only one app can be connected at a time.",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
