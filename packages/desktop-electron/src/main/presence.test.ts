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
      clients: { desktop: 1, web: 0 },
    }
    expect(parse(sibling)).toEqual(sibling)
    expect(parse(null)).toBeNull()
    expect(parse({ pid: 1, channel: "prod" })).toBeNull()
    expect(parse({ pid: 1, channel: 2, clients: { desktop: 0, web: 1 } })).toBeNull()
    expect(parse({ pid: 1, channel: "prod", clients: { desktop: "0", web: 1 } })).toBeNull()
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

  test("conflict keeps only same-channel servers, deduped by pid", async () => {
    presence = await import("./presence")
    const { conflict, channelSlug, detail } = presence

    const desktopServer = {
      pid: 4242,
      channel: "prod",
      clients: { desktop: 1, web: 0 },
    }
    const webServer = {
      pid: 4243,
      channel: "prod",
      clients: { desktop: 0, web: 2 },
    }
    const idle = { pid: 4244, channel: "prod", clients: { desktop: 0, web: 0 } }
    const foreign = { pid: 4245, channel: "local", clients: { desktop: 0, web: 1 } }

    const root = mkdtempSync(join(tmpdir(), "aether-presence-"))
    try {
      mkdirSync(join(root, "prod"), { recursive: true })
      writeFileSync(join(root, "prod", "serve-port"), "20911")
      writeFileSync(join(root, "serve-port"), "20912")
      mkdirSync(join(root, "local"), { recursive: true })
      writeFileSync(join(root, "local", "serve-port"), "20913")

      const impl = (port: number) => {
        if (port === 20911) return Promise.resolve(desktopServer)
        if (port === 20912) return Promise.resolve(webServer)
        if (port === 20913) return Promise.resolve(foreign)
        return Promise.resolve(idle)
      }

      const found = await conflict({ root, channel: "prod", probe: impl })
      expect(found).toHaveLength(3)
      expect(detail(found, "prod")).toBe(
        'the web version (browser) and another desktop app is already using the "prod" channel. Only one app can use a channel at a time.',
      )
      expect(detail([webServer], "prod")).toBe(
        'the web version (browser) is already using the "prod" channel. Only one app can use a channel at a time.',
      )
      expect(detail([desktopServer], "prod")).toBe(
        'another desktop app is already using the "prod" channel. Only one app can use a channel at a time.',
      )
      expect(detail([idle], "prod")).toBe(
        'another Aether server is already using the "prod" channel. Only one app can use a channel at a time.',
      )
      expect(channelSlug("beta")).toBe("latest")
      expect(channelSlug("prod")).toBe("prod")
      expect(channelSlug("dev")).toBe("dev")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
